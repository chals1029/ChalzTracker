//! Account vault. The caller supplies the data directory; no home directory is consulted.
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

const MAX_SNAPSHOTS: usize = 1400;
const MAX_EVENTS: usize = 500;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
/// Rolling windows hover around a threshold as old usage ages out, so a sent alert stays
/// sent until usage falls this far below the threshold or the window resets.
const ALERT_REARM_MARGIN: f64 = 0.05;
fn now() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }
fn text<'a>(v: &'a Value, key: &str) -> &'a str { v.get(key).and_then(Value::as_str).unwrap_or("") }
fn number(v: &Value, key: &str) -> Option<f64> { v.get(key).and_then(Value::as_f64).filter(|x| x.is_finite()) }
fn truth(v: &Value, key: &str) -> bool { v.get(key).and_then(Value::as_bool).unwrap_or(false) }
fn date(v: &Value) -> Option<i64> { v.as_i64().or_else(|| v.as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis()))) }
fn random_id(bytes: usize) -> String { use rand::RngCore; let mut b = vec![0; bytes]; rand::thread_rng().fill_bytes(&mut b); b.iter().map(|n| format!("{n:02x}")).collect() }
fn read_store(path: &Path, history: bool) -> io::Result<Option<Value>> {
    let raw = match fs::read(path) { Ok(v) => v, Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None), Err(e) => return Err(e) };
    let v: Value = serde_json::from_slice(&raw).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let valid = if history { v.is_object() && v.get("snapshots").and_then(Value::as_array).is_some() && v.get("events").and_then(Value::as_array).is_some() } else { v.is_object() && v.get("accounts").and_then(Value::as_array).is_some() && v.get("settings").map_or(true, Value::is_object) && v["accounts"].as_array().unwrap().iter().all(|a| a.is_object() && a.get("id").and_then(Value::as_str).is_some() && a.get("provider").and_then(Value::as_str).is_some()) };
    if !valid { return Err(io::Error::new(io::ErrorKind::InvalidData, "malformed vault file")); }
    Ok(Some(v))
}
fn save(path: &Path, value: &Value, history: bool) -> io::Result<()> {
    // Recheck immediately before writing so a malformed file is never knowingly replaced.
    read_store(path, history)?;
    let parent = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent"))?;
    fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    use std::io::Write;
    serde_json::to_writer_pretty(&mut file, value).map_err(io::Error::other)?;
    file.flush()?;
    file.persist(path).map_err(|e| e.error)?;
    Ok(())
}
fn defaults() -> Value { json!({"alertsEnabled":true,"resetAlertsEnabled":true,"bankedAlertsEnabled":true,"thresholdAlertsEnabled":true,"soundEnabled":true,"soundPack":"cyber","warnThreshold":0.8,"critThreshold":0.95}) }
fn clip(s: &str, n: usize) -> String { s.trim().chars().take(n).collect() }
fn trim_tail(a: &mut Vec<Value>, max: usize) { if a.len() > max { a.drain(..a.len()-max); } }

pub struct ChalzVault {
    dir: PathBuf,
    pub accounts: Vec<Value>,
    pub settings: Value,
    pub snapshots: Vec<Value>,
    pub events: Vec<Value>,
    last_levels: HashMap<String, u8>,
    last_used: HashMap<String, f64>,
    last_reset: HashMap<String, i64>,
    last_banked: HashMap<String, f64>,
    expiring_warned: std::collections::HashSet<String>,
}
impl ChalzVault {
    pub fn new(dir: PathBuf) -> io::Result<Self> {
        let store = read_store(&dir.join("accounts.json"), false)?;
        let hist = read_store(&dir.join("history.json"), true)?;
        let mut settings = defaults();
        if let Some(s) = store.as_ref().and_then(|v| v.get("settings")) {
            for k in ["alertsEnabled", "resetAlertsEnabled", "bankedAlertsEnabled", "thresholdAlertsEnabled", "soundEnabled"] { if s.get(k).and_then(Value::as_bool).is_some() { settings[k] = s[k].clone(); } }
            if ["cyber", "crystal", "arcade", "minimal", "off"].contains(&text(s,"soundPack")) { settings["soundPack"] = s["soundPack"].clone(); }
        }
        let mut vault = Self { dir, accounts: store.as_ref().and_then(|v| v["accounts"].as_array()).cloned().unwrap_or_default(), settings, snapshots: hist.as_ref().and_then(|v| v["snapshots"].as_array()).cloned().unwrap_or_default(), events: hist.as_ref().and_then(|v| v["events"].as_array()).cloned().unwrap_or_default(), last_levels: HashMap::new(), last_used: HashMap::new(), last_reset: HashMap::new(), last_banked: HashMap::new(), expiring_warned: std::collections::HashSet::new() };
        trim_tail(&mut vault.snapshots, MAX_SNAPSHOTS); trim_tail(&mut vault.events, MAX_EVENTS);
        for a in &vault.accounts { let id = text(a,"id"); if let Some(c) = number(&a["lastReport"]["bankedResets"],"count") { vault.last_banked.insert(id.to_owned(),c); } if let Some(limits) = a["lastReport"]["limits"].as_array() { for l in limits { let name = if !text(l,"label").is_empty() { text(l,"label") } else if !text(l,"id").is_empty() { text(l,"id") } else { "limit" }; let key = format!("{id}:{name}"); if let Some(u) = number(l,"usedFraction") { vault.last_used.insert(key.clone(),u); vault.last_levels.insert(key.clone(), l["alertLevel"].as_u64().map_or(if u >= 0.95 {2} else if u >= 0.8 {1} else {0}, |level| level.min(2) as u8)); } if let Some(d) = date(&l["resetsAt"]) { vault.last_reset.insert(key,d); } } } }
        Ok(vault)
    }
    pub fn save_accounts(&self) -> io::Result<()> { save(&self.dir.join("accounts.json"), &json!({"version":2,"updatedAt":now(),"settings":self.settings,"accounts":self.accounts}), false) }
    pub fn save_history(&self) -> io::Result<()> { save(&self.dir.join("history.json"), &json!({"version":1,"updatedAt":now(),"snapshots":self.snapshots,"events":self.events}), true) }
    pub fn get_account_by_id(&self, id: &str) -> Option<&Value> { self.accounts.iter().find(|a| text(a,"id") == id) }
    pub fn record_event(&mut self, kind: &str, provider: &str, id: Option<&str>, label: &str, detail: &str, extra: &Value) -> io::Result<Value> {
        let mut e = json!({"id":random_id(6),"timestamp":now(),"type":kind,"provider":if provider.is_empty(){"system"}else{provider},"accountId":id,"label":if label.is_empty(){if provider.is_empty(){"Account"}else{provider}}else{label},"detail":detail});
        if let Some(m) = extra.as_object() { e.as_object_mut().unwrap().extend(m.clone()); }
        self.events.push(e.clone()); trim_tail(&mut self.events,MAX_EVENTS); self.save_history()?; Ok(e)
    }
    pub fn update_settings(&mut self, patch: &Value) -> io::Result<Value> {
        for k in ["alertsEnabled","resetAlertsEnabled","bankedAlertsEnabled","thresholdAlertsEnabled","soundEnabled"] { if patch.get(k).and_then(Value::as_bool).is_some() { self.settings[k] = patch[k].clone(); } }
        if truth(patch,"soundEnabled") && text(&self.settings,"soundPack") == "off" { self.settings["soundPack"] = json!("cyber"); }
        let pack = text(patch,"soundPack"); if ["cyber","crystal","arcade","minimal","off"].contains(&pack) { self.settings["soundPack"] = json!(pack); self.settings["soundEnabled"] = json!(pack != "off"); }
        if ["resetAlertsEnabled","bankedAlertsEnabled","thresholdAlertsEnabled"].iter().any(|k| patch.get(k).and_then(Value::as_bool).is_some()) { self.settings["alertsEnabled"] = json!(truth(&self.settings,"resetAlertsEnabled") || truth(&self.settings,"bankedAlertsEnabled") || truth(&self.settings,"thresholdAlertsEnabled")); }
        self.save_accounts()?; Ok(self.settings.clone())
    }
    pub fn update_account_meta(&mut self, id: &str, patch: &Value) -> io::Result<Option<Value>> {
        let Some(a) = self.accounts.iter_mut().find(|a| text(a,"id") == id) else { return Ok(None) };
        if !text(patch,"label").trim().is_empty() { a["label"] = json!(clip(text(patch,"label"),64)); }
        if let Some(s) = patch.get("tag").and_then(Value::as_str) { a["tag"] = json!(clip(s,24)); }
        for k in ["pinned","enabled"] { if patch.get(k).and_then(Value::as_bool).is_some() { a[k] = patch[k].clone(); } }
        a["updatedAt"] = json!(now()); let result = a.clone(); self.save_accounts()?; Ok(Some(result))
    }
    pub fn remove_account(&mut self, id: &str) -> io::Result<Option<Value>> {
        let Some(i) = self.accounts.iter().position(|a| text(a,"id") == id) else { return Ok(None) };
        let a = self.accounts.remove(i); self.save_accounts()?; self.record_event("removed",text(&a,"provider"),Some(id),text(&a,"label"),"Removed account from vault",&json!({}))?; Ok(Some(a))
    }
    pub fn upsert_account(&mut self, input: &Value) -> io::Result<Value> {
        let provider = text(input,"provider"); let name = if text(input,"providerName").is_empty() { provider } else { text(input,"providerName") };
        let email = text(input,"email").trim().to_lowercase(); let acct = text(input,"accountId").trim(); let org = text(input,"orgId").trim();
        let index = self.accounts.iter().position(|a| !text(input,"reauthAccountId").is_empty() && text(a,"id") == text(input,"reauthAccountId")).or_else(|| self.accounts.iter().position(|a| {
            if text(a,"provider") != provider { return false; }
            let same_org = org.is_empty() || text(a,"orgId").is_empty() || text(a,"orgId") == org;
            (!acct.is_empty() && text(a,"accountId") == acct && same_org) || (!email.is_empty() && text(a,"email").to_lowercase() == email && same_org && (acct.is_empty() || text(a,"accountId").is_empty() || text(a,"accountId") == acct)) || (text(&input["credentials"],"type") == "api_key" && !text(&input["credentials"],"apiKey").is_empty() && text(&a["credentials"],"apiKey") == text(&input["credentials"],"apiKey"))
        }));
        if text(input,"reauthAccountId").is_empty() { if let Some(i)=index { return Ok(json!({"account":self.accounts[i],"created":false,"duplicate":true})); } }
        let created = index.is_none();
        let idx = if let Some(i)=index { i } else {
            let same: Vec<_> = self.accounts.iter().filter(|a| text(a,"provider") == provider).collect();
            let plan = text(input,"planType").trim().replace('_'," "); let low = plan.to_lowercase(); let suffix = if plan.is_empty() || low == name.to_lowercase() || low.starts_with(&format!("{} ",name.to_lowercase())) || low == provider.to_lowercase() { String::new() } else { format!(" ({plan})") };
            let label = if !text(input,"label").trim().is_empty() { clip(text(input,"label"),64) } else if same.is_empty() { format!("{name}{suffix}") } else { let mut n = same.len()+1; loop { let s = format!("{name} #{n}{suffix}"); if !same.iter().any(|a| text(a,"label").eq_ignore_ascii_case(&s)) { break s; } n+=1; } };
            self.accounts.push(json!({"id":random_id(12),"provider":provider,"label":label,"tag":"","pinned":false,"enabled":true,"email":null,"accountId":null,"orgId":null,"orgName":null,"projectId":null,"planType":null,"credentials":{},"lastReport":null,"lastError":null,"createdAt":now(),"updatedAt":now()})); self.accounts.len()-1
        };
        let a = &mut self.accounts[idx];
        if !text(input,"label").trim().is_empty() { a["label"] = json!(clip(text(input,"label"),64)); }
        if let Some(t) = input.get("tag").and_then(Value::as_str) { a["tag"] = json!(clip(t,24)); }
        for (k,v) in [("email",email.as_str()),("accountId",acct),("orgId",org)] { if !v.is_empty() { a[k]=json!(v); } }
        for k in ["orgName","projectId","planType"] { if !text(input,k).is_empty() { a[k]=input[k].clone(); } }
        if let Some(c) = input.get("credentials").and_then(Value::as_object) { if !a["credentials"].is_object() { a["credentials"] = json!({}); } a["credentials"].as_object_mut().unwrap().extend(c.clone()); }
        a["enabled"]=json!(true); a["lastError"]=Value::Null; a["updatedAt"]=json!(now()); let result=a.clone(); self.save_accounts()?;
        self.record_event(if created {"signin"} else {"reauth"},provider,Some(text(&result,"id")),text(&result,"label"),&if created {format!("Connected {name} account")} else {"Updated account credentials".into()},&json!({}))?;
        Ok(json!({"account":result,"created":created,"duplicate":false}))
    }
}

pub fn clean_display_label(label: &str, provider: &str) -> String {
    let raw = label.trim();
    if !raw.ends_with(')') { return raw.to_owned(); }
    let Some(pos) = raw.rfind('(') else { return raw.to_owned() }; let base=raw[..pos].trim(); let paren=raw[pos+1..raw.len()-1].trim();
    if base.is_empty() || paren.is_empty() || paren.contains('(') || paren.contains(')') { return raw.to_owned(); }
    let p=paren.to_lowercase(); let prov=provider.to_lowercase();
    if [prov.clone(),prov.replace('-'," "),format!("google {prov}"),"antigravity".into(),"google antigravity".into(),"antigravity ide".into(),"cursor".into(),"codex".into(),"openai codex".into(),"claude".into(),"gemini cli".into(),"github copilot".into(),"kimi code".into(),"xai grok".into(),"minimax".into()].contains(&p) { return base.into(); }
    for prefix in ["google antigravity ","antigravity ","openai codex ","codex ","cursor ","claude ","gemini cli "] { if p.starts_with(prefix) { let rest=paren[prefix.len()..].trim(); return if rest.is_empty() || ["ide","default","standard","user","tier"].contains(&rest.to_lowercase().as_str()) { base.into() } else { format!("{base} ({rest})") }; } }
    raw.into()
}
pub fn enrich_limit_with_pace(limit: &Value, at: i64) -> Value {
    let mut out=limit.clone(); if !out.is_object() { return out; }
    let used=number(limit,"usedFraction").map(|x| x.clamp(0.0,1.0)); out["usedFraction"]=json!(used); if out.get("resetsAt").is_none() { out["resetsAt"]=Value::Null; }
    let raw=format!("{} {}",text(limit,"windowId"),text(limit,"label")).to_lowercase();
    let duration=number(limit,"durationMs").filter(|n| *n>0.0).or_else(|| {
        let patterns=[(r"\b5[\s_-]*h|\bfive\s+hour|\bsession\b",5*HOUR),(r"\b24[\s_-]*h|\b1[\s_-]*d|\bdaily\b",DAY),(r"\b7[\s_-]*d|\b1[\s_-]*w|\bweek|\bargon\b",7*DAY),(r"\b30[\s_-]*d|\b1[\s_-]*mo|\bmonth",30*DAY)];
        patterns.iter().find(|(p,_)| regex::Regex::new(p).unwrap().is_match(&raw)).map(|(_,d)| *d as f64)
    });
    if let (Some(u),Some(reset),Some(d))=(used,date(&limit["resetsAt"]),duration) { let rem=(reset-at) as f64; if rem>0.0 && d>=HOUR as f64 && rem<=d*1.05 { let elapsed=(d-rem).max(0.0); let fraction=(elapsed/d).clamp(0.0,1.0); let delta=u-fraction; let mut status="on-pace"; let mut exhaust=None;
        if u>=0.995 { status="exhausted"; } else if elapsed>600_000.0 && u>0.05 { let full=(1.0-u)/(u/elapsed); if full<rem*0.92 && delta>0.12 { status="fast"; exhaust=Some(full.round() as i64); } }
        if status=="on-pace" { if ((d<=DAY as f64 && rem<=90.0*60_000.0)||(d>DAY as f64 && rem<=18.0*HOUR as f64)) && 1.0-u>=0.25 { status="use-soon"; } else if delta<=-0.15 { status="reserve"; } else if delta>=0.18 { status="warm"; } }
        let mut pace=json!({"durationMs":d,"elapsedFraction":(fraction*1000.0).round()/1000.0,"paceDelta":(delta*1000.0).round()/1000.0,"status":status}); if let Some(e)=exhaust.filter(|e| *e!=0) { pace["exhaustsInMs"]=json!(e); } out["pace"]=pace;
    } } out
}
fn serialize_banked_resets(b: &Value, at: i64) -> Value {
    let Some(reported_count) = number(b, "count").filter(|n| *n >= 0.0) else { return Value::Null };
    let mut items: Vec<Value> = b["items"].as_array().into_iter().flatten().filter_map(|item| {
        if !item.is_object() { return None; }
        Some(json!({
            "expiresAt": if date(&item["expiresAt"]).is_some() { item["expiresAt"].clone() } else { Value::Null },
            "grantedAt": if date(&item["grantedAt"]).is_some() { item["grantedAt"].clone() } else { Value::Null },
        }))
    }).collect();
    let complete = reported_count.fract() == 0.0 && items.len() as f64 == reported_count
        && items.iter().all(|item| date(&item["expiresAt"]).is_some());
    if complete { items.retain(|item| date(&item["expiresAt"]).is_some_and(|expiry| expiry > at)); }
    let count = if complete { items.len() as f64 } else { reported_count };
    let from_items = items.iter().filter_map(|item| date(&item["expiresAt"]).filter(|expiry| *expiry > at).map(|expiry| (expiry, item["expiresAt"].clone()))).min_by_key(|item| item.0);
    let from_summary = if complete { None } else { date(&b["earliestExpiresAt"]).filter(|expiry| *expiry > at).map(|expiry| (expiry, b["earliestExpiresAt"].clone())) };
    let earliest = match (from_items, from_summary) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (a, b) => a.or(b),
    };
    json!({"count":count,"earliestExpiresAt":earliest.as_ref().map(|v|v.1.clone()).unwrap_or(Value::Null),
        "redeemable":truth(b,"redeemable") && count>0.0,
        "expiringSoon":earliest.is_some_and(|(expiry,_)|expiry-at<=48*HOUR),"items":items})
}

pub fn serialize_account_for_client(acc: &Value, at: i64) -> Value {
    let report=&acc["lastReport"]; let raw=report["limits"].as_array(); let has=raw.map_or(false, |l| !l.is_empty());
    let status=if !truth(acc,"enabled") { "Paused" } else if has && acc["lastError"].is_null() { "Reporting" } else if has { "Stale" } else { "Unavailable" };
    let limits: Vec<_>=raw.map(|v| v.iter().map(|l| enrich_limit_with_pace(l,at)).collect()).unwrap_or_default();
    let banked = serialize_banked_resets(&report["bankedResets"], at);
    let first=|keys:&[&str]| keys.iter().map(|k| &acc[*k]).find(|v| !v.is_null() && v.as_str().map_or(true,|s|!s.is_empty())).cloned().unwrap_or(Value::Null);
    json!({"id":acc["id"],"provider":acc["provider"],"providerId":first(&["orgName","planType","projectId","accountId","provider"]),"label":clean_display_label(text(acc,"label"),text(acc,"provider")),"tag":text(acc,"tag"),"pinned":truth(acc,"pinned"),"enabled":acc["enabled"].as_bool()!=Some(false),"email":first(&["email"]),"planType":first(&["planType"]),"orgName":first(&["orgName"]),"projectId":first(&["projectId"]),"authType":if text(&acc["credentials"],"type").is_empty(){"oauth"}else{text(&acc["credentials"],"type")},"status":status,"limits":limits,"bankedResets":banked,"updatedAt":if !report["fetchedAt"].is_null(){report["fetchedAt"].clone()}else{acc["updatedAt"].clone()},"error":acc["lastError"],"recommended":false,"recommendReason":null,"routerScore":null})
}

pub fn compute_smart_routing(accounts: &mut [Value], at: i64) -> Vec<Value> {
    let mut groups: Vec<(String,Vec<usize>)> = Vec::new();
    for (i,a) in accounts.iter().enumerate() { let p=text(a,"provider"); if let Some((_,ids))=groups.iter_mut().find(|(key,_)|key==p) { ids.push(i); } else { groups.push((p.to_owned(),vec![i])); } }
    let mut recommendations=Vec::new();
    for (provider,ids) in groups { let mut best=None; let mut best_score=f64::NEG_INFINITY; let mut reason=String::new();
        for &i in &ids { let a=&mut accounts[i]; a["recommended"]=json!(false); a["recommendReason"]=Value::Null; a["routerScore"]=Value::Null;
            if !truth(a,"enabled") || text(a,"status")!="Reporting" { continue; }
            let limits: Vec<(f64,Option<i64>)>=a["limits"].as_array().map(|ls|ls.iter().filter_map(|l|number(l,"usedFraction").map(|u|(u,date(&l["resetsAt"])))).collect()).unwrap_or_default(); if limits.is_empty() { continue; }
            let max=limits.iter().map(|x|x.0).fold(f64::NEG_INFINITY,f64::max); let banked=number(&a["bankedResets"],"count").unwrap_or(0.0); if max>=0.985 && banked<=0.0 {continue;}
            let (score,why)=if max>=0.985 { (2.0+banked,format!("Quota full · {banked} banked reset{} ready to redeem",if banked>1.0 {"s"}else{""})) } else {
                let free=1.0-max; let avg=limits.iter().map(|l|1.0-l.0).sum::<f64>()/limits.len() as f64; let mut bonus=0.0; let mut urgent=0;
                for (u,reset) in &limits { let f=1.0-u; if f<0.18 {continue;} if let Some(r)=reset { let rem=*r-at; if rem<=0 {continue;} let b=if rem<=3*HOUR {28.0*f*(1.0-rem as f64/(3*HOUR) as f64)} else if rem<=24*HOUR {14.0*f*(1.0-rem as f64/(24*HOUR) as f64)} else {0.0}; if b>bonus {bonus=b;urgent=rem;} } }
                let score=((free*65.0+avg*35.0+bonus+if truth(a,"pinned"){4.0}else{0.0})*10.0).round()/10.0; let pct=(free*100.0).round() as i64; let note=if banked>0.0 {format!(" · {banked} banked")}else{String::new()};
                let reason=if urgent>0 && bonus>=6.0 { let mins=((urgent as f64/60_000.0).round() as i64).max(1); let rel=if mins<60 {format!("{mins}m")} else if mins%60==0 {format!("{}h",mins/60)} else {format!("{}h {}m",mins/60,mins%60)}; format!("{pct}% free · resets in {rel} · Use first{note}") } else if pct>=99 {format!("100% free · Fresh quota{note}")}else{format!("{pct}% free headroom{note}")}; (score,reason)
            }; a["routerScore"]=json!(score); if score>best_score {best_score=score;best=Some(i);reason=why;}
        }
        if let Some(i)=best {let a=&mut accounts[i];a["recommended"]=json!(true);a["recommendReason"]=json!(reason);recommendations.push(json!({"provider":provider,"accountId":a["id"],"label":a["label"],"email":a["email"],"score":best_score,"reason":reason,"totalCandidates":ids.len()}));}
    } recommendations
}

impl ChalzVault {
    pub fn record_account_usage(&mut self, id: &str, report: Option<&Value>, error: Option<&str>) -> io::Result<Vec<Value>> {
        let Some(idx)=self.accounts.iter().position(|a|text(a,"id")==id) else { return Err(io::Error::new(io::ErrorKind::NotFound,"account not found")); };
        let mut account=self.accounts[idx].clone(); let provider=text(&account,"provider").to_owned(); let label=clean_display_label(text(&account,"label"),&provider); let at=now(); let mut alerts=Vec::new();
        if let Some(r)=report.filter(|r|r["limits"].is_array()) {
            for (source,dest) in [("email","email"),("accountId","accountId"),("projectId","projectId"),("plan","planType"),("planType","planType")] { let val=text(&r["metadata"],source); if !val.is_empty() && text(&account,dest).is_empty() {account[dest]=json!(if source=="email" {val.to_lowercase()}else{val.to_owned()});} }
            let count=if matches!(provider.as_str(),"claude"|"codex") {number(&r["bankedResets"],"count").filter(|n|*n>=0.0)} else {None};
            // Retain the last known report across unknown responses so comparisons survive restart.
            let b=if count.is_some() || (!matches!(provider.as_str(),"claude"|"codex") && r["bankedResets"].is_object()){r["bankedResets"].clone()}else{account["lastReport"]["bankedResets"].clone()}; let prev=self.last_banked.get(id).copied(); let spent=matches!((prev,count),(Some(p),Some(n)) if n<p);
            let sound=truth(&self.settings,"soundEnabled") && text(&self.settings,"soundPack")!="off"; let pack=text(&self.settings,"soundPack").to_owned(); let enabled=truth(&self.settings,"alertsEnabled");
            if let Some(n)=count { if n>0.0 && prev.map_or(true,|p|n>p) {
                let (detail,body)=if let Some(p)=prev {let added=n-p;(format!("Received +{added} banked reset credit ({n} available in reserve)"),format!("+{added} banked reset credit detected ({n} available)."))}else{(format!("{n} banked reset credit(s) available in reserve"),format!("{n} banked reset credit(s) available."))};
                self.record_event("banked_grant",&provider,Some(id),&label,&detail,&json!({"bankedCount":n}))?;
                if enabled && truth(&self.settings,"bankedAlertsEnabled") {alerts.push(json!({"kind":"banked_grant","level":"reset","provider":provider,"accountId":id,"accountLabel":label,"sound":sound,"soundPack":pack,"title":format!("{label} — Banked Reset Available!"),"body":body}));}
            }
                if n>0.0 {if let Some(exp)=date(&b["earliestExpiresAt"]) {let key=format!("{id}:{}",b["earliestExpiresAt"]);if exp>at && exp-at<=24*HOUR && self.expiring_warned.insert(key) {let hrs=(((exp-at) as f64/HOUR as f64).round() as i64).max(1);self.record_event("banked_expiring",&provider,Some(id),&label,&format!("Banked reset credit expires in ~{hrs}h — redeem before it lapses"),&json!({}))?;if enabled && truth(&self.settings,"bankedAlertsEnabled") {alerts.push(json!({"kind":"banked_expiring","level":"warn","provider":provider,"accountId":id,"accountLabel":label,"sound":sound,"soundPack":pack,"title":format!("{label} — Banked Reset Expiring"),"body":format!("1 banked reset credit expires in ~{hrs}h. Redeem it before it expires!")}));}}} } self.last_banked.insert(id.to_owned(),n);
            }
            let mut limits=r["limits"].as_array().unwrap().clone();
            let crit=number(&self.settings,"critThreshold").unwrap_or(0.95); let warn=number(&self.settings,"warnThreshold").unwrap_or(0.8);
            for l in limits.iter_mut() {let Some(u)=number(l,"usedFraction").map(|x|x.clamp(0.0,1.0)) else {continue};let window=if text(l,"label").is_empty(){"Quota window"}else{text(l,"label")};let key=format!("{id}:{}",if !text(l,"label").is_empty(){text(l,"label")}else if !text(l,"id").is_empty(){text(l,"id")}else{"limit"});let prev=self.last_used.get(&key).copied();let reset=self.last_reset.get(&key).copied();let next=date(&l["resetsAt"]);let oldlevel=*self.last_levels.get(&key).unwrap_or(&0);let level=if u>=crit{2}else if u>=warn{1}else{0};
                let rolled=matches!((prev,reset),(Some(p),Some(t)) if t!=0 && at>=t-90_000 && next.map_or(true,|n|n>t+90_000) && p>=0.01 && u<p+0.005);let dropped=prev.map_or(false,|p|(p>=0.10 && u<=0.05 && p-u>=0.08)||(p>=0.35 && u<=0.20 && p-u>=0.30));
                if rolled || dropped {let p=prev.unwrap_or(0.0);let pp=(p*100.0).round() as i64;let up=(u*100.0).round() as i64;let free=((1.0-u)*100.0).round() as i64;let early=!rolled && (reset.map_or(false,|t|t-at>15*60_000)||spent);let kind=if early && spent{"banked_reset"}else{"reset"};let detail=if early{format!("{window} refreshed early ({pp}% → {up}% used · {free}% free)")}else{format!("{window} reset ({pp}% → {up}% used · {free}% free)")};let mut extra=json!({"usedFraction":u,"previousFraction":p});if early{extra["bankedCreditSpent"]=json!(spent);}self.record_event(kind,&provider,Some(id),&label,&detail,&extra)?;
                    if enabled && (truth(&self.settings,"resetAlertsEnabled") || (early && spent && truth(&self.settings,"bankedAlertsEnabled"))) {alerts.push(json!({"kind":kind,"level":"reset","provider":provider,"accountId":id,"accountLabel":label,"windowLabel":window,"sound":sound,"soundPack":pack,"title":if early{format!("{label} — Early Reset!")}else{format!("{label} — Usage Reset!")},"body":if early{format!("{window} refreshed ahead of schedule ({free}% available, down from {pp}% used).")}else{format!("{window} has reset ({free}% available, down from {pp}% used).")}}));}
                } else if level>oldlevel {let pct=(u*100.0).round() as i64;let kind=if level>=2{"crit95"}else{"warn80"};let detail=format!("{} reached {pct}% used",if text(l,"label").is_empty(){"Quota"}else{text(l,"label")});self.record_event(kind,&provider,Some(id),&label,&detail,&json!({"usedFraction":u}))?;if enabled && truth(&self.settings,"thresholdAlertsEnabled"){alerts.push(json!({"kind":kind,"level":if level>=2{"crit"}else{"warn"},"provider":provider,"accountId":id,"accountLabel":label,"windowLabel":window,"sound":sound,"soundPack":pack,"title":format!("{label} {} ({pct}%)",if level>=2{"Critical"}else{"Warning"}),"body":format!("{window} is at {pct}% used.")}));}}
                let armed=if rolled || dropped || level>=oldlevel {level} else if u>(if oldlevel>=2{crit}else{warn})-ALERT_REARM_MARGIN {oldlevel} else {level};
                l["alertLevel"]=json!(armed);
                self.last_used.insert(key.clone(),u);if let Some(n)=next.filter(|n|*n!=0){self.last_reset.insert(key.clone(),n);}self.last_levels.insert(key,armed);
            }
            let fetched=if r["fetchedAt"].is_null(){json!(at)}else{r["fetchedAt"].clone()};account["lastReport"]=json!({"fetchedAt":fetched,"limits":limits,"metadata":if r["metadata"].is_null(){json!({})}else{r["metadata"].clone()}});if !b.is_null(){account["lastReport"]["bankedResets"]=b;}account["lastError"]=Value::Null;account["updatedAt"]=fetched;
            let vals:Vec<f64>=limits.iter().filter_map(|l|number(l,"usedFraction").map(|u|u.clamp(0.0,1.0))).collect();if !vals.is_empty(){let peak=(vals.iter().copied().fold(f64::NEG_INFINITY,f64::max)*1000.0).round()/1000.0;let avg=(vals.iter().sum::<f64>()/vals.len() as f64*1000.0).round()/1000.0;let last=self.snapshots.iter().rev().find(|s|text(s,"accountId")==id);let due=last.map_or(true,|s|(number(s,"peakUsed").unwrap_or(0.0)-peak).abs()>=0.01 || at-s["t"].as_i64().unwrap_or(0)>=300_000);if due{self.snapshots.push(json!({"t":at,"accountId":id,"provider":provider,"label":account["label"],"peakUsed":peak,"avgUsed":avg,"windows":vals.len()}));trim_tail(&mut self.snapshots,MAX_SNAPSHOTS);self.save_history()?;}}
        } else if let Some(e)=error.filter(|e|!e.is_empty()){account["lastError"]=json!(e);account["updatedAt"]=json!(at);}
        self.accounts[idx]=account;self.save_accounts()?;Ok(alerts)
    }
}

#[cfg(test)]
mod banked_reset_tests {
    use super::*;

    #[test]
    fn complete_credits_expire_without_exposing_identifiers() {
        let now = 1_700_000_000_000i64;
        let account = json!({"provider":"codex", "lastReport":{"bankedResets":{
            "count":2, "redeemable":true, "items":[
                {"id":"secret1", "source":"private", "expiresAt":now-1, "grantedAt":now-10},
                {"id":"secret2", "source":"private", "expiresAt":now+1000, "grantedAt":now-20}
            ]
        }}});
        let banked = serialize_account_for_client(&account, now)["bankedResets"].clone();
        assert_eq!(banked["count"], 1.0);
        assert_eq!(banked["earliestExpiresAt"], now+1000);
        assert_eq!(banked["items"][0]["grantedAt"], now-20);
        assert!(banked["items"][0].get("id").is_none());
        assert!(banked["items"][0].get("source").is_none());
        assert_eq!(serialize_account_for_client(&account, now+1001)["bankedResets"]["count"], 0.0);
    }

    #[test]
    fn incomplete_credit_details_do_not_guess_count() {
        let banked = serialize_banked_resets(&json!({"count":3,"redeemable":true,"items":[{"expiresAt":1000}]}), 2000);
        assert_eq!(banked["count"], 3.0);
        assert_eq!(banked["items"][0]["expiresAt"], 1000);
    }
}
