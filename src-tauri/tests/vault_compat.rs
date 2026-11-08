// Exercise the vault directly without starting the desktop server or reading user data.
#[path = "../src/backend/vault.rs"]
mod vault;

use serde_json::{json, Value};
use std::fs;
use tempfile::TempDir;
use vault::ChalzVault;

fn write_json(dir: &TempDir, name: &str, value: &Value) {
    fs::write(dir.path().join(name), serde_json::to_vec(value).unwrap()).unwrap();
}

fn report(used: f64) -> Value {
    json!({"limits": [{"id": "weekly", "label": "Weekly", "usedFraction": used}], "metadata": {}})
}

#[test]
fn loads_and_persists_legacy_format() {
    let dir = TempDir::new().unwrap();
    let account = json!({
        "id": "fixture-account", "provider": "openai", "label": "Work",
        "email": "fixture@example.invalid", "accountId": "remote-id",
        "credentials": {"type": "oauth", "accessToken": "fixture-token", "refreshToken": "fixture-refresh"},
        "lastReport": {"limits": [{"label": "Weekly", "usedFraction": 0.82}], "metadata": {}},
        "pinned": true, "enabled": true
    });
    write_json(&dir, "accounts.json", &json!({"version": 2, "updatedAt": 123, "accounts": [account], "settings": {"soundPack": "crystal", "thresholdAlertsEnabled": false}}));
    write_json(&dir, "history.json", &json!({"version": 1, "updatedAt": 123, "snapshots": [{"t": 100, "accountId": "fixture-account", "peakUsed": 0.82}], "events": [{"type": "signin", "accountId": "fixture-account"}]}));

    let mut vault = ChalzVault::new(dir.path().to_owned()).unwrap();
    assert_eq!(vault.get_account_by_id("fixture-account").unwrap(), &account);
    assert_eq!(vault.settings["soundPack"], "crystal");
    assert_eq!(vault.settings["thresholdAlertsEnabled"], false);
    assert_eq!(vault.settings["resetAlertsEnabled"], true);
    assert_eq!(vault.snapshots.len(), 1);
    assert_eq!(vault.events.len(), 1);
    vault.update_account_meta("fixture-account", &json!({"tag": "team", "pinned": false})).unwrap();
    vault.update_settings(&json!({"soundPack": "minimal"})).unwrap();
    vault.save_history().unwrap();

    let reopened = ChalzVault::new(dir.path().to_owned()).unwrap();
    let saved = reopened.get_account_by_id("fixture-account").unwrap();
    assert_eq!(saved["credentials"], account["credentials"]);
    assert_eq!(saved["tag"], "team");
    assert_eq!(saved["pinned"], false);
    assert_eq!(reopened.settings["soundPack"], "minimal");
    assert_eq!(reopened.snapshots[0]["peakUsed"], 0.82);
    assert_eq!(reopened.events[0]["type"], "signin");
    let disk: Value = serde_json::from_slice(&fs::read(dir.path().join("accounts.json")).unwrap()).unwrap();
    assert_eq!(disk["version"], 2);
    let history: Value = serde_json::from_slice(&fs::read(dir.path().join("history.json")).unwrap()).unwrap();
    assert_eq!(history["version"], 1);
}

#[test]
fn reauth_merges_credentials_without_creating_an_account() {
    let dir = TempDir::new().unwrap();
    let mut vault = ChalzVault::new(dir.path().to_owned()).unwrap();
    let first = vault.upsert_account(&json!({
        "provider": "openai", "email": "Person@Example.invalid", "accountId": "remote-id", "orgId": "org-1",
        "credentials": {"type": "oauth", "accessToken": "old-token", "refreshToken": "keep-refresh"}
    })).unwrap();
    assert_eq!(first["created"], true);
    let id = first["account"]["id"].as_str().unwrap().to_owned();
    let updated = vault.upsert_account(&json!({
        "provider": "openai", "email": "person@example.invalid", "accountId": "remote-id", "orgId": "org-1",
        "credentials": {"accessToken": "new-token"}
    })).unwrap();
    assert_eq!(updated["created"], false);
    assert_eq!(updated["account"]["id"], id);
    assert_eq!(vault.accounts.len(), 1);
    let reopened = ChalzVault::new(dir.path().to_owned()).unwrap();
    let account = reopened.get_account_by_id(&id).unwrap();
    assert_eq!(account["credentials"]["accessToken"], "new-token");
    assert_eq!(account["credentials"]["refreshToken"], "keep-refresh");
    assert_eq!(account["credentials"]["type"], "oauth");
    assert_eq!(reopened.events.iter().map(|e| e["type"].as_str().unwrap()).collect::<Vec<_>>(), vec!["signin", "reauth"]);
}

#[test]
fn threshold_crossings_are_once_per_level_and_rearm_after_reset() {
    let dir = TempDir::new().unwrap();
    write_json(&dir, "accounts.json", &json!({"version": 2, "accounts": [{
        "id": "a", "provider": "openai", "label": "Fixture",
        "lastReport": {"limits": [{"id": "weekly", "label": "Weekly", "usedFraction": 0.82}]}
    }]}));
    let mut vault = ChalzVault::new(dir.path().to_owned()).unwrap();
    let usage = |v: &mut ChalzVault, fraction| v.record_account_usage("a", Some(&report(fraction)), None).unwrap();
    assert!(usage(&mut vault, 0.83).is_empty(), "cached warning must not repeat on startup");
    assert_eq!(usage(&mut vault, 0.95)[0]["kind"], "crit95");
    assert!(usage(&mut vault, 0.97).is_empty());
    assert_eq!(usage(&mut vault, 0.10)[0]["kind"], "reset");
    assert_eq!(usage(&mut vault, 0.80)[0]["kind"], "warn80");
    assert!(usage(&mut vault, 0.85).is_empty());
    let reopened = ChalzVault::new(dir.path().to_owned()).unwrap();
    let kinds: Vec<_> = reopened.events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["crit95", "reset", "warn80"]);
}

#[test]
fn malformed_stores_are_rejected_and_never_replaced() {
    for (name, malformed) in [("accounts.json", b"{broken".as_slice()), ("history.json", b"{\"snapshots\":[],\"events\":{}}".as_slice())] {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(name);
        fs::write(&path, malformed).unwrap();
        assert!(ChalzVault::new(dir.path().to_owned()).is_err());
        assert_eq!(fs::read(&path).unwrap(), malformed);

        fs::remove_file(&path).unwrap();
        let vault = ChalzVault::new(dir.path().to_owned()).unwrap();
        fs::write(&path, malformed).unwrap();
        let result = if name == "accounts.json" { vault.save_accounts() } else { vault.save_history() };
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), malformed);
    }
}

#[test]
fn history_load_and_new_records_keep_the_most_recent_limits() {
    let dir = TempDir::new().unwrap();
    let snapshots: Vec<_> = (0..1402).map(|n| json!({"t": n, "accountId": "other", "peakUsed": 0.2})).collect();
    let events: Vec<_> = (0..502).map(|n| json!({"type": "fixture", "sequence": n})).collect();
    write_json(&dir, "history.json", &json!({"version": 1, "snapshots": snapshots, "events": events}));
    write_json(&dir, "accounts.json", &json!({"version": 2, "accounts": [{"id": "a", "provider": "openai", "label": "Fixture"}]}));
    let mut vault = ChalzVault::new(dir.path().to_owned()).unwrap();
    assert_eq!(vault.snapshots.len(), 1400);
    assert_eq!(vault.snapshots[0]["t"], 2);
    assert_eq!(vault.events.len(), 500);
    assert_eq!(vault.events[0]["sequence"], 2);
    vault.record_event("custom", "openai", Some("a"), "Fixture", "detail", &json!({})).unwrap();
    vault.record_account_usage("a", Some(&report(0.5)), None).unwrap();
    assert_eq!(vault.snapshots.len(), 1400);
    assert_eq!(vault.snapshots[0]["t"], 3);
    assert_eq!(vault.events.len(), 500);
    assert_eq!(vault.events[0]["sequence"], 3);
    let before = vault.snapshots.len();
    vault.record_account_usage("a", Some(&report(0.5)), None).unwrap();
    assert_eq!(vault.snapshots.len(), before, "unchanged usage should not create a duplicate snapshot");
    let reopened = ChalzVault::new(dir.path().to_owned()).unwrap();
    assert_eq!(reopened.snapshots.len(), 1400);
    assert_eq!(reopened.snapshots.last().unwrap()["accountId"], "a");
    assert_eq!(reopened.events.len(), 500);
    assert_eq!(reopened.events.last().unwrap()["type"], "custom");
}
