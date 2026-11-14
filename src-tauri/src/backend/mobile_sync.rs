//! Opt-in end-to-end encrypted mobile companion sync over a zero-knowledge Cloudflare relay.
//!
//! Security invariants:
//! - Disabled by default until explicitly enabled by the user.
//! - Secrets (`readKey`, `writeKey`, `key`, `room`) are never logged or serialized into error messages.
//! - `writeKey` never leaves this desktop except in `Authorization: Bearer` requests to the validated relay.
//! - Outbound relay requests forbid HTTP redirects so bearer tokens cannot be redirected elsewhere.
//! - Mobile snapshots explicitly whitelist safe display fields and never include credentials,
//!   raw provider reports, emails, internal account IDs, or arbitrary provider error messages.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{redirect::Policy, Client, StatusCode};
use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM},
    hmac,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{watch, Mutex as AsyncMutex, Notify};

const STATE_FILE: &str = "mobile_sync.json";
const TOKEN_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const MIN_INTERVAL_SECS: u64 = 30;
const MAX_INTERVAL_SECS: u64 = 3600;
const DEFAULT_INTERVAL_SECS: u64 = 60;
const MAX_SNAPSHOT_BYTES: usize = 180 * 1024;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn clamp_interval(secs: Option<u64>) -> u64 {
    secs.unwrap_or(DEFAULT_INTERVAL_SECS)
        .clamp(MIN_INTERVAL_SECS, MAX_INTERVAL_SECS)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedMobileSync {
    version: u32,
    enabled: bool,
    relay_url: String,
    #[serde(default)]
    allow_local_http: bool,
    room: String,
    read_key: String,
    write_key: String,
    key: String,
    room_created: bool,
    sync_interval_secs: u64,
    generation: u64,
    last_published_at: Option<i64>,
    last_error: Option<String>,
    last_status: String,
}

impl fmt::Debug for PersistedMobileSync {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PersistedMobileSync")
            .field("version", &self.version)
            .field("enabled", &self.enabled)
            .field("relay_url", &self.relay_url)
            .field("allow_local_http", &self.allow_local_http)
            .field("room_created", &self.room_created)
            .field("sync_interval_secs", &self.sync_interval_secs)
            .field("generation", &self.generation)
            .field("last_published_at", &self.last_published_at)
            .field("last_status", &self.last_status)
            .finish_non_exhaustive()
    }
}

impl Default for PersistedMobileSync {
    fn default() -> Self {
        Self {
            version: 1,
            enabled: false,
            relay_url: String::new(),
            allow_local_http: false,
            room: String::new(),
            read_key: String::new(),
            write_key: String::new(),
            key: String::new(),
            room_created: false,
            sync_interval_secs: DEFAULT_INTERVAL_SECS,
            generation: 0,
            last_published_at: None,
            last_error: None,
            last_status: "disabled".to_owned(),
        }
    }
}

pub struct MobileSync {
    dir: PathBuf,
    client: Client,
    state: Mutex<PersistedMobileSync>,
    generation: AtomicU64,
    op_lock: AsyncMutex<()>,
    cancel_tx: watch::Sender<u64>,
    pub wake: Notify,
}

impl MobileSync {
    pub fn new(dir: PathBuf) -> io::Result<Self> {
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| io::Error::other("Could not initialize mobile sync HTTP client."))?;

        let mut persisted = load_state(&dir.join(STATE_FILE))?;
        if persisted.enabled {
            let valid_url = validate_relay_url(&persisted.relay_url, persisted.allow_local_http).is_ok();
            let valid_secrets = decode_b64url_exact(&persisted.room, TOKEN_BYTES).is_ok()
                && decode_b64url_exact(&persisted.read_key, TOKEN_BYTES).is_ok()
                && decode_b64url_exact(&persisted.write_key, TOKEN_BYTES).is_ok()
                && decode_b64url_exact(&persisted.key, TOKEN_BYTES).is_ok();
            if !valid_url || !valid_secrets || !persisted.room_created {
                persisted.enabled = false;
                persisted.room_created = false;
                persisted.room.clear();
                persisted.read_key.clear();
                persisted.write_key.clear();
                persisted.key.clear();
                persisted.last_status = "error".to_owned();
                persisted.last_error = Some(
                    "Stored mobile pairing state was incomplete or invalid and has been disabled."
                        .to_owned(),
                );
            }
        }

        let initial_gen = persisted.generation;
        let (cancel_tx, _) = watch::channel(initial_gen);
        Ok(Self {
            dir,
            client,
            state: Mutex::new(persisted),
            generation: AtomicU64::new(initial_gen),
            op_lock: AsyncMutex::new(()),
            cancel_tx,
            wake: Notify::new(),
        })
    }

    pub fn is_active(&self) -> bool {
        let s = self.state.lock().unwrap();
        s.enabled && s.room_created && !s.room.is_empty() && !s.write_key.is_empty() && !s.key.is_empty()
    }

    pub fn sync_interval(&self) -> Duration {
        let secs = self.state.lock().unwrap().sync_interval_secs;
        Duration::from_secs(clamp_interval(Some(secs)))
    }

    pub fn status_json(&self) -> Value {
        let s = self.state.lock().unwrap();
        status_from_persisted(&s)
    }

    pub async fn enable(
        &self,
        relay_url_raw: &str,
        allow_local_http: bool,
        sync_interval_secs: Option<u64>,
        accounts: &[Value],
    ) -> Result<(Value, Option<String>), String> {
        let relay_url = validate_relay_url(relay_url_raw, allow_local_http)?;
        let interval = clamp_interval(sync_interval_secs);

        let _op = self.op_lock.lock().await;
        {
            let s = self.state.lock().unwrap();
            if s.enabled && s.room_created {
                return Err(
                    "Mobile companion is already paired. Rotate keys or disconnect first."
                        .to_owned(),
                );
            }
        }

        let secrets = generate_pair_secrets()?;
        let read_hash = hash_b64url_token(&secrets.read_key)?;
        let write_hash = hash_b64url_token(&secrets.write_key)?;

        self.create_remote_room(&relay_url, &secrets.room, &read_hash, &write_hash)
            .await?;

        let new_gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.cancel_tx.send(new_gen);

        {
            let mut s = self.state.lock().unwrap();
            s.version = 1;
            s.enabled = true;
            s.relay_url = relay_url.clone();
            s.allow_local_http = allow_local_http;
            s.room = secrets.room.clone();
            s.read_key = secrets.read_key.clone();
            s.write_key = secrets.write_key.clone();
            s.key = secrets.key.clone();
            s.room_created = true;
            s.sync_interval_secs = interval;
            s.generation = new_gen;
            s.last_published_at = None;
            s.last_error = None;
            s.last_status = "paired".to_owned();
            save_state(&self.dir.join(STATE_FILE), &s)
                .map_err(|_| "Could not persist mobile pairing state locally.".to_owned())?;
        }

        let sync_error = match self
            .publish_under_lock(accounts, new_gen, &relay_url, allow_local_http, &secrets.room, &secrets.write_key, &secrets.key)
            .await
        {
            Ok(()) => None,
            Err(err) => Some(err),
        };

        self.wake.notify_one();
        Ok((self.status_json(), sync_error))
    }

    pub async fn publish_snapshot(&self, accounts: &[Value]) -> Result<Value, String> {
        if !self.is_active() {
            return Err("Mobile companion sync is disabled.".to_owned());
        }

        let _op = self.op_lock.lock().await;
        let (enabled, room_created, relay_url, allow_local_http, room, write_key, key, gen) = {
            let s = self.state.lock().unwrap();
            (
                s.enabled,
                s.room_created,
                s.relay_url.clone(),
                s.allow_local_http,
                s.room.clone(),
                s.write_key.clone(),
                s.key.clone(),
                s.generation,
            )
        };

        if !enabled || !room_created || room.is_empty() || write_key.is_empty() || key.is_empty() {
            return Err("Mobile companion sync is disabled.".to_owned());
        }

        self.publish_under_lock(
            accounts,
            gen,
            &relay_url,
            allow_local_http,
            &room,
            &write_key,
            &key,
        )
        .await?;
        Ok(self.status_json())
    }

    async fn publish_under_lock(
        &self,
        accounts: &[Value],
        expected_gen: u64,
        relay_url: &str,
        allow_local_http: bool,
        room: &str,
        write_key: &str,
        key: &str,
    ) -> Result<(), String> {
        let valid_url = validate_relay_url(relay_url, allow_local_http)?;
        if self.generation.load(Ordering::SeqCst) != expected_gen {
            return Err("Sync cancelled because pairing changed.".to_owned());
        }

        let at = now_ms();
        let snapshot = build_safe_mobile_snapshot(accounts, at, key);
        let plaintext = serde_json::to_vec(&snapshot)
            .map_err(|_| "Could not serialize mobile snapshot.".to_owned())?;
        if plaintext.len() > MAX_SNAPSHOT_BYTES {
            let msg = "Encrypted snapshot exceeds relay size limit.".to_owned();
            self.record_publish_failure(expected_gen, &msg, false);
            return Err(msg);
        }

        let (nonce, ciphertext) = encrypt_snapshot(key, &plaintext)?;
        if self.generation.load(Ordering::SeqCst) != expected_gen {
            return Err("Sync cancelled because pairing changed.".to_owned());
        }

        let endpoint = format!("{valid_url}/v1/rooms/{room}");
        let mut cancel_rx = self.cancel_tx.subscribe();
        let req = self
            .client
            .put(endpoint)
            .bearer_auth(write_key)
            .json(&json!({
                "nonce": nonce,
                "ciphertext": ciphertext
            }))
            .send();

        let response = tokio::select! {
            _ = cancel_rx.wait_for(|g| *g != expected_gen) => {
                return Err("Sync cancelled because mobile pairing was revoked or rotated.".to_owned());
            }
            res = req => {
                match res {
                    Ok(resp) => resp,
                    Err(err) => {
                        let msg = format!("Could not reach relay: {}", sanitize_reqwest_error(&err));
                        self.record_publish_failure(expected_gen, &msg, false);
                        return Err(msg);
                    }
                }
            }
        };

        if self.generation.load(Ordering::SeqCst) != expected_gen {
            return Err("Sync cancelled because mobile pairing was revoked or rotated.".to_owned());
        }

        let status = response.status();
        if status.is_success() {
            let body: Value = response.json().await.unwrap_or_else(|_| json!({}));
            let updated_at = body.get("updatedAt").and_then(Value::as_i64).unwrap_or(at);
            let mut s = self.state.lock().unwrap();
            if s.generation == expected_gen && s.enabled {
                s.last_published_at = Some(updated_at);
                s.last_error = None;
                s.last_status = "synced".to_owned();
                let _ = save_state(&self.dir.join(STATE_FILE), &s);
            }
            return Ok(());
        }

        let server_msg = extract_error_message(response).await;
        let room_missing = status == StatusCode::NOT_FOUND;
        let msg = if room_missing {
            "Relay room no longer exists (HTTP 404). Rotate keys or re-pair to create a new room."
                .to_owned()
        } else {
            format!("Relay rejected snapshot upload (HTTP {}): {server_msg}", status.as_u16())
        };
        self.record_publish_failure(expected_gen, &msg, room_missing);
        Err(msg)
    }

    fn record_publish_failure(&self, expected_gen: u64, msg: &str, room_missing: bool) {
        let mut s = self.state.lock().unwrap();
        if s.generation == expected_gen && s.enabled {
            s.last_status = "error".to_owned();
            s.last_error = Some(msg.to_owned());
            if room_missing {
                s.room_created = false;
            }
            let _ = save_state(&self.dir.join(STATE_FILE), &s);
        }
    }

    pub async fn update_settings(&self, sync_interval_secs: u64) -> Result<Value, String> {
        let interval = clamp_interval(Some(sync_interval_secs));
        let _op = self.op_lock.lock().await;
        {
            let mut s = self.state.lock().unwrap();
            s.sync_interval_secs = interval;
            save_state(&self.dir.join(STATE_FILE), &s)
                .map_err(|_| "Could not persist mobile sync settings.".to_owned())?;
        }
        self.wake.notify_one();
        Ok(self.status_json())
    }

    pub async fn disconnect_and_revoke(&self) -> Result<Value, String> {
        // Immediately bump generation and signal cancellation before waiting on op_lock
        // so any in-flight PUT aborts and cannot update state or repopulate the room.
        let cancel_gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.cancel_tx.send(cancel_gen);

        {
            let mut s = self.state.lock().unwrap();
            s.enabled = false;
            s.generation = cancel_gen;
        }
        self.wake.notify_one();

        let _op = self.op_lock.lock().await;
        let (should_delete, relay_url, allow_local_http, room, write_key) = {
            let s = self.state.lock().unwrap();
            (
                s.room_created && !s.room.is_empty() && !s.write_key.is_empty(),
                s.relay_url.clone(),
                s.allow_local_http,
                s.room.clone(),
                s.write_key.clone(),
            )
        };

        let mut remote_deleted = false;
        let mut remote_not_found = false;
        let mut warning: Option<String> = None;

        if should_delete {
            match validate_relay_url(&relay_url, allow_local_http) {
                Ok(valid_url) => {
                    let endpoint = format!("{valid_url}/v1/rooms/{room}");
                    match self
                        .client
                        .delete(endpoint)
                        .bearer_auth(&write_key)
                        .timeout(Duration::from_secs(10))
                        .send()
                        .await
                    {
                        Ok(resp) if resp.status().is_success() => {
                            remote_deleted = true;
                        }
                        Ok(resp) if resp.status() == StatusCode::NOT_FOUND => {
                            remote_not_found = true;
                            warning = Some(
                                "Remote room was not found on the relay (HTTP 404); it may have already been deleted or expired. Local pairing credentials were cleared."
                                    .to_owned(),
                            );
                        }
                        Ok(resp) => {
                            let code = resp.status().as_u16();
                            let detail = extract_error_message(resp).await;
                            warning = Some(format!(
                                "Local pairing credentials were cleared, but remote relay deletion failed (HTTP {code}: {detail}). The remote room may still exist."
                            ));
                        }
                        Err(err) => {
                            warning = Some(format!(
                                "Local pairing credentials were cleared, but remote relay deletion failed ({}). The remote room may still exist.",
                                sanitize_reqwest_error(&err)
                            ));
                        }
                    }
                }
                Err(err) => {
                    warning = Some(format!(
                        "Local pairing credentials were cleared, but remote relay deletion could not run ({err})."
                    ));
                }
            }
        }

        let final_gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.cancel_tx.send(final_gen);

        {
            let mut s = self.state.lock().unwrap();
            s.enabled = false;
            s.room.clear();
            s.read_key.clear();
            s.write_key.clear();
            s.key.clear();
            s.room_created = false;
            s.generation = final_gen;
            s.last_published_at = None;
            s.last_status = if warning.is_some() {
                "revoke_warning".to_owned()
            } else {
                "disabled".to_owned()
            };
            s.last_error = warning.clone();
            save_state(&self.dir.join(STATE_FILE), &s)
                .map_err(|_| "Could not persist revoked mobile sync state.".to_owned())?;
        }

        Ok(json!({
            "ok": true,
            "remoteDeleted": remote_deleted,
            "remoteNotFound": remote_not_found,
            "warning": warning,
            "status": self.status_json(),
        }))
    }

    pub async fn rotate(
        &self,
        relay_url_override: Option<&str>,
        allow_local_http_override: Option<bool>,
        sync_interval_override: Option<u64>,
        accounts: &[Value],
    ) -> Result<(Value, Option<String>, Option<String>), String> {
        let (prev_url, prev_allow_http, prev_interval) = {
            let s = self.state.lock().unwrap();
            (
                s.relay_url.clone(),
                s.allow_local_http,
                s.sync_interval_secs,
            )
        };

        let target_url = relay_url_override
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&prev_url)
            .to_owned();
        let target_allow_http = allow_local_http_override.unwrap_or(prev_allow_http);
        let target_interval = sync_interval_override.unwrap_or(prev_interval);

        // Validate the target URL before revoking the working room so typos don't destroy active pairing.
        validate_relay_url(&target_url, target_allow_http)?;

        let revoke_res = self.disconnect_and_revoke().await?;
        let revoke_warning = revoke_res
            .get("warning")
            .and_then(Value::as_str)
            .map(str::to_owned);

        match self
            .enable(&target_url, target_allow_http, Some(target_interval), accounts)
            .await
        {
            Ok((status, sync_error)) => Ok((status, revoke_warning, sync_error)),
            Err(err) => {
                let msg = if let Some(w) = revoke_warning {
                    format!("{err} (Previous room note: {w})")
                } else {
                    err
                };
                Err(msg)
            }
        }
    }

    async fn create_remote_room(
        &self,
        relay_url: &str,
        room: &str,
        read_hash: &str,
        write_hash: &str,
    ) -> Result<(), String> {
        let endpoint = format!("{relay_url}/v1/rooms/{room}");
        let response = self
            .client
            .post(endpoint)
            .json(&json!({
                "readHash": read_hash,
                "writeHash": write_hash,
            }))
            .send()
            .await
            .map_err(|err| format!("Could not reach relay: {}", sanitize_reqwest_error(&err)))?;

        if response.status().is_success() {
            return Ok(());
        }
        let code = response.status().as_u16();
        let detail = extract_error_message(response).await;
        Err(format!("Relay rejected room creation (HTTP {code}): {detail}"))
    }
}

fn status_from_persisted(s: &PersistedMobileSync) -> Value {
    let paired = s.enabled
        && s.room_created
        && !s.relay_url.is_empty()
        && !s.room.is_empty()
        && !s.read_key.is_empty()
        && !s.key.is_empty();

    let pairing_payload = if paired {
        Some(json!({
            "v": 1,
            "url": s.relay_url,
            "room": s.room,
            "readKey": s.read_key,
            "key": s.key,
        }))
    } else {
        None
    };

    json!({
        "enabled": s.enabled,
        "paired": paired,
        "relayUrl": s.relay_url,
        "allowLocalHttp": s.allow_local_http,
        "syncIntervalSecs": s.sync_interval_secs,
        "roomCreated": s.room_created,
        "lastPublishedAt": s.last_published_at,
        "lastError": s.last_error,
        "lastStatus": s.last_status,
        "pairingPayload": pairing_payload,
    })
}

pub fn validate_relay_url(raw: &str, allow_local_http: bool) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Relay URL is required.".to_owned());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "Relay URL is not a valid URL.".to_owned())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Relay URL must not contain embedded credentials.".to_owned());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Relay URL must not contain query parameters or fragments.".to_owned());
    }
    let Some(host) = parsed.host() else {
        return Err("Relay URL must include a hostname.".to_owned());
    };
    let is_loopback = match host {
        url::Host::Domain(d) => d.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.is_loopback(),
    };
    match parsed.scheme() {
        "https" => {}
        "http" => {
            if !allow_local_http || !is_loopback {
                return Err(
                    "Relay URL must use https:// (HTTP is only allowed for explicit local development on localhost or 127.0.0.1)."
                        .to_owned(),
                );
            }
        }
        _ => return Err("Relay URL must use https://.".to_owned()),
    }
    if parsed
        .path_segments()
        .is_some_and(|mut segs| segs.any(|seg| seg == ".."))
    {
        return Err("Relay URL path is invalid.".to_owned());
    }

    let normalized = parsed.as_str().trim_end_matches('/').to_owned();
    Ok(normalized)
}

struct PairSecrets {
    room: String,
    read_key: String,
    write_key: String,
    key: String,
}

fn generate_pair_secrets() -> Result<PairSecrets, String> {
    let rng = SystemRandom::new();
    let room = random_b64url_32(&rng)?;
    let read_key = random_b64url_32(&rng)?;
    let mut write_key = random_b64url_32(&rng)?;
    while write_key == read_key {
        write_key = random_b64url_32(&rng)?;
    }
    let key = random_b64url_32(&rng)?;
    Ok(PairSecrets {
        room,
        read_key,
        write_key,
        key,
    })
}

fn random_b64url_32(rng: &SystemRandom) -> Result<String, String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    rng.fill(&mut bytes)
        .map_err(|_| "Could not generate cryptographic randomness.".to_owned())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn decode_b64url_exact(input: &str, expected_len: usize) -> Result<Vec<u8>, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(input.as_bytes())
        .map_err(|_| "Invalid base64url token.".to_owned())?;
    if bytes.len() != expected_len {
        return Err("Unexpected token length.".to_owned());
    }
    if URL_SAFE_NO_PAD.encode(&bytes) != input {
        return Err("Non-canonical base64url token.".to_owned());
    }
    Ok(bytes)
}

pub fn hash_b64url_token(token_b64: &str) -> Result<String, String> {
    let raw = decode_b64url_exact(token_b64, TOKEN_BYTES)?;
    let digest = Sha256::digest(&raw);
    Ok(URL_SAFE_NO_PAD.encode(digest))
}

pub fn encrypt_snapshot(key_b64: &str, plaintext: &[u8]) -> Result<(String, String), String> {
    let key_bytes = decode_b64url_exact(key_b64, TOKEN_BYTES)?;
    let unbound = UnboundKey::new(&AES_256_GCM, &key_bytes)
        .map_err(|_| "Invalid AES-256-GCM key.".to_owned())?;
    let sealing_key = LessSafeKey::new(unbound);

    let rng = SystemRandom::new();
    let mut nonce_bytes = [0u8; NONCE_BYTES];
    rng.fill(&mut nonce_bytes)
        .map_err(|_| "Could not generate AES-GCM nonce.".to_owned())?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let mut buffer = plaintext.to_vec();
    sealing_key
        .seal_in_place_append_tag(nonce, Aad::empty(), &mut buffer)
        .map_err(|_| "Could not encrypt mobile snapshot.".to_owned())?;

    Ok((
        URL_SAFE_NO_PAD.encode(nonce_bytes),
        URL_SAFE_NO_PAD.encode(&buffer),
    ))
}

#[cfg(test)]
pub fn decrypt_snapshot(
    key_b64: &str,
    nonce_b64: &str,
    ciphertext_b64: &str,
) -> Result<Vec<u8>, String> {
    let key_bytes = decode_b64url_exact(key_b64, TOKEN_BYTES)?;
    let nonce_vec = decode_b64url_exact(nonce_b64, NONCE_BYTES)?;
    let mut buffer = URL_SAFE_NO_PAD
        .decode(ciphertext_b64.as_bytes())
        .map_err(|_| "Invalid ciphertext encoding.".to_owned())?;
    let unbound = UnboundKey::new(&AES_256_GCM, &key_bytes)
        .map_err(|_| "Invalid AES-256-GCM key.".to_owned())?;
    let opening_key = LessSafeKey::new(unbound);
    let nonce_arr: [u8; NONCE_BYTES] = nonce_vec
        .try_into()
        .map_err(|_| "Invalid nonce length.".to_owned())?;
    let plaintext = opening_key
        .open_in_place(Nonce::assume_unique_for_key(nonce_arr), Aad::empty(), &mut buffer)
        .map_err(|_| "Decryption failed.".to_owned())?;
    Ok(plaintext.to_vec())
}

/// Strictly whitelist safe display fields for mobile consumption.
/// Never forward credentials, raw reports, arbitrary provider error text, emails,
/// or internal provider/org/project identifiers.
pub fn build_safe_mobile_snapshot(accounts: &[Value], generated_at: i64, session_key: &str) -> Value {
    let key = hmac::Key::new(hmac::HMAC_SHA256, session_key.as_bytes());
    let safe_accounts: Vec<Value> = accounts.iter().enumerate().map(|(index, account)| {
        let mut safe = sanitize_account_for_mobile(account);
        let mut id_mac = hmac::Context::with_key(&key);
        id_mac.update(b"chalztracker-snapshot-account-id-v1\0");
        if let Some(id) = account.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) {
            id_mac.update(b"id\0");
            id_mac.update(id.as_bytes());
        } else {
            id_mac.update(b"index\0");
            id_mac.update(&index.to_le_bytes());
        }
        safe["id"] = json!(URL_SAFE_NO_PAD.encode(id_mac.sign().as_ref()));
        redact_email_strings(&mut safe);
        safe
    }).collect();
    json!({"version": 1, "generatedAt": generated_at, "accounts": safe_accounts})
}

fn redact_email_strings(value: &mut Value) {
    match value {
        Value::String(text) if text.contains('@') => *text = "[hidden]".to_owned(),
        Value::Array(values) => values.iter_mut().for_each(redact_email_strings),
        Value::Object(values) => values.values_mut().for_each(redact_email_strings),
        _ => {}
    }
}

fn sanitize_label(raw_label: &str, provider: &str) -> String {
    let trimmed = raw_label.trim();
    if trimmed.is_empty() || trimmed.contains('@') {
        return provider.to_owned();
    }
    trimmed.to_owned()
}

fn sanitize_account_for_mobile(acc: &Value) -> Value {
    let provider = acc
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let raw_label = acc.get("label").and_then(Value::as_str).unwrap_or("");
    let label = sanitize_label(raw_label, provider);
    let tag = acc
        .get("tag")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let pinned = acc.get("pinned").and_then(Value::as_bool).unwrap_or(false);
    let enabled = acc.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let plan_type = acc
        .get("planType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.contains('@'))
        .map(|s| Value::String(s.to_owned()))
        .unwrap_or(Value::Null);
    let status = acc
        .get("status")
        .and_then(Value::as_str)
        .filter(|s| matches!(*s, "Reporting" | "Stale" | "Paused" | "Unavailable"))
        .unwrap_or("Unavailable");

    let limits: Vec<Value> = acc
        .get("limits")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(sanitize_limit_for_mobile).collect())
        .unwrap_or_default();

    let banked_resets = sanitize_banked_for_mobile(&acc["bankedResets"]);

    let updated_at = match acc.get("updatedAt") {
        Some(Value::String(s)) if !s.is_empty() => Value::String(s.clone()),
        Some(Value::Number(n)) => Value::Number(n.clone()),
        _ => Value::Null,
    };

    let recommended = acc
        .get("recommended")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let recommend_reason = acc
        .get("recommendReason")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && !s.contains('@'))
        .map(|s| Value::String(s.to_owned()))
        .unwrap_or(Value::Null);
    let router_score = acc
        .get("routerScore")
        .and_then(Value::as_f64)
        .filter(|x| x.is_finite())
        .map(|x| json!(x))
        .unwrap_or(Value::Null);
    let has_error = acc
        .get("error")
        .is_some_and(|e| !e.is_null() && e.as_str().map_or(true, |s| !s.is_empty()));

    json!({
        "id": acc.get("id").and_then(Value::as_str).unwrap_or(""),
        "provider": provider,
        "label": label,
        "tag": tag,
        "pinned": pinned,
        "enabled": enabled,
        "planType": plan_type,
        "status": status,
        "limits": limits,
        "bankedResets": banked_resets,
        "updatedAt": updated_at,
        "recommended": recommended,
        "recommendReason": recommend_reason,
        "routerScore": router_score,
        "hasError": has_error,
    })
}

fn sanitize_limit_for_mobile(limit: &Value) -> Option<Value> {
    let obj = limit.as_object()?;
    let label = obj
        .get("label")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("Quota");
    let used = obj
        .get("usedFraction")
        .and_then(Value::as_f64)
        .filter(|x| x.is_finite())
        .map(|x| x.clamp(0.0, 1.0));
    let resets_at = match obj.get("resetsAt") {
        Some(Value::String(s)) if !s.is_empty() => Value::String(s.clone()),
        Some(Value::Number(n)) => Value::Number(n.clone()),
        _ => Value::Null,
    };

    let mut out = json!({
        "id": obj.get("id").and_then(Value::as_str).map(|s| Value::String(s.to_owned())).unwrap_or(Value::Null),
        "label": label,
        "windowId": obj.get("windowId").and_then(Value::as_str).map(|s| Value::String(s.to_owned())).unwrap_or(Value::Null),
        "durationMs": obj.get("durationMs").and_then(Value::as_f64).filter(|x| x.is_finite() && *x > 0.0).map(|x| json!(x)).unwrap_or(Value::Null),
        "usedFraction": used,
        "resetsAt": resets_at,
    });

    if let Some(pace) = obj.get("pace").and_then(Value::as_object) {
        if let Some(status) = pace.get("status").and_then(Value::as_str) {
            let mut pace_out = json!({
                "status": status,
                "durationMs": pace.get("durationMs").and_then(Value::as_f64).filter(|x| x.is_finite()),
                "elapsedFraction": pace.get("elapsedFraction").and_then(Value::as_f64).filter(|x| x.is_finite()),
                "paceDelta": pace.get("paceDelta").and_then(Value::as_f64).filter(|x| x.is_finite()),
            });
            if let Some(ex) = pace.get("exhaustsInMs").and_then(Value::as_i64) {
                pace_out["exhaustsInMs"] = json!(ex);
            }
            out["pace"] = pace_out;
        }
    }

    Some(out)
}

fn sanitize_banked_for_mobile(banked: &Value) -> Value {
    let Some(b) = banked.as_object() else {
        return Value::Null;
    };
    let Some(count) = b.get("count").and_then(Value::as_f64).filter(|x| x.is_finite()) else {
        return Value::Null;
    };
    let earliest = match b.get("earliestExpiresAt") {
        Some(Value::String(s)) if !s.is_empty() => Value::String(s.clone()),
        Some(Value::Number(n)) => Value::Number(n.clone()),
        _ => Value::Null,
    };
    let timestamp = |value: &Value| match value {
        Value::String(s) if chrono::DateTime::parse_from_rfc3339(s).is_ok() => value.clone(),
        Value::Number(n) if n.as_i64().is_some_and(|v| v > 0) => value.clone(),
        _ => Value::Null,
    };
    let items: Vec<Value> = b.get("items").and_then(Value::as_array).into_iter().flatten()
        .filter(|item| item.is_object())
        .map(|item| json!({"expiresAt": timestamp(&item["expiresAt"]), "grantedAt": timestamp(&item["grantedAt"])}))
        .collect();
    json!({
        "count": count,
        "earliestExpiresAt": earliest,
        "redeemable": b.get("redeemable").and_then(Value::as_bool).unwrap_or(false),
        "expiringSoon": b.get("expiringSoon").and_then(Value::as_bool).unwrap_or(false),
        "items": items,
    })
}

fn sanitize_reqwest_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "request timed out".to_owned()
    } else if err.is_connect() {
        "connection failed".to_owned()
    } else if err.is_redirect() {
        "unexpected redirect from relay".to_owned()
    } else if err.is_decode() {
        "invalid response from relay".to_owned()
    } else {
        "network request error".to_owned()
    }
}

async fn extract_error_message(response: reqwest::Response) -> String {
    let text = response.text().await.unwrap_or_default();
    if let Ok(v) = serde_json::from_str::<Value>(&text) {
        if let Some(msg) = v.get("error").and_then(Value::as_str) {
            let trimmed: String = msg.trim().chars().take(160).collect();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
    }
    "unexpected relay response".to_owned()
}

fn load_state(path: &Path) -> io::Result<PersistedMobileSync> {
    let raw = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(PersistedMobileSync::default()),
        Err(e) => return Err(e),
    };
    let parsed: PersistedMobileSync =
        serde_json::from_slice(&raw).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(parsed)
}

fn save_state(path: &Path, state: &PersistedMobileSync) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent"))?;
    fs::create_dir_all(parent)?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    use std::io::Write;
    serde_json::to_writer_pretty(&mut tmp, state).map_err(io::Error::other)?;
    tmp.flush()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tmp.as_file().set_permissions(fs::Permissions::from_mode(0o600));
    }
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_validation_enforces_https_except_explicit_local_dev() {
        assert!(validate_relay_url("https://relay.example.com/", false)
            .is_ok_and(|u| u == "https://relay.example.com"));
        assert!(validate_relay_url("http://relay.example.com", false).is_err());
        assert!(validate_relay_url("http://relay.example.com", true).is_err());
        assert!(validate_relay_url("http://127.0.0.1:8787/", false).is_err());
        assert!(validate_relay_url("http://127.0.0.1:8787/", true)
            .is_ok_and(|u| u == "http://127.0.0.1:8787"));
        assert!(validate_relay_url("http://localhost:8787", true)
            .is_ok_and(|u| u == "http://localhost:8787"));
        assert!(validate_relay_url("https://relay.example.com?key=secret", false).is_err());
        assert!(validate_relay_url("https://user:pass@relay.example.com", false).is_err());
        assert!(validate_relay_url("https://relay.example.com#frag", false).is_err());
    }

    #[test]
    fn aes_256_gcm_roundtrip_and_token_hash() {
        let secrets = generate_pair_secrets().unwrap();
        assert_ne!(secrets.read_key, secrets.write_key);
        assert_eq!(decode_b64url_exact(&secrets.room, 32).unwrap().len(), 32);
        assert_eq!(decode_b64url_exact(&secrets.read_key, 32).unwrap().len(), 32);
        assert_eq!(decode_b64url_exact(&secrets.write_key, 32).unwrap().len(), 32);
        assert_eq!(decode_b64url_exact(&secrets.key, 32).unwrap().len(), 32);

        let read_hash = hash_b64url_token(&secrets.read_key).unwrap();
        assert_eq!(decode_b64url_exact(&read_hash, 32).unwrap().len(), 32);

        let plaintext = br#"{"version":1,"generatedAt":1700000000000,"accounts":[]}"#;
        let (nonce, ct) = encrypt_snapshot(&secrets.key, plaintext).unwrap();
        assert_eq!(decode_b64url_exact(&nonce, 12).unwrap().len(), 12);
        let ct_bytes = URL_SAFE_NO_PAD.decode(ct.as_bytes()).unwrap();
        assert_eq!(ct_bytes.len(), plaintext.len() + 16);

        let decrypted = decrypt_snapshot(&secrets.key, &nonce, &ct).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn snapshot_whitelist_strips_credentials_emails_and_raw_errors() {
        let client_acc = json!({
            "id": "acc123",
            "provider": "codex",
            "providerId": "org_secret",
            "label": "Work Codex",
            "tag": "Work",
            "pinned": true,
            "enabled": true,
            "email": "secret@example.com",
            "planType": "pro",
            "orgName": "Secret Org",
            "projectId": "proj_123",
            "authType": "oauth",
            "credentials": { "access": "sk-secret-token" },
            "lastReport": { "raw": "sensitive" },
            "lastError": "Bearer sk-secret-token rejected",
            "error": "HTTP 401 token=sk-secret-token",
            "status": "Stale",
            "limits": [{
                "id": "5h",
                "label": "5-Hour Window",
                "windowId": "5h",
                "durationMs": 18000000.0,
                "usedFraction": 0.42,
                "resetsAt": "2026-11-14T12:00:00Z",
                "rawPayload": { "internal": true }
            }],
            "bankedResets": { "count": 2.0, "earliestExpiresAt": null, "redeemable": true, "expiringSoon": false, "extraSecret": "x", "items": [
                {"id":"secret-credit", "source":"secret-source", "expiresAt":"2999-01-01T00:00:00Z", "grantedAt":"2026-11-01T00:00:00Z"},
                {"id":"secret-credit-2", "expiresAt":"not-a-date-secret", "grantedAt":null}
            ] },
            "updatedAt": 1700000000000i64,
            "recommended": true,
            "recommendReason": "58% free",
            "routerScore": 84.5
        });

        let snap = build_safe_mobile_snapshot(&[client_acc], 1700000005000, "test-session-key");
        assert_eq!(snap["version"], 1);
        assert_eq!(snap["generatedAt"], 1700000005000i64);
        let acc = &snap["accounts"][0];
        assert_eq!(acc["provider"], "codex");
        assert_eq!(acc["label"], "Work Codex");
        assert_eq!(acc["status"], "Stale");
        assert_eq!(acc["hasError"], true);
        assert!(acc.get("credentials").is_none());
        assert!(acc.get("lastReport").is_none());
        assert!(acc.get("lastError").is_none());
        assert!(acc.get("error").is_none());
        assert!(acc.get("email").is_none());
        assert!(acc.get("orgName").is_none());
        assert!(acc.get("projectId").is_none());
        assert!(acc["limits"][0].get("rawPayload").is_none());
        assert!(acc["bankedResets"].get("extraSecret").is_none());
        assert_eq!(acc["bankedResets"]["items"][0]["expiresAt"], "2999-01-01T00:00:00Z");
        assert_eq!(acc["bankedResets"]["items"][0]["grantedAt"], "2026-11-01T00:00:00Z");
        assert!(acc["bankedResets"]["items"][0].get("id").is_none());
        assert!(acc["bankedResets"]["items"][0].get("source").is_none());
        assert!(acc["bankedResets"]["items"][1]["expiresAt"].is_null());
    }

    #[test]
    fn snapshot_removes_emails_and_uses_session_scoped_ids() {
        let accounts = vec![json!({
            "id":"internal-account-id", "provider":"codex", "label":"person@example.com",
            "tag":"name@example.com", "planType":"work@example.com", "email":"person@example.com",
            "limits":[{"id":"owner@example.com", "label":"email@example.com", "windowId":"user@example.com", "usedFraction":0.1}],
            "recommendReason":"person@example.com"
        })];
        let first = build_safe_mobile_snapshot(&accounts, 1, "session-one-secret");
        let same_session = build_safe_mobile_snapshot(&accounts, 2, "session-one-secret");
        let other_session = build_safe_mobile_snapshot(&accounts, 1, "session-two-secret");
        assert!(!first.to_string().contains('@'));
        assert_eq!(first["accounts"][0]["label"], "codex");
        assert_eq!(first["accounts"][0]["tag"], "[hidden]");
        assert_ne!(first["accounts"][0]["id"], "internal-account-id");
        assert_eq!(first["accounts"][0]["id"], same_session["accounts"][0]["id"]);
        assert_ne!(first["accounts"][0]["id"], other_session["accounts"][0]["id"]);
    }

    #[test]
    fn persisted_debug_redacts_secrets() {
        let state = PersistedMobileSync {
            enabled: true,
            relay_url: "https://relay.example.com".to_owned(),
            room: "SECRET_ROOM_VALUE".to_owned(),
            read_key: "SECRET_READ_KEY".to_owned(),
            write_key: "SECRET_WRITE_KEY".to_owned(),
            key: "SECRET_AES_KEY".to_owned(),
            ..PersistedMobileSync::default()
        };
        let debug_str = format!("{state:?}");
        assert!(!debug_str.contains("SECRET_ROOM_VALUE"));
        assert!(!debug_str.contains("SECRET_READ_KEY"));
        assert!(!debug_str.contains("SECRET_WRITE_KEY"));
        assert!(!debug_str.contains("SECRET_AES_KEY"));
    }
}
