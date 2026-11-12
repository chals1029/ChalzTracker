//! Provider authentication primitives and live quota retrieval.
//!
//! Callers own persistence and must treat the supplied account and its credentials as
//! secrets. These functions do not log requests, credentials, or provider responses.
use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;
const WEEK_MS: i64 = 7 * DAY_MS;
const MONTH_MS: i64 = 30 * DAY_MS;

/// Creates a client with the same per-request timeout as the original provider code.
pub fn provider_client() -> Result<Client, String> {
    Client::builder().timeout(Duration::from_secs(20)).build()
        .map_err(|_| "Unable to initialize provider HTTP client.".to_owned())
}

fn now_ms() -> i64 { Utc::now().timestamp_millis() }

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok().filter(|n| n.is_finite()),
        _ => None,
    }
}

fn numeric(value: &Value) -> Option<f64> { value.as_f64().filter(|n| n.is_finite()) }

fn iso_millis(ms: i64) -> Value {
    if ms <= 0 { return Value::Null; }
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|d| Value::String(d.to_rfc3339_opts(SecondsFormat::Millis, true)))
        .unwrap_or(Value::Null)
}

fn iso(value: &Value) -> Value {
    if let Some(n) = number(value) {
        let ms = if n < 1e11 { n * 1000.0 } else { n };
        return iso_millis(ms as i64);
    }
    value.as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
        .or_else(|| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(0, 0, 0)).map(|d| d.and_utc().timestamp_millis())))
        .map(iso_millis).unwrap_or(Value::Null)
}

fn limit(id: String, label: String, window: String, duration: Value, used: f64, reset: Value) -> Value {
    json!({"id": id, "label": label, "windowId": window, "durationMs": duration,
        "usedFraction": used.clamp(0.0, 1.0), "resetsAt": reset})
}

fn api_key(account: &Value, provider: &str) -> Result<String, String> {
    let creds = &account["credentials"];
    let raw = creds["apiKey"].as_str().filter(|s| !s.is_empty())
        .or_else(|| creds["access"].as_str()).unwrap_or("").trim();
    let raw = if raw.get(..7).map(|s| s.eq_ignore_ascii_case("bearer ")).unwrap_or(false) {
        raw[7..].trim()
    } else { raw };
    if raw.is_empty() { Err(format!("Missing {provider} API key.")) } else { Ok(raw.to_owned()) }
}

async fn response_json(request: reqwest::RequestBuilder) -> Result<(StatusCode, Value), String> {
    // Do not expose reqwest errors: their URLs can contain sensitive information.
    let response = request.send().await.map_err(|_| "Provider request failed.".to_owned())?;
    let status = response.status();
    let value = response.json::<Value>().await.unwrap_or(Value::Null);
    Ok((status, value))
}

/// Fetches Z.AI Coding Plan quotas and updates `account.planType` when supplied.
/// The caller must persist the updated account and returned report if desired.
pub async fn fetch_zai_usage(client: &Client, account: &mut Value) -> Result<Value, String> {
    let key = api_key(account, "Z.AI")?;
    let mut payload = None;
    let mut last_status = 0;
    for endpoint in ["https://api.z.ai/api/monitor/usage/quota/limit", "https://open.bigmodel.cn/api/monitor/usage/quota/limit"] {
        for auth in [key.clone(), format!("Bearer {key}")] {
            let (status, data) = response_json(client.get(endpoint).header("Authorization", auth)
                .header("Accept", "application/json").header("Accept-Language", "en-US,en")).await?;
            last_status = status.as_u16();
            if status.is_success() {
                if data["data"]["limits"].is_array() { payload = Some(data["data"].clone()); break; }
                if data["limits"].is_array() { payload = Some(data); break; }
            }
        }
        if payload.is_some() { break; }
    }
    let payload = payload.ok_or_else(|| format!("Z.AI quota endpoint rejected key or returned no data (HTTP {last_status})."))?;
    if !payload["level"].is_null() {
        let level = payload["level"].as_str().map(str::to_owned).unwrap_or_else(|| payload["level"].to_string());
        account["planType"] = json!(level);
    }
    let mut limits = Vec::new();
    for item in payload["limits"].as_array().into_iter().flatten() {
        let kind = item["type"].as_str().unwrap_or("limit");
        let title = match kind { "TOKENS_LIMIT" => "Tokens", "TIME_LIMIT" => "MCP / Tool Calls", "CREDIT_LIMIT" => "Credits", _ => "Quota" };
        let count = number(&item["number"]).filter(|n| *n != 0.0).unwrap_or(1.0);
        let unit = item["unit"].as_i64().unwrap_or(0);
        let (window, duration) = match unit {
            3 => (format!("{count}h"), json!(count * HOUR_MS as f64)),
            4 => (format!("{count}d"), json!(count * DAY_MS as f64)),
            5 => ("Monthly".to_owned(), json!(MONTH_MS)),
            6 => ("Weekly".to_owned(), json!(WEEK_MS)),
            _ => (String::new(), Value::Null),
        };
        let used = numeric(&item["percentage"]).map(|n| n / 100.0).or_else(|| {
            let usage = numeric(&item["usage"])?;
            let current = numeric(&item["currentValue"])?;
            if usage + current <= 0.0 { return None; }
            let total = number(&item["total"]).filter(|n| *n != 0.0)
                .or_else(|| number(&item["limit"]).filter(|n| *n != 0.0)).unwrap_or(usage + current);
            (total > 0.0).then_some(usage / total)
        });
        if let Some(used) = used {
            let label = if window.is_empty() { title.to_owned() } else { format!("{window} {title}") };
            limits.push(limit(format!("{kind}_{unit}"), label, if window.is_empty() { "quota".into() } else { window }, duration, used, iso(&item["nextResetTime"])));
        }
    }
    if limits.is_empty() { return Err("Z.AI returned no active Coding Plan quota windows.".into()); }
    Ok(json!({"fetchedAt": now_ms(), "limits": limits, "metadata": {"planType": account["planType"]}}))
}

/// Fetches MiniMax Token Plan quota windows, deduplicating shared pools.
pub async fn fetch_minimax_usage(client: &Client, account: &Value) -> Result<Value, String> {
    let key = api_key(account, "MiniMax")?;
    let mut payload = None;
    let mut last_status = 0;
    for endpoint in ["https://api.minimax.io/v1/token_plan/remains", "https://api.minimaxi.com/v1/token_plan/remains"] {
        let (status, data) = response_json(client.get(endpoint).bearer_auth(&key).header("Accept", "application/json")).await?;
        last_status = status.as_u16();
        if status.is_success() && data["base_resp"]["status_code"].as_i64() == Some(0) && data["model_remains"].is_array() {
            payload = Some(data); break;
        }
    }
    let payload = payload.ok_or_else(|| format!("MiniMax Token Plan request failed (HTTP {last_status})."))?;
    let mut seen = HashSet::new();
    let mut limits = Vec::new();
    for model in payload["model_remains"].as_array().into_iter().flatten() {
        let name = model["model_name"].as_str().filter(|s| !s.is_empty()).unwrap_or("MiniMax").trim();
        let used = numeric(&model["current_interval_remaining_percent"]).map(|n| 1.0 - n / 100.0).or_else(|| {
            let total = numeric(&model["current_interval_total_count"])?;
            let remaining = numeric(&model["current_interval_usage_count"])?;
            (total > 0.0).then_some(((total - remaining) / total).clamp(0.0, 1.0))
        });
        let start = number(&model["start_time"]).unwrap_or(0.0);
        let end = number(&model["end_time"]).unwrap_or(0.0);
        let duration = if end > start { end - start } else { (5 * HOUR_MS) as f64 };
        let reset = if end > 0.0 { iso(&model["end_time"]) } else if let Some(remains) = numeric(&model["remains_time"]).filter(|n| *n > 0.0) { iso_millis(now_ms() + remains as i64) } else { Value::Null };
        if let Some(used) = used {
            let signature = format!("int|{}|{}", (used * 1000.0).round(), end);
            if seen.insert(signature) {
                limits.push(limit(format!("{name}_interval"), format!("{name} — Interval"), "5h".into(), json!(duration), used, reset));
            }
        }
        if let Some(percent) = numeric(&model["current_weekly_remaining_percent"]) {
            let used = (1.0 - percent / 100.0).clamp(0.0, 1.0);
            let end = number(&model["weekly_end_time"]).unwrap_or(0.0);
            let signature = format!("wk|{}|{}", (used * 1000.0).round(), end);
            if seen.insert(signature) {
                limits.push(limit(format!("{name}_weekly"), format!("{name} — Weekly"), "weekly".into(), json!(WEEK_MS), used, if end > 0.0 { iso(&model["weekly_end_time"]) } else { Value::Null }));
            }
        }
    }
    if limits.is_empty() { return Err("MiniMax returned no active Token Plan windows.".into()); }
    Ok(json!({"fetchedAt": now_ms(), "limits": limits, "metadata": {"planType": "Token Plan"}}))
}

/// Fetches Anthropic's OAuth usage windows and optional banked-reset information.
pub async fn fetch_claude_usage(client: &Client, account: &Value) -> Result<Value, String> {
    let access = account["credentials"]["access"].as_str().unwrap_or("");
    let (status, data) = response_json(client.get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(access).header("Accept", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-cli/2.1.280 (external, cli)")).await?;
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(format!("Claude rejected OAuth token (HTTP {status}). Click Re-auth to sign in again."));
    }
    if !status.is_success() || data.is_null() { return Err(format!("Claude usage request failed (HTTP {}).", status.as_u16())); }
    let mut limits = Vec::new();
    for (id, label, duration) in [("five_hour", "5h Session", 5 * HOUR_MS), ("seven_day", "7d Weekly", WEEK_MS),
        ("seven_day_opus", "7d Opus", WEEK_MS), ("seven_day_sonnet", "7d Sonnet", WEEK_MS),
        ("seven_day_oauth_apps", "7d OAuth Apps", WEEK_MS)] {
        let node = &data[id];
        if let Some(used) = numeric(&node["utilization"]).or_else(|| numeric(&node["used_percent"])) {
            let reset = if node["resets_at"].is_null() { &node["reset_at"] } else { &node["resets_at"] };
            limits.push(limit(id.into(), label.into(), id.into(), json!(duration), used / 100.0, iso(reset)));
        }
    }
    for item in data["limits"].as_array().into_iter().flatten() {
        let id = item["id"].as_str().or_else(|| item["scope"].as_str()).or_else(|| item["kind"].as_str()).unwrap_or("scoped");
        if limits.iter().any(|v| v["id"].as_str() == Some(id)) { continue; }
        let used = numeric(&item["utilization"]).map(|n| n / 100.0).or_else(|| {
            let used = numeric(&item["used"])?; let total = numeric(&item["limit"])?;
            (total > 0.0).then_some(used / total)
        });
        if let Some(used) = used {
            let kind = item["kind"].as_str().unwrap_or("weekly");
            let label = item["label"].as_str().or_else(|| item["display_name"].as_str()).map(str::to_owned).unwrap_or_else(|| id.replace('_', " "));
            limits.push(limit(id.into(), label, kind.into(), json!(if kind.contains("hour") { 5 * HOUR_MS } else { WEEK_MS }), used, iso(&item["resets_at"])));
        }
    }
    let extra = if data["extra_usage"].is_object() { &data["extra_usage"] } else { &data["spend"] };
    if extra["is_enabled"].as_bool() == Some(true) {
        if let Some(total) = numeric(&extra["monthly_limit"]).filter(|n| *n > 0.0) {
            let used = number(&extra["used_credits"]).or_else(|| number(&extra["used"])).unwrap_or(0.0);
            limits.push(limit("extra_usage".into(), format!("Extra Usage (${:.2} / ${:.0})", used / 100.0, total / 100.0), "monthly".into(), json!(MONTH_MS), used / total, iso(&extra["resets_at"])));
        }
    }
    if limits.is_empty() { return Err("Claude returned no active usage windows for this account.".into()); }
    let mut report = json!({"fetchedAt": now_ms(), "limits": limits, "metadata": {"email": account["email"], "orgName": account["orgName"], "planType": account["planType"]}});
    if let Some(banked) = parse_inline_banked_resets(&data, "claude") { report["bankedResets"] = banked; }
    Ok(report)
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().map(|n| n != 0.0).unwrap_or(false),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => {
            let text = value.to_string();
            text.strip_suffix(".0").unwrap_or(&text).to_owned()
        }
        Value::String(value) => value.clone(),
        Value::Array(values) => values.iter().map(|value| if value.is_null() { String::new() } else { js_string(value) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn reset_credit_count(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_f64().filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n < u64::MAX as f64).map(|n| n as u64))
}

// Usage responses also contain unrelated credits, items and counts. Only enter
// the generic credit parser through fields explicitly identifying reset credits.
fn parse_inline_banked_resets(data: &Value, provider: &str) -> Option<Value> {
    for key in ["rate_limit_resets", "limit_reset", "manual_reset", "rate_limit_reset_credits",
        "rateLimitResetCredits", "reset_credits", "banked_resets"] {
        if let Some(banked) = parse_banked_reset_payload(&data[key], provider) { return Some(banked); }
    }
    reset_credit_count(&data["banked_reset_count"]).map(|count| json!({
        "count": count, "earliestExpiresAt": null,
        "redeemable": provider == "codex" && count > 0, "items": []
    }))
}

/// Parses provider reset credits, excluding consumed, inactive, and expired entries.
pub fn parse_banked_reset_payload(raw: &Value, provider: &str) -> Option<Value> {
    if !raw.is_object() && !raw.is_array() { return None; }
    let mut list = raw.as_array();
    if list.is_none() {
        for key in ["credits", "rate_limit_reset_credits", "rateLimitResetCredits", "reset_credits", "banked_resets", "items", "data"] {
            list = raw[key].as_array().or_else(|| raw[key]["credits"].as_array());
            if list.is_some() { break; }
        }
    }
    let count = ["available_count", "availableCount", "remaining_resets", "remainingResets", "banked_reset_count"].into_iter()
        .find_map(|key| reset_credit_count(&raw[key]).or_else(|| reset_credit_count(&raw["rate_limit_reset_credits"][key])));
    if list.is_none() && count.is_none() { return None; }
    let mut items = Vec::new();
    for entry in list.into_iter().flatten() {
        if !entry.is_object() { return None; }
        if ["consumed_at", "redeemed_at", "used_at"].into_iter().any(|k| js_truthy(&entry[k])) || entry["is_consumed"] == true || entry["redeemed"] == true { continue; }
        let state = match ["status", "state"].into_iter().map(|key| &entry[key]).find(|value| !value.is_null()) {
            Some(value) => value.as_str()?.to_lowercase(),
            None => String::new(),
        };
        if ["consumed", "redeemed", "used", "expired", "revoked", "cancelled", "canceled", "inactive"].contains(&state.as_str()) { continue; }
        if !state.is_empty() && state != "available" && state != "active" { return None; }
        let expiry_raw = ["expires_at", "expiration_at", "expire_at", "expiresAt", "valid_until"].into_iter()
            .map(|k| &entry[k]).find(|v| !v.is_null());
        let expiry = expiry_raw.map(iso).unwrap_or(Value::Null);
        if expiry_raw.is_some() && expiry.is_null() { return None; }
        if expiry.as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp_millis() <= now_ms()).unwrap_or(false) { continue; }
        let id = match ["id", "credit_id", "creditId"].into_iter().map(|key| &entry[key]).find(|value| !value.is_null()) {
            Some(value) => value.as_str()?.to_owned(),
            None => String::new(),
        };
        if id.is_empty() && expiry.is_null() && state != "available" && state != "active" { return None; }
        let source = ["source", "grant_reason", "type"].into_iter().map(|key| &entry[key]).find(|value| js_truthy(value)).map(js_string).unwrap_or_else(|| "banked_reset".into());
        items.push(json!({"id": id, "expiresAt": expiry, "source": source}));
    }
    items.sort_by(|a, b| match (a["expiresAt"].as_str(), b["expiresAt"].as_str()) { (Some(a), Some(b)) => a.cmp(b), (Some(_), None) => std::cmp::Ordering::Less, (None, Some(_)) => std::cmp::Ordering::Greater, _ => std::cmp::Ordering::Equal });
    let total = if list.is_some() { items.len() as u64 } else { count.unwrap_or(0) };
    let earliest = items.iter().find(|v| !v["expiresAt"].is_null()).map(|v| v["expiresAt"].clone()).unwrap_or(Value::Null);
    items.truncate(10);
    Some(json!({"count": total, "earliestExpiresAt": earliest, "redeemable": provider == "codex" && total > 0, "items": items}))
}

#[cfg(test)]
mod banked_reset_tests {
    use super::*;

    #[test]
    fn inline_requires_explicit_reset_fields() {
        for provider in ["claude", "codex"] {
            assert!(parse_inline_banked_resets(&json!({"credits": [{"id": "other"}], "available_count": 3}), provider).is_none());
            let parsed = parse_inline_banked_resets(&json!({"rate_limit_reset_credits": {"available_count": 2}}), provider).unwrap();
            assert_eq!(parsed["count"], 2);
            assert_eq!(parsed["redeemable"], provider == "codex");
            assert_eq!(parse_inline_banked_resets(&json!({"banked_reset_count": 0}), provider).unwrap()["count"], 0);
            assert_eq!(parse_inline_banked_resets(&json!({"banked_reset_count": 2.0}), provider).unwrap()["count"], 2);
            assert_eq!(parse_inline_banked_resets(&json!({"manual_reset": {}, "banked_resets": {"available_count": 1}}), provider).unwrap()["count"], 1);
        }
    }

    #[test]
    fn malformed_credit_payloads_are_unknown() {
        for raw in [json!({}), json!({"available_count": -1}), json!({"available_count": 1.5}),
            json!({"credits": [null]}), json!({"credits": [{}]}),
            json!({"credits": [{"id": {}, "status": "available"}]}),
            json!({"credits": [{"id": "x", "expires_at": "invalid"}]}),
            json!({"credits": [{"id": "x", "status": "pending"}]})] {
            assert!(parse_banked_reset_payload(&raw, "codex").is_none(), "{raw}");
        }
        assert_eq!(parse_banked_reset_payload(&json!({"credits": []}), "codex").unwrap()["count"], 0);
    }

    #[test]
    fn explicit_list_excludes_consumed_and_expired_credits() {
        let raw = json!({"credits": [
            {"id": "active", "expires_at": "2999-01-01T00:00:00Z"},
            {"id": "used", "status": "redeemed"},
            {"id": "expired", "expires_at": "2000-01-01T00:00:00Z"}
        ]});
        let parsed = parse_banked_reset_payload(&raw, "codex").unwrap();
        assert_eq!(parsed["count"], 1);
        assert_eq!(parsed["items"][0]["id"], "active");
        assert!(parsed["earliestExpiresAt"].is_string());
    }
}

/// Fetches xAI Grok CLI credit and billing windows.
pub async fn fetch_xai_usage(client: &Client, account: &Value) -> Result<Value, String> {
    let access = account["credentials"]["access"].as_str().unwrap_or("");
    let (status, data) = response_json(client.get("https://cli-chat-proxy.grok.com/v1/billing?format=credits")
        .bearer_auth(access).header("Accept", "application/json").header("X-XAI-Token-Auth", "xai-grok-cli")).await?;
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN { return Err(format!("xAI Grok token expired or unauthorized (HTTP {}). Click Re-auth.", status.as_u16())); }
    if !status.is_success() || data.is_null() { return Err(format!("xAI Grok billing request failed (HTTP {}).", status.as_u16())); }
    let mut limits = Vec::new();
    let reset = [&data["resetAt"], &data["resetsAt"], &data["periodEnd"]].into_iter().find(|v| !v.is_null()).map(iso).unwrap_or(Value::Null);
    if let Some(percent) = numeric(&data["creditUsagePercent"]) {
        limits.push(limit("weekly_credits".into(), "Weekly Credits".into(), "weekly".into(), json!(WEEK_MS), percent / 100.0, reset));
    } else if let (Some(used), Some(total)) = (numeric(&data["usedCredits"]), numeric(&data["totalCredits"])) {
        if total > 0.0 { limits.push(limit("weekly_credits".into(), "Grok CLI Credits".into(), "weekly".into(), json!(WEEK_MS), used / total, reset)); }
    }
    for item in data["limits"].as_array().into_iter().flatten() {
        let used = numeric(&item["usedPercent"]).map(|n| n / 100.0).or_else(|| { let used = numeric(&item["used"])?; let total = numeric(&item["limit"])?; (total > 0.0).then_some(used / total) });
        if let Some(used) = used {
            let name = item["name"].as_str();
            let id = item["id"].as_str().or(name).unwrap_or("limit");
            let label = item["label"].as_str().or(name).unwrap_or("xAI Limit");
            let reset = if item["resetsAt"].is_null() { &item["resetAt"] } else { &item["resetsAt"] };
            limits.push(limit(id.into(), label.into(), item["window"].as_str().unwrap_or("weekly").into(), json!(WEEK_MS), used, iso(reset)));
        }
    }
    if let (Some(used), Some(total)) = (numeric(&data["used"]), numeric(&data["monthlyLimit"])) {
        if total > 0.0 { let reset = if data["billingCycleEnd"].is_null() { &data["resetAt"] } else { &data["billingCycleEnd"] }; limits.push(limit("monthly_spend".into(), "Monthly Billing Limit".into(), "monthly".into(), json!(MONTH_MS), used / total, iso(reset))); }
    }
    if limits.is_empty() { return Err("xAI returned no active credit or billing windows.".into()); }
    Ok(json!({"fetchedAt": now_ms(), "limits": limits, "metadata": {"email": account["email"], "planType": if data["plan"].is_null() { &account["planType"] } else { &data["plan"] }}}))
}

/// Fetches GitHub Copilot quota snapshots and updates account identity and plan.
pub async fn fetch_copilot_usage(client: &Client, account: &mut Value) -> Result<Value, String> {
    let creds = &account["credentials"];
    let access = creds["access"].as_str().filter(|s| !s.is_empty()).or_else(|| creds["apiKey"].as_str()).unwrap_or("");
    let (status, data) = response_json(client.get("https://api.github.com/copilot_internal/user").bearer_auth(access)
        .header("Accept", "application/json").header("Editor-Version", "vscode/1.99.0")
        .header("Editor-Plugin-Version", "copilot-chat/0.26.0").header("User-Agent", "GitHubCopilotChat/0.26.0")).await?;
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN { return Err(format!("GitHub Copilot token rejected or no active Copilot seat (HTTP {}).", status.as_u16())); }
    if !status.is_success() || data.is_null() { return Err(format!("GitHub Copilot usage request failed (HTTP {}).", status.as_u16())); }
    if let Some(plan) = data["copilot_plan"].as_str() { account["planType"] = json!(plan); }
    if account["email"].as_str().unwrap_or("").is_empty() { if let Some(login) = data["login"].as_str() { account["email"] = json!(format!("@{login}")); } }
    let reset = [&data["quota_reset_date_utc"], &data["quota_reset_date"], &data["limited_user_reset_date"]].into_iter().find(|v| !v.is_null()).map(iso).unwrap_or(Value::Null);
    let mut limits = Vec::new();
    for (key, label) in [("premium_interactions", "Premium Requests"), ("chat", "Copilot Chat"), ("completions", "Code Completions")] {
        let snapshot = &data["quota_snapshots"][key];
        if !snapshot.is_object() { continue; }
        if snapshot["unlimited"] == true { limits.push(limit(key.into(), format!("{label} (Unlimited)"), "monthly".into(), json!(MONTH_MS), 0.0, reset.clone())); continue; }
        let total = numeric(&snapshot["entitlement"]); let remaining = numeric(&snapshot["remaining"]);
        let used = numeric(&snapshot["percent_remaining"]).map(|n| 1.0 - n / 100.0).or_else(|| match (total, remaining) { (Some(t), Some(r)) if t > 0.0 => Some((t-r)/t), _ => None });
        if let Some(used) = used {
            let suffix = match (total, remaining) { (Some(t), Some(r)) => format!(" ({}/{})", (t-r).max(0.0), t), _ => String::new() };
            limits.push(limit(key.into(), format!("{label}{suffix}"), "monthly".into(), json!(MONTH_MS), used, reset.clone()));
        }
    }
    if limits.is_empty() {
        for (key, label) in [("chat", "Chat Messages"), ("completions", "Completions")] {
            if let (Some(total), Some(rem)) = (number(&data["monthly_quotas"][key]), number(&data["limited_user_quotas"][key])) {
                if total > 0.0 { limits.push(limit(key.into(), format!("{label} ({}/{})", (total-rem).max(0.0), total), "monthly".into(), json!(MONTH_MS), (total-rem)/total, reset.clone())); }
            }
        }
    }
    if limits.is_empty() { return Err("GitHub Copilot returned no quota snapshots for this account.".into()); }
    Ok(json!({"fetchedAt": now_ms(), "limits": limits, "metadata": {"email": account["email"], "planType": account["planType"]}}))
}

/// Fetches Kimi Code's rate and weekly quota windows.
/// The caller supplies the machine-identifying HTTP headers matching its login flow.
pub async fn fetch_kimi_usage(client: &Client, account: &Value, device_headers: &reqwest::header::HeaderMap) -> Result<Value, String> {
    let access = account["credentials"]["access"].as_str().unwrap_or("");
    let (status, data) = response_json(client.get("https://api.kimi.com/coding/v1/usages").headers(device_headers.clone())
        .bearer_auth(access).header("Accept", "application/json")).await?;
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN { return Err(format!("Kimi Code session expired (HTTP {}). Click Re-auth.", status.as_u16())); }
    if !status.is_success() || data.is_null() { return Err(format!("Kimi Code usage request failed (HTTP {}).", status.as_u16())); }
    let mut limits = Vec::new();
    let mut add = |node: &Value, fallback: String, fallback_duration: i64| {
        if !node.is_object() { return; }
        let detail = if node["detail"].is_object() { &node["detail"] } else { node };
        let total = match number(&detail["limit"]) { Some(n) if n > 0.0 => n, _ => return };
        let used = if !detail["used"].is_null() { number(&detail["used"]) } else { number(&detail["remaining"]).map(|r| total-r) };
        let used = match used { Some(n) => n, None => return };
        let mut label = fallback; let mut duration = fallback_duration as f64;
        if let Some(n) = numeric(&node["window"]["duration"]) {
            let unit = node["window"]["timeUnit"].as_str().unwrap_or("").to_uppercase();
            if unit.contains("MINUTE") { duration = n*60_000.0; let hours = (n/60.0).round(); label = if hours >= 1.0 { format!("{hours}h Rate Limit") } else { format!("{n}m Rate Limit") }; }
            else if unit.contains("HOUR") { duration = n*HOUR_MS as f64; label = format!("{n}h Rate Limit"); }
            else if unit.contains("DAY") { duration = n*DAY_MS as f64; label = format!("{n}d Quota"); }
        }
        let reset = [&detail["resetTime"], &detail["reset_at"], &node["resetTime"]].into_iter().find(|v| !v.is_null()).map(iso).unwrap_or(Value::Null);
        limits.push(limit(label.to_lowercase().split_whitespace().collect::<Vec<_>>().join("_"), label.clone(), label, json!(duration), used/total, reset));
    };
    for (index, node) in data["limits"].as_array().into_iter().flatten().enumerate() { add(node, if index == 0 { "5h Rate Limit".into() } else { format!("Rate Limit #{}", index+1) }, 5*HOUR_MS); }
    if data["usage"].is_object() { add(&data["usage"], "Weekly Quota".into(), WEEK_MS); }
    if limits.is_empty() { return Err("Kimi Code returned no quota windows.".into()); }
    Ok(json!({"fetchedAt": now_ms(), "limits": limits, "metadata": {"email": account["email"], "planType": account["planType"]}}))
}

fn jwt_payload(token: &str) -> Value {
    use base64::Engine;
    token.split('.').nth(1).and_then(|part| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or(Value::Null)
}

/// Refreshes expiring OAuth credentials in place. The caller must serialize refreshes
/// per account and persist the mutated account before using it concurrently.
pub async fn ensure_fresh_credentials(client: &Client, account: &mut Value, kimi_headers: &reqwest::header::HeaderMap) -> Result<Value, String> {
    let creds = account["credentials"].clone();
    let refresh = match creds["refresh"].as_str().filter(|s| !s.is_empty()) { Some(s) if creds["type"] != "api_key" => s, _ => return Ok(creds) };
    let mut expires = number(&creds["expires"]).unwrap_or(0.0);
    if expires == 0.0 { expires = jwt_payload(creds["access"].as_str().unwrap_or(""))["exp"].as_f64().unwrap_or(0.0)*1000.0; }
    if expires > (now_ms() + 300_000) as f64 { return Ok(creds); }
    let provider = account["provider"].as_str().unwrap_or("");
    let (request, name) = match provider {
        "antigravity" | "gemini-cli" => {
            let (id, secret) = google_client(provider)?;
            (client.post("https://oauth2.googleapis.com/token").form(&[("client_id", id.as_str()), ("client_secret", secret.as_str()), ("refresh_token", refresh), ("grant_type", "refresh_token")]), "Google OAuth")
        }
        "codex" => (client.post("https://auth.openai.com/oauth/token").form(&[("grant_type", "refresh_token"), ("refresh_token", refresh), ("client_id", "app_EMoamEEZ73f0CkXaXp7hrann")]), "OpenAI token"),
        "claude" => (client.post("https://api.anthropic.com/v1/oauth/token").header("anthropic-beta", "oauth-2025-04-20").header("User-Agent", "anthropic-sdk-typescript/0.112.1 userOAuthProvider")
            .json(&json!({"grant_type":"refresh_token", "client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e", "refresh_token":refresh})), "Claude OAuth"),
        "cursor" => (client.post("https://api2.cursor.sh/oauth/token").json(&json!({"grant_type":"refresh_token", "client_id":"KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB", "refresh_token":refresh})), "Cursor session"),
        "kimi" => (client.post("https://auth.kimi.com/api/oauth/token").headers(kimi_headers.clone()).form(&[("client_id", "17e5f671-d194-4dfb-9706-5516cb48c098"), ("grant_type", "refresh_token"), ("refresh_token", refresh)]), "Kimi OAuth"),
        "xai" => (client.post(creds["tokenEndpoint"].as_str().unwrap_or("https://auth.x.ai/oauth2/token")).form(&[("client_id", "b1a00492-073a-47ea-816f-4c329264a828"), ("grant_type", "refresh_token"), ("refresh_token", refresh)]), "xAI token"),
        _ => return Ok(creds),
    };
    let (status, data) = response_json(request).await?;
    let access = data["access_token"].as_str().or_else(|| if provider == "cursor" { data["accessToken"].as_str() } else { None });
    let access = match access { Some(value) if status.is_success() && !value.is_empty() => value, _ => return Err(format!("{name} refresh failed (HTTP {}). Click Re-auth to sign in again.", status.as_u16())) };
    let next_refresh = data["refresh_token"].as_str().or_else(|| data["refreshToken"].as_str()).unwrap_or(refresh);
    let expires = if provider == "cursor" {
        jwt_payload(access)["exp"].as_i64().map(|s| s*1000-60_000).unwrap_or_else(|| now_ms()+HOUR_MS)
    } else { now_ms() + (number(&data["expires_in"]).filter(|n| *n != 0.0).unwrap_or(3600.0)*1000.0) as i64 - 60_000 };
    let mut updated = creds.clone();
    updated["access"] = json!(access); updated["refresh"] = json!(next_refresh); updated["expires"] = json!(expires);
    if provider == "codex" {
        let token = jwt_payload(access); let id = jwt_payload(data["id_token"].as_str().unwrap_or(""));
        let auth = if token["https://api.openai.com/auth"].is_object() { &token["https://api.openai.com/auth"] } else { &id["https://api.openai.com/auth"] };
        let profile = if token["https://api.openai.com/profile"].is_object() { &token["https://api.openai.com/profile"] } else { &id["https://api.openai.com/profile"] };
        if let Some(email) = profile["email"].as_str().or_else(|| id["email"].as_str()).or_else(|| token["email"].as_str()) { account["email"] = json!(email); }
        if let Some(id) = auth["chatgpt_account_id"].as_str().or_else(|| id["chatgpt_account_id"].as_str()) { account["accountId"] = json!(id); }
        if let Some(plan) = auth["chatgpt_plan_type"].as_str() { account["planType"] = json!(plan); }
    }
    account["credentials"] = updated.clone();
    Ok(updated)
}

fn codex_headers(account: &Value) -> Result<reqwest::header::HeaderMap, String> {
    use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, ACCEPT, USER_AGENT};
    let mut headers = HeaderMap::new();
    let access = account["credentials"]["access"].as_str().unwrap_or("");
    headers.insert(AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {access}")).map_err(|_| "Invalid Codex credentials.".to_owned())?);
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, HeaderValue::from_static("ChalzTracker/2.0"));
    if let Some(id) = account["accountId"].as_str().filter(|s| !s.is_empty()) {
        headers.insert("chatgpt-account-id", HeaderValue::from_str(id).map_err(|_| "Invalid Codex account identifier.".to_owned())?);
    }
    Ok(headers)
}

type BankedCache = std::collections::HashMap<String, (i64, Value)>;
static CODEX_BANKED_CACHE: std::sync::LazyLock<std::sync::Mutex<BankedCache>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(BankedCache::new()));

fn codex_cache_key(account: &Value) -> &str {
    ["id", "accountId", "email"].into_iter().find_map(|key| account[key].as_str().filter(|s| !s.is_empty())).unwrap_or("codex")
}

/// Invalidates the in-memory banked-reset cache for this account.
pub fn invalidate_codex_banked_cache(account: &Value) {
    if let Ok(mut cache) = CODEX_BANKED_CACHE.lock() { cache.remove(codex_cache_key(account)); }
}

async fn codex_banked_resets(client: &Client, account: &Value, headers: reqwest::header::HeaderMap, inline: Option<Value>, force: bool) -> Option<Value> {
    let key = codex_cache_key(account).to_owned();
    let cached = CODEX_BANKED_CACHE.lock().ok().and_then(|cache| cache.get(&key).cloned());
    if let Some(value) = inline {
        if let Ok(mut cache) = CODEX_BANKED_CACHE.lock() { cache.insert(key.clone(), (now_ms(), value.clone())); }
        return Some(value);
    }
    if !force {
        if let Some((time, value)) = &cached {
            if now_ms() - time < 600_000 { return Some(value.clone()); }
        }
    }
    let fresh = match response_json(client.get("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits").headers(headers)).await {
        Ok((status, data)) if status.is_success() => parse_banked_reset_payload(&data, "codex"),
        _ => None,
    };
    if let Some(value) = fresh {
        if let Ok(mut cache) = CODEX_BANKED_CACHE.lock() { cache.insert(key, (now_ms(), value.clone())); }
        Some(value)
    } else { None }
}

/// Fetches Codex usage and cached banked-reset credits. Refresh separately first.
pub async fn fetch_codex_usage(client: &Client, account: &mut Value) -> Result<Value, String> {
    fetch_codex_usage_with_options(client, account, false).await
}

/// Fetches Codex usage, optionally forcing a banked-credit refresh.
pub async fn fetch_codex_usage_with_options(client: &Client, account: &mut Value, force_banked: bool) -> Result<Value, String> {
    let headers = codex_headers(account)?;
    let (status, data) = response_json(client.get("https://chatgpt.com/backend-api/wham/usage").headers(headers.clone())).await?;
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN { return Err(format!("OpenAI Codex rejected authentication (HTTP {}). Click Re-auth to sign in again.", status.as_u16())); }
    if !status.is_success() || data.is_null() { return Err(format!("Codex usage request failed (HTTP {}).", status.as_u16())); }
    if !data["plan_type"].is_null() { account["planType"] = data["plan_type"].clone(); }
    if account["email"].as_str().unwrap_or("").is_empty() { if let Some(email) = data["email"].as_str() { account["email"] = json!(email.to_lowercase()); } }
    let mut limits = Vec::new();
    let mut add = |id: &str, label: &str, node: &Value, fallback: i64| {
        if let Some(pct) = numeric(&node["used_percent"]) {
            let duration = numeric(&node["limit_window_seconds"]).filter(|n| *n > 0.0).map(|n| n*1000.0).unwrap_or(fallback as f64);
            let reset = if numeric(&node["reset_at"]).filter(|n| *n > 0.0).is_some() { iso(&node["reset_at"]) }
                else if let Some(n) = numeric(&node["reset_after_seconds"]).filter(|n| *n > 0.0) { iso_millis(now_ms()+(n*1000.0) as i64) }
                else { iso(&node["resets_at"]) };
            limits.push(limit(id.into(), label.into(), id.into(), json!(duration), pct/100.0, reset));
        }
    };
    add("5h", "5 Hour Window", &data["rate_limit"]["primary_window"], 5*HOUR_MS);
    add("7d", "7 Day Weekly", &data["rate_limit"]["secondary_window"], WEEK_MS);
    for extra in data["additional_rate_limits"].as_array().into_iter().flatten() {
        let name = extra["limit_name"].as_str().or_else(|| extra["metered_feature"].as_str()).unwrap_or("Additional").trim().replace('_', " ");
        let short = if name.to_ascii_lowercase().starts_with("gpt-") {
            name.to_ascii_lowercase().find("-codex-").map(|i| format!("Codex {}", &name[i+7..])).unwrap_or(name.clone())
        } else { name };
        add(&format!("{short}:5h"), &format!("{short} (5h)"), &extra["rate_limit"]["primary_window"], 5*HOUR_MS);
        add(&format!("{short}:7d"), &format!("{short} (7d)"), &extra["rate_limit"]["secondary_window"], WEEK_MS);
    }
    if numeric(&data["code_review_rate_limit"]["primary_window"]["used_percent"]).unwrap_or(0.0) > 0.0 { add("code_review", "Code Review Window", &data["code_review_rate_limit"]["primary_window"], WEEK_MS); }
    let spend = &data["spend_control"]["individual_limit"];
    if let Some(total) = numeric(&spend["allocated_amount_cents"]).filter(|n| *n > 0.0) {
        let used = number(&spend["used_amount_cents"]).unwrap_or(0.0);
        limits.push(limit("spend".into(), format!("Spend (${:.2} / ${:.0})", used/100.0, total/100.0), "monthly".into(), json!(MONTH_MS), used/total, iso(&spend["resets_at"])));
    }
    if limits.is_empty() { return Err("Codex returned no active quota windows for this account.".into()); }
    let inline = parse_inline_banked_resets(&data, "codex");
    let banked = codex_banked_resets(client, account, headers, inline, force_banked).await;
    Ok(json!({"fetchedAt":now_ms(), "limits":limits, "bankedResets":banked, "metadata":{"email":account["email"], "accountId":account["accountId"], "planType":account["planType"]}}))
}

fn cursor_period_limits(period: &Value, fallback_reset: &Value) -> Vec<Value> {
    let reset = if period["billingCycleEnd"].is_null() { fallback_reset.clone() } else { iso(&period["billingCycleEnd"]) };
    let plan = &period["planUsage"];
    let mut limits = Vec::new();
    for (id, label, key) in [("cursor_models", "Cursor Models", "autoPercentUsed"), ("other_models", "Other Models", "apiPercentUsed")] {
        if let Some(percent) = numeric(&plan[key]) {
            limits.push(limit(id.into(), label.into(), "monthly".into(), json!(MONTH_MS), percent / 100.0, reset.clone()));
        }
    }
    if limits.is_empty() {
        let fraction = numeric(&plan["totalPercentUsed"]).map(|percent| percent / 100.0).or_else(|| {
            let used = numeric(&plan["includedSpend"])?;
            let total = numeric(&plan["limit"]).filter(|n| *n > 0.0)?;
            Some(used / total)
        });
        if let Some(fraction) = fraction {
            limits.push(limit("included_plan".into(), "Included Plan".into(), "monthly".into(), json!(MONTH_MS), fraction, reset.clone()));
        }
    }
    if !limits.is_empty() {
        let spend = &period["spendLimitUsage"];
        if let (Some(used), Some(total)) = (numeric(&spend["individualUsed"]), numeric(&spend["individualLimit"]).filter(|n| *n > 0.0)) {
            limits.push(limit("on_demand".into(), format!("On-Demand (${:.2} / ${:.0})", used / 100.0, total / 100.0), "monthly".into(), json!(MONTH_MS), used / total, reset));
        }
    }
    limits
}

/// Fetches Cursor summary and legacy request quotas, updating discovered identity.
pub async fn fetch_cursor_usage(client: &Client, account: &mut Value) -> Result<Value, String> {
    let access = account["credentials"]["access"].as_str().unwrap_or("").to_owned();
    let jwt = jwt_payload(&access);
    let sub = jwt["sub"].as_str().unwrap_or("");
    let id = account["accountId"].as_str().filter(|s| !s.is_empty()).unwrap_or_else(|| sub.split_once('|').map(|(_, id)| id).unwrap_or(sub)).to_owned();
    if account["accountId"].as_str().unwrap_or("").is_empty() && !id.is_empty() { account["accountId"] = json!(id); }
    let cookie = url::form_urlencoded::byte_serialize(format!("{}::{access}", if id.is_empty() { "user" } else { &id }).as_bytes()).collect::<String>();
    let (summary, plan) = tokio::join!(
        response_json(client.get("https://cursor.com/api/usage-summary").header("Cookie", format!("WorkosCursorSessionToken={cookie}")).header("Accept", "application/json").header("User-Agent", "ChalzTracker/2.0")),
        response_json(client.post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo").bearer_auth(&access).header("Connect-Protocol-Version", "1").json(&json!({})))
    );
    let (status, summary) = summary?;
    let plan = plan.map(|(_, data)| data).unwrap_or(Value::Null);
    let reset = if !plan["planInfo"]["includedUsageResetsAt"].is_null() { iso(&plan["planInfo"]["includedUsageResetsAt"]) } else { iso(&summary["billingCycleEnd"]) };
    let mut limits = Vec::new();
    if status.is_success() && !summary.is_null() {
        if !summary["membershipType"].is_null() { account["planType"] = summary["membershipType"].clone(); }
        let individual = &summary["individualUsage"]; let plan = &individual["plan"];
        let auto = numeric(&plan["autoPercentUsed"]); let api = numeric(&plan["apiPercentUsed"]);
        if auto.is_some() || api.is_some() {
            for (id, label, val) in [("cursor_models", "Cursor Models", auto), ("other_models", "Other Models", api)] { if let Some(val) = val { limits.push(limit(id.into(), label.into(), "monthly".into(), json!(MONTH_MS), val/100.0, reset.clone())); } }
        } else if let Some(val) = numeric(&plan["totalPercentUsed"]) {
            limits.push(limit("included_plan".into(), "Included Plan".into(), "monthly".into(), json!(MONTH_MS), val/100.0, reset.clone()));
        } else if let (Some(used), Some(total)) = (numeric(&plan["used"]), numeric(&plan["limit"])) {
            if total > 0.0 { limits.push(limit("included_plan".into(), "Included Plan".into(), "monthly".into(), json!(MONTH_MS), used/total, reset.clone())); }
        }
        let overall = &individual["overall"];
        if limits.is_empty() { if let (Some(used), Some(total)) = (numeric(&overall["used"]), numeric(&overall["limit"])) { if total > 0.0 { limits.push(limit("overall".into(), "Overall Usage".into(), "monthly".into(), json!(MONTH_MS), used/total, reset.clone())); } } }
        let demand = &individual["onDemand"];
        if demand["enabled"] == true { if let Some(total) = numeric(&demand["limit"]).filter(|n| *n > 0.0) { let used = number(&demand["used"]).unwrap_or(0.0); limits.push(limit("on_demand".into(), format!("On-Demand (${:.2} / ${:.0})", used/100.0, total/100.0), "monthly".into(), json!(MONTH_MS), used/total, reset.clone())); } }
    }
    if limits.is_empty() && status == StatusCode::FORBIDDEN {
        let period = response_json(client.post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage")
            .bearer_auth(&access).header("Connect-Protocol-Version", "1").json(&json!({}))).await;
        if let Ok((period_status, period)) = period {
            if period_status.is_success() { limits = cursor_period_limits(&period, &reset); }
        }
    }
    if limits.is_empty() {
        let mut request = client.get("https://api2.cursor.sh/auth/usage").bearer_auth(&access);
        if !id.is_empty() { request = request.query(&[("user", &id)]); }
        let (legacy_status, legacy) = response_json(request).await?;
        if legacy_status == StatusCode::UNAUTHORIZED || status == StatusCode::UNAUTHORIZED { return Err("Cursor session expired (HTTP 401). Click Re-auth to sign in again.".into()); }
        if legacy_status.is_success() {
            let legacy_reset = if let Some(start) = iso(&legacy["startOfMonth"]).as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()) { iso_millis(start.timestamp_millis()+MONTH_MS) } else { reset };
            for (key, label) in [("gpt-4", "Premium Requests"), ("gpt-3.5-turbo", "Standard Requests")] {
                if let (Some(used), Some(total)) = (numeric(&legacy[key]["numRequests"]), numeric(&legacy[key]["maxRequestUsage"])) { if total > 0.0 { limits.push(limit(key.into(), format!("{label} ({used}/{total})"), "monthly".into(), json!(MONTH_MS), used/total, legacy_reset.clone())); } }
            }
        }
    }
    if limits.is_empty() { return Err(format!("Cursor returned no usable quota windows (HTTP {}).", status.as_u16())); }
    Ok(json!({"fetchedAt":now_ms(), "limits":limits, "metadata":{"email":account["email"], "accountId":account["accountId"], "planType":account["planType"]}}))
}

const GOOGLE_ENDPOINTS: [&str; 3] = ["https://daily-cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.sandbox.googleapis.com", "https://cloudcode-pa.googleapis.com"];

fn google_request(client: &Client, url: &str, access: &str, antigravity: bool, body: &Value) -> reqwest::RequestBuilder {
    let request = client.post(url).bearer_auth(access).json(body);
    if antigravity { request.header("User-Agent", "antigravity/hub/2.26.0 (aidev_client; os_type=windows; arch=amd64; cl=1005016104)")
        .header("X-Goog-Api-Client", "gl-node/22.14.0").header("Client-Metadata", r#"{"ideType":"ANTIGRAVITY","platform":"WINDOWS_AMD64","pluginType":"GEMINI"}"#) }
    else { request.header("User-Agent", "GeminiCLI/0.46.0/gemini-3.1-pro-preview (win32; x64; terminal)")
        .header("Client-Metadata", "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI") }
}

fn google_project(data: &Value) -> Option<&str> {
    data["cloudaicompanionProject"].as_str().or_else(|| data["cloudaicompanionProject"]["id"].as_str()).map(str::trim).filter(|s| !s.is_empty())
}

const GOOGLE_PLAN_RECHECK_MS: i64 = 6 * 60 * 60 * 1000;

/// Google subscriptions (Google AI Pro, Ultra) are reported in `paidTier`; `currentTier` is the
/// Code Assist tier, which is named after the product ("Antigravity") even for paying users.
fn google_plan(data: &Value) -> Option<String> {
    let name = |tier: &Value| tier["name"].as_str().or_else(|| tier["id"].as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
    name(&data["paidTier"]).or_else(|| if data["currentTier"]["id"] == "free-tier" { Some("Free".into()) } else { name(&data["currentTier"]) })
}

async fn google_identity(client: &Client, account: &mut Value, access: &str, antigravity: bool) {
    let needs_project = account["projectId"].as_str().unwrap_or("").is_empty();
    let plan_due = account["planCheckedAt"].as_i64().is_none_or(|checked| now_ms() - checked >= GOOGLE_PLAN_RECHECK_MS);
    if needs_project || plan_due {
        let endpoints: &[&str] = if antigravity { &GOOGLE_ENDPOINTS } else { &GOOGLE_ENDPOINTS[2..] };
        let metadata = json!({"ideType": if antigravity { "ANTIGRAVITY" } else { "IDE_UNSPECIFIED" }, "platform":"PLATFORM_UNSPECIFIED", "pluginType":"GEMINI"});
        for endpoint in endpoints {
            let load = response_json(google_request(client, &format!("{endpoint}/v1internal:loadCodeAssist"), access, antigravity, &json!({"metadata":metadata}))).await;
            if let Ok((status, data)) = load {
                if !status.is_success() { continue; }
                account["planCheckedAt"] = json!(now_ms());
                let tier = google_plan(&data);
                if let Some(plan) = &tier { account["planType"] = json!(plan); }
                if !needs_project { break; }
                if let Some(project) = google_project(&data) { account["projectId"] = json!(project); break; }
                let allowed = data["allowedTiers"].as_array();
                let default = allowed.and_then(|a| a.iter().find(|t| t["isDefault"] == true).or_else(|| a.first())).and_then(|t| t["id"].as_str()).unwrap_or("free-tier");
                if let Ok((s, onboard)) = response_json(google_request(client, &format!("{endpoint}/v1internal:onboardUser"), access, antigravity, &json!({"tierId":default, "metadata":metadata}))).await {
                    if s.is_success() {
                        let response = if onboard["response"].is_object() { &onboard["response"] } else { &onboard };
                        if let Some(project) = google_project(response) { account["projectId"] = json!(project); if tier.is_none() { account["planType"] = json!(if default == "free-tier" { "Free" } else { default }); } break; }
                    }
                }
                break;
            }
        }
    }
    if account["email"].as_str().unwrap_or("").is_empty() {
        if let Ok((status, data)) = response_json(client.get("https://www.googleapis.com/oauth2/v1/userinfo?alt=json").bearer_auth(access)).await {
            if status.is_success() { if let Some(email) = data["email"].as_str() { account["email"] = json!(email.to_lowercase()); } }
        }
    }
}

fn google_fraction(bucket: &Value) -> Option<f64> {
    numeric(&bucket["usedFraction"]).or_else(|| numeric(&bucket["remainingFraction"]).map(|v| 1.0-v)).or_else(|| {
        let remaining = numeric(&bucket["remaining"])?; let total = numeric(&bucket["limit"])?; (total > 0.0).then_some(1.0-remaining/total)
    }).or_else(|| if bucket.get("remainingFraction").is_none() && !bucket["resetTime"].is_null() { Some(1.0) } else { None }).map(|v| v.clamp(0.0, 1.0))
}

/// Fetches Google Gemini CLI quota buckets and discovers account identity.
pub async fn fetch_gemini_usage(client: &Client, account: &mut Value) -> Result<Value, String> {
    let access = account["credentials"]["access"].as_str().unwrap_or("").to_owned();
    google_identity(client, account, &access, false).await;
    let body = if account["projectId"].as_str().unwrap_or("").is_empty() { json!({}) } else { json!({"project":account["projectId"]}) };
    let (status, data) = response_json(google_request(client, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", &access, false, &body)).await?;
    if status == StatusCode::UNAUTHORIZED { return Err("Gemini CLI authentication expired (HTTP 401). Click Re-auth.".into()); }
    if !status.is_success() || data.is_null() { return Err(format!("Gemini CLI quota request failed (HTTP {}).", status.as_u16())); }
    let mut grouped: Vec<Value> = Vec::new();
    for bucket in data["buckets"].as_array().into_iter().flatten() {
        let used = match google_fraction(bucket) { Some(v) => v, None => continue };
        let model = bucket["modelId"].as_str().or_else(|| bucket["bucketId"].as_str()).unwrap_or("Gemini").trim();
        let lower = model.to_lowercase();
        let family = if lower.contains("pro") { if lower.contains('3') { "Gemini 3 Pro" } else { "Gemini 2.5 Pro" } }
            else if lower.contains("flash-lite") { "Gemini Flash-Lite" }
            else if lower.contains("flash") { if lower.contains('3') { "Gemini 3 Flash" } else { "Gemini 2.5 Flash" } } else { model };
        let previous = grouped.iter().position(|v| v["label"] == family);
        if previous.map(|i| used <= grouped[i]["usedFraction"].as_f64().unwrap_or(0.0)).unwrap_or(false) { continue; }
        let mut reset = iso(&bucket["resetTime"]);
        if reset.is_null() { if let Some(i) = previous { reset = grouped[i]["resetsAt"].clone(); } }
        let item = limit(model.into(), family.into(), "daily".into(), json!(DAY_MS), used, reset);
        if let Some(i) = previous { grouped[i] = item; } else { grouped.push(item); }
    }
    if grouped.is_empty() { return Err("Gemini CLI returned no active quota buckets.".into()); }
    Ok(json!({"fetchedAt":now_ms(), "limits":grouped, "metadata":{"email":account["email"], "projectId":account["projectId"], "planType":account["planType"]}}))
}

fn antigravity_classify(id: &str, window: &str, title: &str) -> (String, String, Value) {
    let combined = format!("{id} {window} {title}").to_lowercase();
    let family = if combined.contains("argon") { "Gemini (Argon)" }
        else if ["claude", "gpt", "3p", "anthropic", "sonnet", "opus"].iter().any(|s| combined.contains(s)) { "Claude & GPT Models" }
        else if ["gemini", "flash", "pro"].iter().any(|s| combined.contains(s)) { "Gemini Models" }
        else if !title.is_empty() { title } else { "Models" };
    let (name, duration) = if ["five_hour", "five-hour", "five hour", "fivehour", "5h", "hourly", "short"].iter().any(|s| combined.contains(s)) { ("5h Limit", json!(5*HOUR_MS)) }
        else if ["week", "7d", "wtu"].iter().any(|s| combined.contains(s)) { ("Weekly Limit", json!(WEEK_MS)) }
        else if ["daily", "24h", "1d"].iter().any(|s| combined.contains(s)) { ("Daily Limit", json!(DAY_MS)) } else { ("", Value::Null) };
    let label = if !name.is_empty() && !family.to_lowercase().contains(&name.to_lowercase()) { format!("{family} — {name}") } else { family.to_owned() };
    (label, if !name.is_empty() { name.to_owned() } else if !window.is_empty() { window.to_owned() } else { "quota".into() }, duration)
}

/// Fetches Antigravity quota summaries, falling back to per-model quotas.
pub async fn fetch_antigravity_usage(client: &Client, account: &mut Value) -> Result<Value, String> {
    let access = account["credentials"]["access"].as_str().unwrap_or("").to_owned();
    google_identity(client, account, &access, true).await;
    let body = if account["projectId"].as_str().unwrap_or("").is_empty() { json!({}) } else { json!({"project":account["projectId"]}) };
    let mut limits = Vec::new(); let mut last_status = 0;
    for endpoint in GOOGLE_ENDPOINTS {
        let (status, data) = response_json(google_request(client, &format!("{endpoint}/v1internal:retrieveUserQuotaSummary"), &access, true, &body)).await?;
        last_status = status.as_u16();
        if status == StatusCode::UNAUTHORIZED { return Err("Antigravity authentication expired (HTTP 401). Click Re-auth.".into()); }
        if !status.is_success() || data.is_null() { continue; }
        let mut buckets: Vec<(Value, String)> = Vec::new();
        for group in data["groups"].as_array().into_iter().flatten() {
            let title = group["title"].as_str().or_else(|| group["displayName"].as_str()).or_else(|| group["groupId"].as_str()).unwrap_or("");
            for bucket in group["buckets"].as_array().into_iter().flatten() { buckets.push((bucket.clone(), title.into())); }
        }
        for bucket in data["buckets"].as_array().into_iter().flatten() { buckets.push((bucket.clone(), String::new())); }
        let mut seen = HashSet::new();
        for (bucket, group) in buckets {
            let used = match google_fraction(&bucket) { Some(v) => v, None => continue };
            let id = bucket["bucketId"].as_str().or_else(|| bucket["modelId"].as_str()).or_else(|| bucket["id"].as_str()).filter(|s| !s.is_empty()).unwrap_or(if group.is_empty() { "quota" } else { &group });
            let window = bucket["window"].as_str().or_else(|| bucket["windowId"].as_str()).unwrap_or("");
            let title = bucket["displayName"].as_str().or_else(|| bucket["title"].as_str()).unwrap_or(&group);
            let (label, window, duration) = antigravity_classify(id, window, title);
            let sig = format!("{}|{}", label, bucket["resetTime"].as_str().unwrap_or(""));
            if seen.insert(sig) { let reset = if bucket["resetTime"].is_null() { &bucket["resetsAt"] } else { &bucket["resetTime"] }; limits.push(limit(id.into(), label, window, duration, used, iso(reset))); }
        }
        if !limits.is_empty() { break; }
    }
    if limits.is_empty() {
        for endpoint in GOOGLE_ENDPOINTS {
            let (status, data) = response_json(google_request(client, &format!("{endpoint}/v1internal:fetchAvailableModels"), &access, true, &body)).await?;
            if !status.is_success() { continue; }
            for (id, info) in data["models"].as_object().into_iter().flatten() {
                let q = &info["quotaInfo"]; let used = match google_fraction(q) { Some(v) => v, None => continue };
                let (label, window, mut duration) = antigravity_classify(id, q["window"].as_str().unwrap_or("5h"), info["displayName"].as_str().unwrap_or(""));
                if duration.is_null() { duration = json!(5*HOUR_MS); }
                let previous = limits.iter().position(|v| v["label"] == label);
                if previous.map(|i| used <= limits[i]["usedFraction"].as_f64().unwrap_or(0.0)).unwrap_or(false) { continue; }
                let mut reset = iso(&q["resetTime"]); if reset.is_null() { if let Some(i) = previous { reset = limits[i]["resetsAt"].clone(); } }
                let item = limit(id.clone(), label, window, duration, used, reset);
                if let Some(i) = previous { limits[i] = item; } else { limits.push(item); }
            }
            if !limits.is_empty() { break; }
        }
    }
    if limits.is_empty() { return Err(if last_status >= 400 { format!("Antigravity quota endpoint returned HTTP {last_status}.") } else { "Google Antigravity returned no active quota buckets for this account.".into() }); }
    Ok(json!({"fetchedAt":now_ms(), "limits":limits, "metadata":{"email":account["email"], "projectId":account["projectId"], "planType":account["planType"]}}))
}

/// Private device authorization state. Never serialize or log this value.
pub struct DeviceFlow {
    provider: String,
    secret_code: String,
    user_code: String,
    token_endpoint: String,
    device_id: String,
    public: Value,
    interval: u64,
}

impl DeviceFlow {
    /// Returns only user-displayable flow information, not the device code.
    pub fn session(&self) -> Value { self.public.clone() }
    pub fn interval_seconds(&self) -> u64 { self.interval }
}

/// Result of one device-code polling request. A completed account contains secrets
/// and must be passed directly to the encrypted vault, never sent to the frontend.
pub enum DevicePoll { Pending, Complete(Value) }

/// Starts a Codex, Copilot, Kimi or xAI device authorization.
/// `device_id` and `kimi_headers` must describe the same Kimi device.
pub async fn start_device_flow(client: &Client, provider: &str, device_id: &str, kimi_headers: &reqwest::header::HeaderMap) -> Result<DeviceFlow, String> {
    let (request, client_id, default_uri) = match provider {
        "codex" => (client.post("https://auth.openai.com/api/accounts/deviceauth/usercode").header("User-Agent", "ChalzTracker/2.0").json(&json!({"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"})), "app_EMoamEEZ73f0CkXaXp7hrann", "https://auth.openai.com/codex/device"),
        "copilot" => (client.post("https://github.com/login/device/code").header("Accept", "application/json").header("User-Agent", "copilot-developer-action/0.0.1").form(&[("client_id","Ov23li8tweQw6odWQebz"),("scope","read:user")]), "Ov23li8tweQw6odWQebz", "https://github.com/login/device"),
        "kimi" => (client.post("https://auth.kimi.com/api/oauth/device_authorization").headers(kimi_headers.clone()).form(&[("client_id","17e5f671-d194-4dfb-9706-5516cb48c098")]), "17e5f671-d194-4dfb-9706-5516cb48c098", ""),
        "xai" => (client.post("https://auth.x.ai/oauth2/device/code").form(&[("client_id","b1a00492-073a-47ea-816f-4c329264a828"),("scope","openid profile email offline_access grok-cli:access api:access")]), "b1a00492-073a-47ea-816f-4c329264a828", "https://auth.x.ai/device"),
        _ => return Err("Device authorization is not supported for this provider.".into()),
    };
    let _ = client_id;
    let (status, data) = response_json(request).await?;
    let secret = if provider == "codex" { data["device_auth_id"].as_str() } else { data["device_code"].as_str() };
    let secret = secret.filter(|s| !s.is_empty()).filter(|_| status.is_success()).ok_or_else(|| format!("Could not start device authorization (HTTP {}).", status.as_u16()))?;
    let user_code = data["user_code"].as_str().unwrap_or("");
    if (provider == "codex" || provider == "copilot") && user_code.is_empty() { return Err("Device authorization returned no user code.".into()); }
    let uri = if provider == "codex" { default_uri } else { data["verification_uri"].as_str().unwrap_or(default_uri) };
    let auth_url = data["verification_uri_complete"].as_str().unwrap_or(uri);
    let interval = number(&data["interval"]).unwrap_or(5.0).max(if provider == "copilot" { 5.0 } else { 4.0 }) as u64;
    let token_endpoint = if provider == "xai" {
        match response_json(client.get("https://auth.x.ai/.well-known/openid-configuration")).await {
            Ok((s, data)) if s.is_success() => data["token_endpoint"].as_str().unwrap_or("https://auth.x.ai/oauth2/token").to_owned(),
            _ => "https://auth.x.ai/oauth2/token".into(),
        }
    } else { String::new() };
    let instructions = match provider {
        "codex" => "Enter this 1-time code at auth.openai.com/codex/device in any browser or incognito window.",
        "copilot" => "Enter this verification code on github.com/login/device to connect your GitHub Copilot account.",
        "kimi" => "Approve Kimi CLI access in your browser. ChalzTracker will detect completion automatically.",
        _ => "Authorize xAI Grok CLI in your browser. ChalzTracker will connect automatically.",
    };
    Ok(DeviceFlow { provider: provider.into(), secret_code: secret.into(), user_code: user_code.into(), token_endpoint, device_id: device_id.into(), interval,
        public: json!({"provider":provider, "mode":"device", "status":"pending", "authUrl":auth_url, "userCode":if user_code.is_empty() { Value::Null } else { json!(user_code) }, "verificationUri":uri, "instructions":instructions, "acceptsManualCode":false}) })
}

/// Polls a device flow once; the caller controls cancellation, expiry and scheduling.
pub async fn poll_device_flow(client: &Client, flow: &mut DeviceFlow, kimi_headers: &reqwest::header::HeaderMap) -> Result<DevicePoll, String> {
    let request = match flow.provider.as_str() {
        "codex" => client.post("https://auth.openai.com/api/accounts/deviceauth/token").header("User-Agent", "ChalzTracker/2.0").json(&json!({"device_auth_id":flow.secret_code,"user_code":flow.user_code})),
        "copilot" => client.post("https://github.com/login/oauth/access_token").header("Accept","application/json").header("User-Agent","copilot-developer-action/0.0.1").form(&[("client_id","Ov23li8tweQw6odWQebz"),("device_code",flow.secret_code.as_str()),("grant_type","urn:ietf:params:oauth:grant-type:device_code")]),
        "kimi" => client.post("https://auth.kimi.com/api/oauth/token").headers(kimi_headers.clone()).form(&[("client_id","17e5f671-d194-4dfb-9706-5516cb48c098"),("device_code",flow.secret_code.as_str()),("grant_type","urn:ietf:params:oauth:grant-type:device_code")]),
        "xai" => client.post(&flow.token_endpoint).form(&[("client_id","b1a00492-073a-47ea-816f-4c329264a828"),("device_code",flow.secret_code.as_str()),("grant_type","urn:ietf:params:oauth:grant-type:device_code")]),
        _ => return Err("Unsupported device authorization.".into()),
    };
    let (status, mut data) = response_json(request).await?;
    if flow.provider == "codex" && status.is_success() && data["authorization_code"].is_string() && data["code_verifier"].is_string() {
        let (s, token) = response_json(client.post("https://auth.openai.com/oauth/token").form(&[("grant_type","authorization_code"),("code",data["authorization_code"].as_str().unwrap_or("")),("code_verifier",data["code_verifier"].as_str().unwrap_or("")),("redirect_uri","https://auth.openai.com/deviceauth/callback"),("client_id","app_EMoamEEZ73f0CkXaXp7hrann")])).await?;
        if !s.is_success() || token["access_token"].as_str().unwrap_or("").is_empty() { return Err(format!("OpenAI device token exchange failed (HTTP {}).", s.as_u16())); }
        data = token;
    }
    if let Some(access) = data["access_token"].as_str().filter(|s| !s.is_empty()).filter(|_| status.is_success() || flow.provider == "copilot") {
        let jwt = jwt_payload(data["id_token"].as_str().unwrap_or(access));
        let expires = if flow.provider == "copilot" && number(&data["expires_in"]).is_none() { now_ms()+365*DAY_MS } else { now_ms() + (number(&data["expires_in"]).unwrap_or(3600.0)*1000.0) as i64 - 60_000 };
        let mut credentials = json!({"type":"oauth", "access":access, "refresh":data["refresh_token"], "expires":expires});
        let mut account = json!({"provider":flow.provider, "credentials":credentials, "email":jwt["email"], "accountId":jwt["sub"]});
        match flow.provider.as_str() {
            "codex" => {
                let access_jwt = jwt_payload(access);
                let auth = if access_jwt["https://api.openai.com/auth"].is_object() { &access_jwt["https://api.openai.com/auth"] } else { &jwt["https://api.openai.com/auth"] };
                let profile = if access_jwt["https://api.openai.com/profile"].is_object() { &access_jwt["https://api.openai.com/profile"] } else { &jwt["https://api.openai.com/profile"] };
                account["accountId"] = auth["chatgpt_account_id"].as_str().or_else(|| jwt["chatgpt_account_id"].as_str()).map(|s| json!(s)).unwrap_or(Value::Null);
                account["planType"] = auth["chatgpt_plan_type"].clone();
                account["email"] = profile["email"].as_str().or_else(|| jwt["email"].as_str()).or_else(|| access_jwt["email"].as_str()).map(|s| json!(s)).unwrap_or(Value::Null);
            }
            "copilot" => if let Ok((s, user)) = response_json(client.get("https://api.github.com/user").bearer_auth(access).header("Accept","application/vnd.github+json").header("User-Agent","ChalzTracker/2.0")).await {
                if s.is_success() { if let Some(login) = user["login"].as_str() {
                    account["email"] = user["email"].as_str().map(|s| json!(s)).unwrap_or_else(|| json!(format!("@{login}")));
                    account["accountId"] = if user["id"].is_null() { json!(login) } else if let Some(id) = user["id"].as_str() { json!(id) } else { json!(user["id"].to_string()) };
                    account["orgName"] = json!(format!("@{login}"));
                } }
            },
            "kimi" => { credentials["deviceId"] = json!(flow.device_id); account["credentials"] = credentials; if account["accountId"].is_null() { account["accountId"] = json!(flow.device_id.chars().take(12).collect::<String>()); } },
            "xai" => { account["credentials"]["tokenEndpoint"] = json!(flow.token_endpoint); if let Ok((s, user)) = response_json(client.get("https://auth.x.ai/oauth2/userinfo").bearer_auth(access)).await { if s.is_success() { if !user["email"].is_null() { account["email"] = user["email"].clone(); } if !user["sub"].is_null() { account["accountId"] = user["sub"].clone(); } } } },
            _ => {}
        }
        return Ok(DevicePoll::Complete(account));
    }
    if flow.provider == "codex" { return Ok(DevicePoll::Pending); }
    if let Some(error) = data["error"].as_str() {
        if error == "slow_down" { if flow.provider == "copilot" { flow.interval += 5; } return Ok(DevicePoll::Pending); }
        if error != "authorization_pending" { return Err("Device authorization failed or expired.".into()); }
    }
    Ok(DevicePoll::Pending)
}

async fn cursor_identity(client: &Client, access: &str) -> Value {
    let jwt = jwt_payload(access); let sub = jwt["sub"].as_str().unwrap_or("");
    let id = sub.split_once('|').map(|(_, id)| id).unwrap_or(sub);
    let mut info = json!({"accountId":if id.is_empty() { Value::Null } else { json!(id) }, "email":jwt["email"], "planType":null});
    if let Ok((status, data)) = response_json(client.post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe").bearer_auth(access).header("Connect-Protocol-Version", "1").json(&json!({}))).await {
        if status.is_success() { if info["email"].is_null() { info["email"] = data["email"].clone(); } info["planType"] = if data["membershipType"].is_null() { data["subscriptionStatus"].clone() } else { data["membershipType"].clone() }; }
    }
    info
}

async fn claude_identity(client: &Client, access: &str, token: &Value) -> Value {
    let account = &token["account"]; let org = &token["organization"];
    let mut info = json!({"email":if account["email_address"].is_null() { &account["email"] } else { &account["email_address"] }, "accountId":account["uuid"], "orgId":org["uuid"], "orgName":org["name"], "planType":org["organization_type"]});
    if !info["email"].is_null() && !info["accountId"].is_null() { return info; }
    if let Ok((status, data)) = response_json(client.get("https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-4-6").bearer_auth(access).header("anthropic-beta", "oauth-2025-04-20").header("User-Agent", "claude-cli/2.1.280 (external, cli)")).await {
        if status.is_success() {
            let acct = if data["account"].is_object() { &data["account"] } else { &data["user"] }; let org = &data["organization"];
            for (key, val) in [("email", if acct["email_address"].is_null() { &acct["email"] } else { &acct["email_address"] }), ("accountId", if acct["uuid"].is_null() { &acct["id"] } else { &acct["uuid"] }), ("orgId", if org["uuid"].is_null() { &org["id"] } else { &org["uuid"] }), ("orgName", &org["name"]), ("planType", if org["rate_limit_tier"].is_null() { &org["organization_type"] } else { &org["rate_limit_tier"] })] { if info[key].is_null() { info[key] = val.clone(); } }
        }
    }
    info
}

/// Validates a direct API-key/token login. Returns the private account payload and,
/// for validated Z.AI/MiniMax keys, the initial quota report for vault persistence.
pub async fn authorize_direct_key(client: &Client, provider: &str, key: &str) -> Result<(Value, Option<Value>), String> {
    let key = key.trim(); if key.is_empty() { return Err("Please enter a valid API key / token.".into()); }
    match provider {
        "cursor" => {
            let (status, data) = response_json(client.post("https://api2.cursor.sh/auth/exchange_user_api_key").bearer_auth(key).json(&json!({}))).await?;
            let access = data["accessToken"].as_str().or_else(|| data["access_token"].as_str()).filter(|s| !s.is_empty()).filter(|_| status.is_success()).ok_or_else(|| format!("Cursor rejected API key (HTTP {}). Make sure it starts with crsr_...", status.as_u16()))?;
            let refresh = data["refreshToken"].as_str().or_else(|| data["refresh_token"].as_str());
            let expires = jwt_payload(access)["exp"].as_i64().map(|s| s*1000-60_000).unwrap_or_else(|| now_ms()+HOUR_MS);
            let mut account = cursor_identity(client, access).await; account["provider"] = json!(provider);
            account["credentials"] = json!({"type":"oauth","access":access,"refresh":refresh,"expires":expires}); Ok((account,None))
        }
        "claude" => {
            let mut account = claude_identity(client, key, &Value::Null).await; account["provider"] = json!(provider);
            account["credentials"] = json!({"type":"oauth","access":key,"refresh":null,"expires":now_ms()+365*DAY_MS}); Ok((account,None))
        }
        "copilot" => {
            let (status, user) = response_json(client.get("https://api.github.com/user").bearer_auth(key).header("Accept","application/vnd.github+json").header("User-Agent","ChalzTracker/2.0")).await?;
            let login = user["login"].as_str().filter(|_| status.is_success()).ok_or_else(|| format!("GitHub rejected token (HTTP {}).", status.as_u16()))?;
            let id = if user["id"].is_null() { login.to_owned() } else if let Some(id) = user["id"].as_str() { id.to_owned() } else { user["id"].to_string() };
            Ok((json!({"provider":provider,"email":user["email"].as_str().map(str::to_owned).unwrap_or_else(|| format!("@{login}")),"accountId":id,"orgName":format!("@{login}"),"credentials":{"type":"api_key","apiKey":key}}),None))
        }
        "zai" | "minimax" => {
            use sha2::{Digest, Sha256};
            let digest = Sha256::digest(key.as_bytes()); let fingerprint = digest[..5].iter().map(|b| format!("{b:02x}")).collect::<String>();
            let mut account = json!({"provider":provider,"planType":null,"credentials":{"type":"api_key","apiKey":key}});
            let report = if provider == "zai" { fetch_zai_usage(client, &mut account).await? } else { fetch_minimax_usage(client, &account).await? };
            account["accountId"] = json!(format!("{provider}_{fingerprint}"));
            if account["planType"].is_null() { account["planType"] = report["metadata"]["planType"].clone(); }
            Ok((account,Some(report)))
        }
        _ => Err("Direct API key mode is not supported for this provider.".into()),
    }
}

/// Private PKCE state; it contains a verifier and must never be serialized or logged.
pub struct BrowserFlow { provider: String, state: String, verifier: String, redirect_uri: String, public: Value }
impl BrowserFlow {
    pub fn session(&self) -> Value { self.public.clone() }

    /// Checks a callback state without exposing the expected value.
    pub fn matches_state(&self, state: Option<&str>) -> bool {
        state == Some(self.state.as_str())
    }
}

fn google_client(provider: &str) -> Result<(String, String), String> {
    if provider == "antigravity" {
        return match (option_env!("CHALZ_ANTIGRAVITY_CLIENT_ID"), option_env!("CHALZ_ANTIGRAVITY_CLIENT_SECRET")) {
            (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => Ok((id.into(), secret.into())),
            _ => Err("This build of ChalzTracker has no Google OAuth client for Antigravity. Rebuild it with CHALZ_ANTIGRAVITY_CLIENT_ID and CHALZ_ANTIGRAVITY_CLIENT_SECRET set.".into()),
        };
    }
    let id = std::env::var("CHALZ_GEMINI_CLI_CLIENT_ID").unwrap_or_default();
    let secret = std::env::var("CHALZ_GEMINI_CLI_CLIENT_SECRET").unwrap_or_default();
    if id.is_empty() || secret.is_empty() { return Err("Google OAuth client is not configured. Set CHALZ_GEMINI_CLI_CLIENT_ID and CHALZ_GEMINI_CLI_CLIENT_SECRET, then restart ChalzTracker.".into()); }
    Ok((id, secret))
}

/// Creates a PKCE authorization URL. The caller owns the loopback listener and must
/// choose the actual bound redirect URI before starting; callbacks require state.
pub fn start_browser_flow(provider: &str, redirect_uri: &str) -> Result<BrowserFlow, String> {
    use base64::Engine; use rand::RngCore; use sha2::{Digest, Sha256};
    let mut bytes = [0u8; 32]; rand::rngs::OsRng.fill_bytes(&mut bytes);
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut state_bytes = [0u8; 16]; rand::rngs::OsRng.fill_bytes(&mut state_bytes);
    let state = state_bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let mut url = match provider {
        "antigravity" | "gemini-cli" => url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth"),
        "codex" => url::Url::parse("https://auth.openai.com/oauth/authorize"),
        "claude" => url::Url::parse("https://claude.ai/oauth/authorize"),
        _ => return Err("Browser OAuth is not supported for this provider.".into()),
    }.map_err(|_| "Invalid authorization endpoint.".to_owned())?;
    {
        let mut q = url.query_pairs_mut();
        match provider {
            "antigravity" | "gemini-cli" => {
                let (id, _) = google_client(provider)?;
                let scope = if provider == "antigravity" { "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs https://www.googleapis.com/auth/aicode" } else { "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile" };
                q.append_pair("client_id",&id).append_pair("response_type","code").append_pair("redirect_uri",redirect_uri).append_pair("scope",scope).append_pair("code_challenge",&challenge).append_pair("code_challenge_method","S256").append_pair("state",&state).append_pair("access_type","offline").append_pair("prompt","consent select_account");
            }
            "codex" => { q.append_pair("response_type","code").append_pair("client_id","app_EMoamEEZ73f0CkXaXp7hrann").append_pair("redirect_uri",redirect_uri).append_pair("scope","openid profile email offline_access api.connectors.read api.connectors.invoke").append_pair("code_challenge",&challenge).append_pair("code_challenge_method","S256").append_pair("state",&state).append_pair("id_token_add_organizations","true").append_pair("codex_cli_simplified_flow","true").append_pair("originator","codex_cli_rs").append_pair("prompt","login"); }
            "claude" => { q.append_pair("code","true").append_pair("client_id","9d1c250a-e61b-44d9-88ed-5944d1962f5e").append_pair("response_type","code").append_pair("redirect_uri",redirect_uri).append_pair("scope","org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload").append_pair("code_challenge",&challenge).append_pair("code_challenge_method","S256").append_pair("state",&state); }
            _ => unreachable!(),
        }
    }
    Ok(BrowserFlow { provider:provider.into(), state, verifier, redirect_uri:redirect_uri.into(), public:json!({"provider":provider,"mode":"browser","status":"pending","authUrl":url.as_str(),"userCode":null,"verificationUri":null,"acceptsManualCode":true}) })
}

/// Completes a browser or manually submitted PKCE code. Callback callers MUST pass
/// `manual = false` and the received state; manual code paste permits absent state.
pub async fn complete_browser_flow(client: &Client, flow: &BrowserFlow, code: &str, state: Option<&str>, manual: bool) -> Result<Value, String> {
    if code.trim().is_empty() { return Err("Missing authorization code.".into()); }
    if (!manual || state.is_some()) && state != Some(flow.state.as_str()) { return Err("OAuth state mismatch.".into()); }
    let request = match flow.provider.as_str() {
        "antigravity" | "gemini-cli" => { let (id,secret) = google_client(&flow.provider)?; client.post("https://oauth2.googleapis.com/token").form(&[("client_id",id.as_str()),("client_secret",secret.as_str()),("code",code),("grant_type","authorization_code"),("redirect_uri",flow.redirect_uri.as_str()),("code_verifier",flow.verifier.as_str())]) },
        "codex" => client.post("https://auth.openai.com/oauth/token").form(&[("grant_type","authorization_code"),("client_id","app_EMoamEEZ73f0CkXaXp7hrann"),("code",code),("code_verifier",flow.verifier.as_str()),("redirect_uri",flow.redirect_uri.as_str())]),
        "claude" => client.post("https://api.anthropic.com/v1/oauth/token").header("anthropic-beta","oauth-2025-04-20").header("User-Agent","anthropic-sdk-typescript/0.112.1 userOAuthProvider").json(&json!({"grant_type":"authorization_code","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e","code":code,"state":state.unwrap_or(&flow.state),"redirect_uri":flow.redirect_uri,"code_verifier":flow.verifier})),
        _ => return Err("Unsupported browser authorization.".into()),
    };
    let (status, token) = response_json(request).await?;
    let access = token["access_token"].as_str().filter(|s| !s.is_empty()).filter(|_| status.is_success()).ok_or_else(|| format!("OAuth token exchange failed (HTTP {}).", status.as_u16()))?;
    let credentials = json!({"type":"oauth","access":access,"refresh":token["refresh_token"],"expires":now_ms()+(number(&token["expires_in"]).unwrap_or(3600.0)*1000.0) as i64-60_000});
    let mut account = json!({"provider":flow.provider,"credentials":credentials});
    if flow.provider == "antigravity" || flow.provider == "gemini-cli" {
        google_identity(client, &mut account, access, flow.provider == "antigravity").await;
        account["accountId"] = if !account["email"].is_null() { account["email"].clone() } else { account["projectId"].clone() };
    } else if flow.provider == "claude" {
        let identity = claude_identity(client, access, &token).await;
        for key in ["email","accountId","orgId","orgName","planType"] { account[key] = identity[key].clone(); }
    } else {
        let jwt = jwt_payload(access); let id = jwt_payload(token["id_token"].as_str().unwrap_or(""));
        let auth = if jwt["https://api.openai.com/auth"].is_object() { &jwt["https://api.openai.com/auth"] } else { &id["https://api.openai.com/auth"] };
        let profile = if jwt["https://api.openai.com/profile"].is_object() { &jwt["https://api.openai.com/profile"] } else { &id["https://api.openai.com/profile"] };
        account["accountId"] = auth["chatgpt_account_id"].as_str().or_else(|| id["chatgpt_account_id"].as_str()).map(|s| json!(s)).unwrap_or(Value::Null);
        account["planType"] = auth["chatgpt_plan_type"].clone();
        account["email"] = profile["email"].as_str().or_else(|| id["email"].as_str()).or_else(|| jwt["email"].as_str()).map(|s| json!(s)).unwrap_or(Value::Null);
    }
    Ok(account)
}

/// Parses a pasted callback URL, query string, Claude code#state, or bare code.
/// Returned values contain authorization secrets and must never be logged.
pub fn parse_manual_auth_input(raw: &str) -> Result<(Option<String>, Option<String>), String> {
    let input = raw.trim();
    if input.is_empty() { return Ok((None, None)); }
    if input.starts_with("http://") || input.starts_with("https://") {
        if let Ok(url) = url::Url::parse(input) {
            let mut code = None; let mut state = None; let mut error = false;
            for (key, value) in url.query_pairs() { match key.as_ref() { "code" if code.is_none() => code = Some(value.into_owned()), "state" if state.is_none() => state = Some(value.into_owned()), "error" => error = true, _ => {} } }
            if error { return Err("OAuth authorization was rejected.".into()); }
            if code.is_some() { return Ok((code, state)); }
        }
    }
    if input.contains("code=") {
        let mut code = None; let mut state = None;
        for (key, value) in url::form_urlencoded::parse(input.trim_start_matches('?').as_bytes()) {
            match key.as_ref() { "code" if code.is_none() => code = Some(value.into_owned()), "state" if state.is_none() => state = Some(value.into_owned()), _ => {} }
        }
        if code.is_some() { return Ok((code, state)); }
    }
    if let Some((code, state)) = input.split_once('#') {
        return Ok(((if code.trim().is_empty() { None } else { Some(code.trim().to_owned()) }), if state.trim().is_empty() { None } else { Some(state.trim().to_owned()) }));
    }
    Ok((Some(input.into()), None))
}

/// Private Cursor DeepControl polling state, containing a PKCE verifier.
pub struct CursorFlow { uuid: String, verifier: String, public: Value }
impl CursorFlow { pub fn session(&self) -> Value { self.public.clone() } }

pub fn start_cursor_flow() -> CursorFlow {
    use base64::Engine; use rand::RngCore; use sha2::{Digest, Sha256};
    let mut bytes = [0u8; 32]; rand::rngs::OsRng.fill_bytes(&mut bytes);
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let uuid = uuid::Uuid::new_v4().to_string();
    let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("challenge",&challenge).append_pair("uuid",&uuid).append_pair("mode","login").append_pair("redirectTarget","cli").finish();
    CursorFlow { uuid, verifier, public:json!({"provider":"cursor","mode":"browser","status":"pending","authUrl":format!("https://cursor.com/loginDeepControl?{query}"),"userCode":null,"verificationUri":null,"acceptsManualCode":false,"instructions":"Click \"Yes, Log In\" on cursor.com in your browser. ChalzTracker is polling automatically."}) }
}

/// Polls Cursor once; transient request failures should be retried by the caller.
pub async fn poll_cursor_flow(client: &Client, flow: &CursorFlow) -> Result<DevicePoll, String> {
    let (status, data) = response_json(client.get("https://api2.cursor.sh/auth/poll").query(&[("uuid",flow.uuid.as_str()),("verifier",flow.verifier.as_str())]).header("Accept","application/json")).await?;
    if !status.is_success() { return Ok(DevicePoll::Pending); }
    let access = match data["accessToken"].as_str().filter(|s| !s.is_empty()) { Some(s) => s, None => return Ok(DevicePoll::Pending) };
    let expires = jwt_payload(access)["exp"].as_i64().map(|s| s*1000-60_000).unwrap_or_else(|| now_ms()+HOUR_MS);
    let mut account = cursor_identity(client, access).await; account["provider"] = json!("cursor");
    account["credentials"] = json!({"type":"oauth","access":access,"refresh":data["refreshToken"],"expires":expires});
    Ok(DevicePoll::Complete(account))
}

/// Redeems the soonest-expiring Codex reset credit and retrieves updated usage.
/// The account must already have fresh credentials; serialize refresh separately.
pub async fn redeem_codex_banked_reset(client: &Client, account: &mut Value) -> Result<Value, String> {
    let headers = codex_headers(account)?;
    let banked = codex_banked_resets(client, account, headers.clone(), None, true).await;
    let banked = banked.filter(|b| b["count"].as_u64().unwrap_or(0) > 0).ok_or_else(|| "No available banked reset credits found on this Codex account.".to_owned())?;
    let mut body = json!({"redeem_request_id": uuid::Uuid::new_v4().to_string()});
    if let Some(id) = banked["items"][0]["id"].as_str().filter(|s| !s.is_empty()) { body["credit_id"] = json!(id); }
    let (status, _) = response_json(client.post("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume").headers(headers).json(&body)).await?;
    if !status.is_success() { return Err(format!("Codex rejected banked reset redemption (HTTP {}).", status.as_u16())); }
    invalidate_codex_banked_cache(account);
    fetch_codex_usage_with_options(client, account, true).await
}

/// Dispatches the implemented quota integrations after a serialized credential refresh.
/// Unsupported providers are reported explicitly rather than returning synthetic data.
pub async fn fetch_provider_usage(client: &Client, account: &mut Value, kimi_headers: &reqwest::header::HeaderMap) -> Result<Value, String> {
    ensure_fresh_credentials(client, account, kimi_headers).await?;
    match account["provider"].as_str().unwrap_or("") {
        "antigravity" => fetch_antigravity_usage(client, account).await,
        "codex" => fetch_codex_usage(client, account).await,
        "claude" => fetch_claude_usage(client, account).await,
        "cursor" => fetch_cursor_usage(client, account).await,
        "gemini-cli" => fetch_gemini_usage(client, account).await,
        "copilot" => fetch_copilot_usage(client, account).await,
        "kimi" => fetch_kimi_usage(client, account, kimi_headers).await,
        "xai" => fetch_xai_usage(client, account).await,
        "zai" => fetch_zai_usage(client, account).await,
        "minimax" => fetch_minimax_usage(client, account).await,
        provider => Err(format!("Quota retrieval is not implemented for provider {provider}.")),
    }
}

#[cfg(test)]
mod cursor_period_tests {
    use super::cursor_period_limits;
    use serde_json::{json, Value};

    #[test]
    fn maps_real_usage_percentages_and_reset() {
        let limits = cursor_period_limits(&json!({"billingCycleEnd":"1771077734000", "planUsage":{"autoPercentUsed":12.5,"apiPercentUsed":46.444}, "spendLimitUsage":{"individualUsed":250,"individualLimit":10000}}), &Value::Null);
        assert_eq!(limits[0]["id"], "cursor_models");
        assert_eq!(limits[0]["usedFraction"], 0.125);
        assert!((limits[1]["usedFraction"].as_f64().unwrap() - 0.46444).abs() < 1e-10);
        assert_eq!(limits[0]["resetsAt"], "2026-02-14T14:02:14.000Z");
        assert_eq!(limits[2]["usedFraction"], 0.025);
    }

    #[test]
    fn uses_combined_usage_when_individual_pools_are_absent() {
        let limits = cursor_period_limits(&json!({"planUsage":{"totalPercentUsed":75}}), &json!("2026-12-01T00:00:00.000Z"));
        assert_eq!(limits[0]["id"], "included_plan");
        assert_eq!(limits[0]["usedFraction"], 0.75);
        assert_eq!(limits[0]["resetsAt"], "2026-12-01T00:00:00.000Z");
    }

    #[test]
    fn rejects_missing_included_usage_instead_of_inventing_a_quota() {
        assert!(cursor_period_limits(&json!({"spendLimitUsage":{"individualUsed":0,"individualLimit":10000}}), &Value::Null).is_empty());
        assert!(cursor_period_limits(&json!({"planUsage":{"includedSpend":10,"limit":0}}), &Value::Null).is_empty());
    }
}

#[cfg(test)]
mod google_plan_tests {
    use super::google_plan;
    use serde_json::json;

    #[test]
    fn prefers_the_paid_subscription_over_the_code_assist_tier() {
        let data = json!({"currentTier":{"id":"free-tier","name":"Antigravity"}, "paidTier":{"id":"g1-pro-tier","name":"Google AI Pro"}});
        assert_eq!(google_plan(&data).as_deref(), Some("Google AI Pro"));
    }

    #[test]
    fn reports_free_instead_of_the_product_name_without_a_subscription() {
        assert_eq!(google_plan(&json!({"currentTier":{"id":"free-tier","name":"Antigravity"}})).as_deref(), Some("Free"));
        assert_eq!(google_plan(&json!({"currentTier":{"id":"standard-tier","name":"Gemini Code Assist Standard"}})).as_deref(), Some("Gemini Code Assist Standard"));
        assert_eq!(google_plan(&json!({})), None);
    }
}
