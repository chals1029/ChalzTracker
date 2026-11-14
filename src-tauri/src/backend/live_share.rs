//! Live browser companion sharing over a zero-knowledge Cloudflare Worker WebSocket relay.
//!
//! Security & lifetime invariants:
//! - Starts automatically when a relay is configured, unless the user disabled sharing.
//! - Uses the deployed shared relay by default, with optional operator or developer overrides.
//! - Enforces validated `https://` relay base in the share link and connects over `wss://`.
//! - Live v2 derives `room = base64url(SHA-256(host_token))` from a random 32-byte
//!   host token, sent only in the native WebSocket Authorization header. No first
//!   registration is needed, so guests cannot claim a disconnected room.
//! - Each session has an independent AES-256-GCM key and P-256 signing key. The
//!   link fragment contains the room, AES key and uncompressed public signing key,
//!   never the host token or private signing key.
//! - A snapshot signs UTF-8 `chalz-live-v2\n{room}\n{sequence}\n{nonce}\n{ciphertext}`
//!   using SHA-256 / P-256 with a 64-byte IEEE P1363 (r || s) signature. Sequence
//!   is a decimal u64, monotonically increasing across reconnects for the session.
//! - Deploy the v2 relay and companion before updating desktop clients. Existing v1
//!   live links are deliberately rejected and must be rotated; HTTP snapshot rooms
//!   retain their existing protocol. The relay's shared creation quota uses the
//!   existing ROOMS Durable Object binding and requires no schema migration.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::rand::{SecureRandom, SystemRandom};
use ring::{digest, signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fmt,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{watch, Mutex as AsyncMutex, Notify};
use url::Url;

use super::{
    live_ws::{connect_ws, WsEvent, WsWriter},
    mobile_sync::{build_safe_mobile_snapshot, decode_b64url_exact, encrypt_snapshot, validate_relay_url},
    qr::{encode_qr_matrix, QrMatrix},
};

const COMPANION_BASE_URL: &str = "https://chalztracker.vercel.app/companion/#";
const DEFAULT_RELAY_URL: &str = "https://chalztracker-relay.23-73068.workers.dev";
const TOKEN_BYTES: usize = 32;
const MAX_SNAPSHOT_BYTES: usize = 180 * 1024;
const MAX_ENVELOPE_BYTES: usize = 270 * 1024;
const SNAPSHOT_INTERVAL: Duration = Duration::from_secs(60);
const KEEPALIVE_PING_INTERVAL: Duration = Duration::from_secs(25);
const KEEPALIVE_STALE_TIMEOUT: Duration = Duration::from_secs(75);
const CHANGE_DEBOUNCE: Duration = Duration::from_millis(350);

const BUILD_TIME_RELAY_URL: Option<&str> = option_env!("CHALZ_LIVE_RELAY_URL");
const BUILD_TIME_ALLOW_LOCAL_HTTP: Option<&str> = option_env!("CHALZ_LIVE_ALLOW_LOCAL_HTTP");

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LiveStatus {
    Disabled,
    Connecting,
    Live,
    Reconnecting,
    Error,
}

impl LiveStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Connecting => "connecting",
            Self::Live => "live",
            Self::Reconnecting => "reconnecting",
            Self::Error => "error",
        }
    }
}

struct LiveShareState {
    enabled: bool,
    connected: bool,
    status: LiveStatus,
    default_relay_url: Option<String>,
    default_relay_error: Option<String>,
    default_allow_local_http: bool,
    active_relay_url: String,
    active_allow_local_http: bool,
    using_override: bool,
    room: String,
    key: String,
    host_token: String,
    signing_key: Option<Arc<EcdsaKeyPair>>,
    sequence: Arc<AtomicU64>,
    share_url: String,
    qr_matrix: Option<QrMatrix>,
    generation: u64,
    guest_events: u64,
    last_published_at: Option<i64>,
    last_error: Option<String>,
    auto_start_error: Option<String>,
}

impl fmt::Debug for LiveShareState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LiveShareState")
            .field("enabled", &self.enabled)
            .field("connected", &self.connected)
            .field("status", &self.status.as_str())
            .field("configured", &self.default_relay_url.is_some())
            .field("using_override", &self.using_override)
            .field("generation", &self.generation)
            .field("guest_events", &self.guest_events)
            .field("last_published_at", &self.last_published_at)
            .finish_non_exhaustive()
    }
}

pub struct LiveShare {
    preferences_dir: Option<PathBuf>,
    state: Mutex<LiveShareState>,
    generation: AtomicU64,
    op_lock: AsyncMutex<()>,
    cancel_tx: watch::Sender<u64>,
    pub wake: Notify,
    pub change_wake: Notify,
    pub manual_wake: Notify,
}

impl fmt::Debug for LiveShare {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = self.state.lock().unwrap();
        f.debug_struct("LiveShare").field("state", &*s).finish()
    }
}


#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoStartPreferences {
    enabled: bool,
    relay_url: String,
    allow_local_http: bool,
}

const AUTO_START_FILE: &str = "live_share_preferences.json";

fn save_auto_start(dir: &Path, preferences: &AutoStartPreferences) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    serde_json::to_writer(&mut file, preferences).map_err(io::Error::other)?;
    file.flush()?;
    file.persist(dir.join(AUTO_START_FILE)).map_err(|e| e.error)?;
    Ok(())
}

fn load_auto_start(dir: &Path) -> io::Result<Option<AutoStartPreferences>> {
    match fs::read(dir.join(AUTO_START_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(io::Error::other),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}
#[derive(Serialize)]
struct CompanionLinkPayload<'a> {
    v: u8,
    url: &'a str,
    room: &'a str,
    key: &'a str,
    public_key: &'a str,
}

impl LiveShare {
    pub fn new() -> Self {
        let (default_relay_url, default_relay_error, default_allow_local_http) = resolve_operator_relay_url();
        let (cancel_tx, _) = watch::channel(0u64);
        Self {
            preferences_dir: None,
            state: Mutex::new(LiveShareState {
                enabled: false,
                connected: false,
                status: LiveStatus::Disabled,
                default_relay_url,
                default_relay_error,
                default_allow_local_http,
                active_relay_url: String::new(),
                active_allow_local_http: false,
                using_override: false,
                room: String::new(),
                key: String::new(),
                host_token: String::new(),
                signing_key: None,
                sequence: Arc::new(AtomicU64::new(0)),
                share_url: String::new(),
                qr_matrix: None,
                generation: 0,
                guest_events: 0,
                last_published_at: None,
                last_error: None,
                auto_start_error: None,
            }),
            generation: AtomicU64::new(0),
            op_lock: AsyncMutex::new(()),
            cancel_tx,
            wake: Notify::new(),
            change_wake: Notify::new(),
            manual_wake: Notify::new(),
        }
    }

    pub fn with_preferences(dir: PathBuf) -> Self {
        let mut share = Self::new();
        share.preferences_dir = Some(dir);
        share
    }

    fn save_preferences(&self, enabled: bool, relay_url: &str, allow_local_http: bool) -> Result<(), String> {
        if let Some(dir) = &self.preferences_dir {
            save_auto_start(dir, &AutoStartPreferences {
                enabled,
                relay_url: relay_url.to_owned(),
                allow_local_http,
            }).map_err(|_| "Could not save Live Share startup settings.".to_owned())?;
        }
        Ok(())
    }

    pub async fn restore_at_startup(&self) {
        let preferences = match &self.preferences_dir {
            Some(dir) => match load_auto_start(dir) {
                Ok(preferences) => preferences,
                Err(_) => {
                    self.state.lock().unwrap().auto_start_error = Some("Could not read Live Share startup settings.".to_owned());
                    return;
                }
            },
            None => None,
        };
        let has_default_relay = self.state.lock().unwrap().default_relay_url.is_some();
        let result = match preferences {
            Some(p) if p.enabled && p.relay_url == "https://chalztracker-relay.xuanmailbridge.workers.dev" => self.enable(None, None).await.map(Some),
            Some(p) if p.enabled => self.enable(Some(&p.relay_url), Some(p.allow_local_http)).await.map(Some),
            Some(_) => Ok(None),
            None if has_default_relay => self.enable(None, None).await.map(Some),
            None => Ok(None),
        };
        if let Err(err) = result {
            self.state.lock().unwrap().auto_start_error = Some(err);
        }
    }

    pub fn is_enabled(&self) -> bool {
        let s = self.state.lock().unwrap();
        s.enabled && !s.room.is_empty() && !s.key.is_empty() && !s.active_relay_url.is_empty()
    }

    pub fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn subscribe_cancel(&self) -> watch::Receiver<u64> {
        self.cancel_tx.subscribe()
    }

    pub fn status_json(&self) -> Value {
        let s = self.state.lock().unwrap();
        let configured = s.default_relay_url.is_some();
        let live_active = s.enabled && !s.share_url.is_empty();
        json!({
            "configured": configured,
            "defaultRelayUrl": s.default_relay_url,
            "configError": s.default_relay_error,
            "defaultAllowLocalHttp": s.default_allow_local_http,
            "enabled": s.enabled,
            "connected": s.connected,
            "status": s.status.as_str(),
            "relayUrl": if s.enabled { s.active_relay_url.as_str() } else { s.default_relay_url.as_deref().unwrap_or("") },
            "allowLocalHttp": if s.enabled { s.active_allow_local_http } else { s.default_allow_local_http },
            "usingOverride": s.using_override,
            "shareUrl": if live_active { Value::String(s.share_url.clone()) } else { Value::Null },
            "qrMatrix": if live_active { s.qr_matrix.as_ref().map(|m| json!(m)).unwrap_or(Value::Null) } else { Value::Null },
            "guestEvents": s.guest_events,
            "lastPublishedAt": s.last_published_at,
            "lastError": s.last_error,
            "autoStartError": s.auto_start_error,
        })
    }

    pub async fn enable(&self, relay_url_override: Option<&str>, allow_local_http_override: Option<bool>) -> Result<Value, String> {
        let _op = self.op_lock.lock().await;
        let (target_url, target_allow_http, using_override) =
            self.resolve_target_relay(relay_url_override, allow_local_http_override)?;
        {
            let s = self.state.lock().unwrap();
            if s.enabled && !s.room.is_empty() {
                return Err("Live Browser Share is already active. Rotate or disable it first.".to_owned());
            }
        }

        let (room, key, host_token, signing_key, share_url, qr_matrix) = create_session_bundle(&target_url, target_allow_http)?;
        self.save_preferences(true, &target_url, target_allow_http)?;
        let new_gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.cancel_tx.send_replace(new_gen);

        {
            let mut s = self.state.lock().unwrap();
            s.enabled = true;
            s.connected = false;
            s.status = LiveStatus::Connecting;
            s.active_relay_url = target_url;
            s.active_allow_local_http = target_allow_http;
            s.using_override = using_override;
            s.room = room;
            s.key = key;
            s.host_token = host_token;
            s.signing_key = Some(signing_key);
            s.sequence = Arc::new(AtomicU64::new(0));
            s.share_url = share_url;
            s.qr_matrix = Some(qr_matrix);
            s.generation = new_gen;
            s.guest_events = 0;
            s.last_published_at = None;
            s.last_error = None;
            s.auto_start_error = None;
        }

        self.wake.notify_one();
        Ok(self.status_json())
    }

    pub async fn rotate(&self, relay_url_override: Option<&str>, allow_local_http_override: Option<bool>) -> Result<Value, String> {
        let _op = self.op_lock.lock().await;
        let current_url = {
            let s = self.state.lock().unwrap();
            if s.enabled && !s.active_relay_url.is_empty() {
                Some((s.active_relay_url.clone(), s.active_allow_local_http, s.using_override))
            } else {
                None
            }
        };

        let (target_url, target_allow_http, using_override) =
            match relay_url_override.map(str::trim).filter(|v| !v.is_empty()) {
                Some(raw) => {
                    let allow = allow_local_http_override
                        .unwrap_or_else(|| current_url.as_ref().map_or(false, |c| c.1));
                    (validate_live_relay_url_with_opts(raw, allow)?, allow, true)
                }
                None => match current_url {
                    Some(triple) => triple,
                    None => self.resolve_target_relay(None, allow_local_http_override)?,
                },
            };

        let (room, key, host_token, signing_key, share_url, qr_matrix) = create_session_bundle(&target_url, target_allow_http)?;
        self.save_preferences(true, &target_url, target_allow_http)?;
        let new_gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.cancel_tx.send_replace(new_gen);
        {
            let mut s = self.state.lock().unwrap();
            s.enabled = true;
            s.connected = false;
            s.status = LiveStatus::Connecting;
            s.active_relay_url = target_url;
            s.active_allow_local_http = target_allow_http;
            s.using_override = using_override;
            s.room = room;
            s.key = key;
            s.host_token = host_token;
            s.signing_key = Some(signing_key);
            s.sequence = Arc::new(AtomicU64::new(0));
            s.share_url = share_url;
            s.qr_matrix = Some(qr_matrix);
            s.generation = new_gen;
            s.guest_events = 0;
            s.last_published_at = None;
            s.last_error = None;
            s.auto_start_error = None;
        }

        self.wake.notify_one();
        Ok(self.status_json())
    }

    pub async fn disable(&self) -> Value {
        let save_error = self.save_preferences(false, "", false).err();
        let cancel_gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.cancel_tx.send_replace(cancel_gen);

        {
            let mut s = self.state.lock().unwrap();
            s.enabled = false;
            s.connected = false;
            s.status = LiveStatus::Disabled;
            s.active_relay_url.clear();
            s.active_allow_local_http = false;
            s.using_override = false;
            s.room.clear();
            s.key.clear();
            s.host_token.clear();
            s.signing_key = None;
            s.share_url.clear();
            s.qr_matrix = None;
            s.generation = cancel_gen;
            s.guest_events = 0;
            s.last_published_at = None;
            s.last_error = None;
            s.auto_start_error = save_error;
        }
        self.wake.notify_one();

        let _op = self.op_lock.lock().await;
        self.status_json()
    }

    pub fn trigger_manual_push(&self) -> Result<(), String> {
        let s = self.state.lock().unwrap();
        if !s.enabled {
            return Err("Live Browser Share is disabled.".to_owned());
        }
        if !s.connected {
            return Err("Live Browser Share is currently reconnecting to the relay.".to_owned());
        }
        drop(s);
        self.manual_wake.notify_one();
        Ok(())
    }

    fn resolve_target_relay(
        &self,
        relay_url_override: Option<&str>,
        allow_local_http_override: Option<bool>,
    ) -> Result<(String, bool, bool), String> {
        if let Some(raw) = relay_url_override.map(str::trim).filter(|s| !s.is_empty()) {
            let allow = allow_local_http_override.unwrap_or(false);
            let valid = validate_live_relay_url_with_opts(raw, allow)?;
            let is_override = {
                let s = self.state.lock().unwrap();
                s.default_relay_url.as_deref() != Some(valid.as_str())
            };
            return Ok((valid, allow, is_override));
        }

        let s = self.state.lock().unwrap();
        if let Some(url) = &s.default_relay_url {
            Ok((url.clone(), s.default_allow_local_http, false))
        } else if let Some(err) = &s.default_relay_error {
            Err(format!("Operator relay configuration is invalid: {err}"))
        } else {
            Err("Live Browser Share relay URL is not configured yet. Deploy the Cloudflare Worker relay and build with CHALZ_LIVE_RELAY_URL (or supply a developer override).".to_owned())
        }
    }

    fn session_snapshot_creds(&self) -> Option<(u64, String, bool, String, String, String, Arc<EcdsaKeyPair>, Arc<AtomicU64>)> {
        let s = self.state.lock().unwrap();
        if !s.enabled || s.room.is_empty() || s.key.is_empty() || s.active_relay_url.is_empty() {
            return None;
        }
        Some((
            s.generation,
            s.active_relay_url.clone(),
            s.active_allow_local_http,
            s.room.clone(),
            s.key.clone(),
            s.host_token.clone(),
            s.signing_key.clone()?,
            s.sequence.clone(),
        ))
    }

    fn set_connection_status(&self, expected_gen: u64, status: LiveStatus, connected: bool, error: Option<String>) {
        let mut s = self.state.lock().unwrap();
        if s.generation == expected_gen && s.enabled {
            s.status = status;
            s.connected = connected;
            s.last_error = error;
        }
    }

    fn record_guest_joined(&self, expected_gen: u64) {
        let mut s = self.state.lock().unwrap();
        if s.generation == expected_gen && s.enabled {
            s.guest_events = s.guest_events.saturating_add(1);
        }
    }

    fn record_published(&self, expected_gen: u64, at_ms: i64) {
        let mut s = self.state.lock().unwrap();
        if s.generation == expected_gen && s.enabled {
            s.last_published_at = Some(at_ms);
            s.last_error = None;
        }
    }
}

pub async fn run_live_share_loop<F, E>(
    live_share: &LiveShare,
    mut snapshot_accounts: F,
    mut emit_status: E,
    mut shutdown_rx: watch::Receiver<bool>,
) where
    F: FnMut() -> Vec<Value>,
    E: FnMut(Value),
{
    let mut backoff_secs = 1u64;

    loop {
        if *shutdown_rx.borrow() {
            return;
        }

        let Some((gen, relay_url, allow_local_http, room, key, host_token, signing_key, sequence)) = live_share.session_snapshot_creds() else {
            tokio::select! {
                _ = live_share.wake.notified() => continue,
                _ = shutdown_rx.wait_for(|v| *v) => return,
            }
        };

        let ws_url = match build_live_ws_url_with_opts(&relay_url, &room, allow_local_http) {
            Ok(u) => u,
            Err(err) => {
                live_share.set_connection_status(gen, LiveStatus::Error, false, Some(err));
                emit_status(live_share.status_json());
                tokio::select! {
                    _ = live_share.wake.notified() => continue,
                    _ = shutdown_rx.wait_for(|v| *v) => return,
                }
            }
        };

        live_share.set_connection_status(gen, LiveStatus::Connecting, false, None);
        emit_status(live_share.status_json());

        let mut cancel_rx = live_share.subscribe_cancel();
        let connect_res = tokio::select! {
            res = connect_ws(&ws_url, allow_local_http, &host_token) => Some(res),
            _ = cancel_rx.wait_for(|g| *g != gen) => None,
            _ = shutdown_rx.wait_for(|v| *v) => return,
        };

        let Some(connect_res) = connect_res else {
            continue;
        };

        let (mut reader, mut writer) = match connect_res {
            Ok(pair) => pair,
            Err(err) => {
                live_share.set_connection_status(gen, LiveStatus::Reconnecting, false, Some(err));
                emit_status(live_share.status_json());
                let wait = jittered_backoff(backoff_secs);
                backoff_secs = (backoff_secs * 2).min(30);
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = cancel_rx.wait_for(|g| *g != gen) => { backoff_secs = 1; }
                    _ = live_share.wake.notified() => { backoff_secs = 1; }
                    _ = shutdown_rx.wait_for(|v| *v) => return,
                }
                continue;
            }
        };

        backoff_secs = 1;
        live_share.set_connection_status(gen, LiveStatus::Live, true, None);
        emit_status(live_share.status_json());

        // Send an initial encrypted snapshot immediately on connect.
        let initial_accounts = snapshot_accounts();
        if let Err(err) = send_encrypted_snapshot(live_share, gen, &room, &key, &signing_key, &sequence, &initial_accounts, &mut writer).await {
            live_share.set_connection_status(gen, LiveStatus::Reconnecting, false, Some(err));
            emit_status(live_share.status_json());
            writer.send_close(1011, "send error").await;
            let wait = jittered_backoff(backoff_secs);
            backoff_secs = (backoff_secs * 2).min(30);
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = cancel_rx.wait_for(|g| *g != gen) => { backoff_secs = 1; }
                _ = live_share.wake.notified() => { backoff_secs = 1; }
                _ = shutdown_rx.wait_for(|v| *v) => return,
            }
            continue;
        }
        emit_status(live_share.status_json());

        let mut periodic = tokio::time::interval(SNAPSHOT_INTERVAL);
        periodic.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        periodic.tick().await; // consume immediate first tick

        let mut ping_interval = tokio::time::interval(KEEPALIVE_PING_INTERVAL);
        ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ping_interval.tick().await;

        let mut last_activity = tokio::time::Instant::now();
        let mut disconnect_reason: Option<String> = None;
        let mut shutting_down = false;
        let mut debounce_cancel_rx = cancel_rx.clone();
        let mut debounce_shutdown_rx = shutdown_rx.clone();

        loop {
            tokio::select! {
                _ = async { let _ = shutdown_rx.wait_for(|v| *v).await; } => {
                    shutting_down = true;
                    writer.send_close(1000, "desktop exiting").await;
                    break;
                }
                _ = async { let _ = cancel_rx.wait_for(|g| *g != gen).await; } => {
                    writer.send_close(1000, "session ended").await;
                    break;
                }
                _ = periodic.tick() => {
                    if live_share.current_generation() != gen {
                        writer.send_close(1000, "session ended").await;
                        break;
                    }
                    let accounts = snapshot_accounts();
                    match send_encrypted_snapshot(live_share, gen, &room, &key, &signing_key, &sequence, &accounts, &mut writer).await {
                        Ok(()) => emit_status(live_share.status_json()),
                        Err(err) => {
                            disconnect_reason = Some(err);
                            break;
                        }
                    }
                }
                _ = live_share.change_wake.notified() => {
                    // Coalesce burst account refreshes while staying well under relay rate limits.
                    let aborted = tokio::select! {
                        _ = tokio::time::sleep(CHANGE_DEBOUNCE) => false,
                        _ = debounce_cancel_rx.wait_for(|g| *g != gen) => true,
                        _ = debounce_shutdown_rx.wait_for(|v| *v) => { shutting_down = true; true }
                    };
                    if aborted {
                        writer.send_close(1000, if shutting_down { "desktop exiting" } else { "session ended" }).await;
                        break;
                    }
                    let accounts = snapshot_accounts();
                    match send_encrypted_snapshot(live_share, gen, &room, &key, &signing_key, &sequence, &accounts, &mut writer).await {
                        Ok(()) => emit_status(live_share.status_json()),
                        Err(err) => {
                            disconnect_reason = Some(err);
                            break;
                        }
                    }
                }
                _ = live_share.manual_wake.notified() => {
                    if live_share.current_generation() != gen {
                        writer.send_close(1000, "session ended").await;
                        break;
                    }
                    let accounts = snapshot_accounts();
                    match send_encrypted_snapshot(live_share, gen, &room, &key, &signing_key, &sequence, &accounts, &mut writer).await {
                        Ok(()) => emit_status(live_share.status_json()),
                        Err(err) => {
                            disconnect_reason = Some(err);
                            break;
                        }
                    }
                }
                _ = ping_interval.tick() => {
                    if last_activity.elapsed() > KEEPALIVE_STALE_TIMEOUT {
                        disconnect_reason = Some("Relay connection timed out (no keepalive response).".to_owned());
                        break;
                    }
                    if let Err(err) = writer.send_ping(b"ct").await {
                        disconnect_reason = Some(err);
                        break;
                    }
                }
                frame = reader.recv() => {
                    match frame {
                        Ok(Some(WsEvent::Text(text))) => {
                            last_activity = tokio::time::Instant::now();
                            if is_guest_joined_message(&text) {
                                live_share.record_guest_joined(gen);
                                let accounts = snapshot_accounts();
                                match send_encrypted_snapshot(live_share, gen, &room, &key, &signing_key, &sequence, &accounts, &mut writer).await {
                                    Ok(()) => emit_status(live_share.status_json()),
                                    Err(err) => {
                                        disconnect_reason = Some(err);
                                        break;
                                    }
                                }
                            }
                        }
                        Ok(Some(WsEvent::Ping(payload))) => {
                            last_activity = tokio::time::Instant::now();
                            if let Err(err) = writer.send_pong(&payload).await {
                                disconnect_reason = Some(err);
                                break;
                            }
                        }
                        Ok(Some(WsEvent::Pong(_))) => {
                            last_activity = tokio::time::Instant::now();
                        }
                        Ok(Some(WsEvent::Close(code, reason))) => {
                            let _ = writer.send_close(1000, "closing").await;
                            disconnect_reason = Some(describe_ws_close(code, &reason));
                            break;
                        }
                        Ok(None) => {
                            disconnect_reason = Some("Relay closed the live connection.".to_owned());
                            break;
                        }
                        Err(err) => {
                            disconnect_reason = Some(err);
                            break;
                        }
                    }
                }
            }
        }

        if shutting_down {
            return;
        }

        if live_share.current_generation() == gen && live_share.is_enabled() {
            live_share.set_connection_status(gen, LiveStatus::Reconnecting, false, disconnect_reason);
            emit_status(live_share.status_json());

            let wait = jittered_backoff(backoff_secs);
            backoff_secs = (backoff_secs * 2).min(30);
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = cancel_rx.wait_for(|g| *g != gen) => { backoff_secs = 1; }
                _ = live_share.wake.notified() => { backoff_secs = 1; }
                _ = shutdown_rx.wait_for(|v| *v) => return,
            }
        }
    }
}

async fn send_encrypted_snapshot(
    live_share: &LiveShare,
    expected_gen: u64,
    room: &str,
    key: &str,
    signing_key: &EcdsaKeyPair,
    sequence: &AtomicU64,
    accounts: &[Value],
    writer: &mut WsWriter,
) -> Result<(), String> {
    if live_share.current_generation() != expected_gen {
        return Ok(());
    }
    let at = now_ms();
    let seq = sequence.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
        .map_err(|_| "Live sequence exhausted.")? + 1;
    let msg = build_encrypted_snapshot_message(room, key, signing_key, seq, accounts, at)?;
    writer.send_text(&msg).await?;
    live_share.record_published(expected_gen, at);
    Ok(())
}

fn build_encrypted_snapshot_message(
    room: &str,
    key: &str,
    signing_key: &EcdsaKeyPair,
    sequence: u64,
    accounts: &[Value],
    generated_at: i64,
) -> Result<String, String> {
    let snapshot = build_safe_mobile_snapshot(accounts, generated_at, key);
    let plaintext = serde_json::to_vec(&snapshot)
        .map_err(|_| "Could not serialize live snapshot.".to_owned())?;
    if plaintext.len() > MAX_SNAPSHOT_BYTES {
        return Err("Snapshot exceeds maximum size limit for live relay.".to_owned());
    }
    let (nonce, ciphertext) = encrypt_snapshot(key, &plaintext)?;
    let signed = format!("chalz-live-v2\n{room}\n{sequence}\n{nonce}\n{ciphertext}");
    let signature = signing_key.sign(&SystemRandom::new(), signed.as_bytes())
        .map_err(|_| "Could not sign live snapshot.".to_owned())?;
    let envelope = json!({
        "type": "snapshot",
        "nonce": nonce,
        "ciphertext": ciphertext,
        "sequence": sequence.to_string(),
        "signature": URL_SAFE_NO_PAD.encode(signature.as_ref()),
    });
    let text = serde_json::to_string(&envelope)
        .map_err(|_| "Could not encode encrypted snapshot envelope.".to_owned())?;
    if text.len() > MAX_ENVELOPE_BYTES {
        return Err("Encrypted snapshot envelope exceeds relay WebSocket limit.".to_owned());
    }
    Ok(text)
}

pub fn is_guest_joined_message(text: &str) -> bool {
    let Ok(val) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    val.get("type").and_then(Value::as_str) == Some("guest-joined")
}

fn describe_ws_close(code: Option<u16>, reason: &str) -> String {
    let suffix = if reason.is_empty() {
        String::new()
    } else {
        format!(": {reason}")
    };
    match code {
        Some(4003) => format!("Relay rejected non-text live message (4003){suffix}"),
        Some(4008) => format!("Relay rejected snapshot envelope or rate limit (4008){suffix}"),
        Some(4009) => format!("Encrypted snapshot exceeded relay 270 KiB limit (4009){suffix}"),
        Some(c) => format!("Relay disconnected (code {c}){suffix}"),
        None => "Relay disconnected.".to_owned(),
    }
}

fn jittered_backoff(base_secs: u64) -> Duration {
    let mut buf = [0u8; 2];
    let jitter_ms = if SystemRandom::new().fill(&mut buf).is_ok() {
        (u16::from_le_bytes(buf) % 500) as u64
    } else {
        150
    };
    Duration::from_secs(base_secs) + Duration::from_millis(jitter_ms)
}

fn parse_env_bool(raw: Option<&str>) -> bool {
    raw.map(str::trim)
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}

fn resolve_operator_relay_url() -> (Option<String>, Option<String>, bool) {
    let compile_raw = BUILD_TIME_RELAY_URL.map(str::trim).filter(|s| !s.is_empty());
    let runtime_raw = std::env::var("CHALZ_LIVE_RELAY_URL")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());

    let raw = compile_raw.map(str::to_owned).or(runtime_raw).unwrap_or_else(|| DEFAULT_RELAY_URL.to_owned());
    let runtime_allow_raw = std::env::var("CHALZ_LIVE_ALLOW_LOCAL_HTTP").ok();
    let allow_local_http =
        parse_env_bool(BUILD_TIME_ALLOW_LOCAL_HTTP) || parse_env_bool(runtime_allow_raw.as_deref());

    match validate_live_relay_url_with_opts(&raw, allow_local_http) {
        Ok(valid) => (Some(valid), None, allow_local_http),
        Err(err) => (None, Some(err), allow_local_http),
    }
}

pub fn validate_live_relay_url(raw: &str) -> Result<String, String> {
    validate_live_relay_url_with_opts(raw, false)
}

pub fn validate_live_relay_url_with_opts(raw: &str, allow_local_http: bool) -> Result<String, String> {
    let valid = validate_relay_url(raw, allow_local_http)?;
    let parsed = Url::parse(&valid).map_err(|_| "Relay URL is not a valid URL.".to_owned())?;
    if parsed.path().starts_with("/v1/") {
        return Err(
            "Relay URL must be the base HTTPS origin without /v1/ endpoint paths.".to_owned(),
        );
    }
    Ok(valid)
}

pub fn build_live_ws_url(relay_url: &str, room: &str) -> Result<String, String> {
    build_live_ws_url_with_opts(relay_url, room, false)
}

pub fn build_live_ws_url_with_opts(
    relay_url: &str,
    room: &str,
    allow_local_http: bool,
) -> Result<String, String> {
    let valid_base = validate_live_relay_url_with_opts(relay_url, allow_local_http)?;
    decode_b64url_exact(room, TOKEN_BYTES)?;
    if let Some(rest) = valid_base.strip_prefix("https://") {
        Ok(format!("wss://{rest}/v1/live/{room}?role=host"))
    } else if allow_local_http {
        let rest = valid_base
            .strip_prefix("http://")
            .ok_or_else(|| "Relay URL must use https://.".to_owned())?;
        Ok(format!("ws://{rest}/v1/live/{room}?role=host"))
    } else {
        Err("Relay URL must use https://.".to_owned())
    }
}

pub fn build_companion_link_with_opts(
    relay_url: &str,
    room: &str,
    key: &str,
    public_key: &str,
    allow_local_http: bool,
) -> Result<String, String> {
    let valid_url = validate_live_relay_url_with_opts(relay_url, allow_local_http)?;
    decode_b64url_exact(room, TOKEN_BYTES)?;
    decode_b64url_exact(key, TOKEN_BYTES)?;
    decode_b64url_exact(public_key, 65)?;

    let payload = CompanionLinkPayload {
        v: 2,
        url: &valid_url,
        room,
        key,
        public_key,
    };
    let json_bytes = serde_json::to_vec(&payload)
        .map_err(|_| "Could not encode companion link payload.".to_owned())?;
    let fragment = URL_SAFE_NO_PAD.encode(&json_bytes);
    let base_url = if valid_url.starts_with("http://") {
        "http://127.0.0.1:4174/companion/#"
    } else {
        COMPANION_BASE_URL
    };
    Ok(format!("{base_url}{fragment}"))
}

fn create_session_bundle(
    relay_url: &str,
    allow_local_http: bool,
) -> Result<(String, String, String, Arc<EcdsaKeyPair>, String, QrMatrix), String> {
    let rng = SystemRandom::new();
    let host_token = random_b64url_32(&rng)?;
    let host_bytes = decode_b64url_exact(&host_token, TOKEN_BYTES)?;
    let room = URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, &host_bytes).as_ref());
    let mut key = random_b64url_32(&rng)?;
    while key == room {
        key = random_b64url_32(&rng)?;
    }
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng)
        .map_err(|_| "Could not generate live signing key.".to_owned())?;
    let signing_key = Arc::new(EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
        .map_err(|_| "Could not initialize live signing key.".to_owned())?);
    let public_key = URL_SAFE_NO_PAD.encode(signing_key.public_key().as_ref());
    let share_url = build_companion_link_with_opts(relay_url, &room, &key, &public_key, allow_local_http)?;
    let qr = encode_qr_matrix(share_url.as_bytes())?;
    Ok((room, key, host_token, signing_key, share_url, qr))
}
fn random_b64url_32(rng: &SystemRandom) -> Result<String, String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    rng.fill(&mut bytes)
        .map_err(|_| "Could not generate cryptographic randomness.".to_owned())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::mobile_sync::decrypt_snapshot;

    #[test]
    fn validates_strict_https_relay_base_and_builds_wss_url() {
        assert_eq!(
            validate_live_relay_url("https://relay.example.com/").unwrap(),
            "https://relay.example.com"
        );
        assert!(validate_live_relay_url("http://relay.example.com").is_err());
        assert!(validate_live_relay_url("http://127.0.0.1:8787").is_err());
        assert!(validate_live_relay_url("wss://relay.example.com").is_err());
        assert!(validate_live_relay_url("https://user:pass@relay.example.com").is_err());
        assert!(validate_live_relay_url("https://relay.example.com?a=1").is_err());
        assert!(validate_live_relay_url("https://relay.example.com#frag").is_err());
        assert!(validate_live_relay_url("https://relay.example.com/v1/live/abc").is_err());

        let rng = SystemRandom::new();
        let room = random_b64url_32(&rng).unwrap();
        let ws = build_live_ws_url("https://relay.example.com/", &room).unwrap();
        assert_eq!(ws, format!("wss://relay.example.com/v1/live/{room}?role=host"));

        assert!(validate_live_relay_url_with_opts("http://127.0.0.1:8787", false).is_err());
        assert_eq!(
            validate_live_relay_url_with_opts("http://127.0.0.1:8787/", true).unwrap(),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            build_live_ws_url_with_opts("http://localhost:8787", &room, true).unwrap(),
            format!("ws://localhost:8787/v1/live/{room}?role=host")
        );
    }

    #[test]
    fn builds_and_validates_companion_link_fragment() {
        let (room, key, host_token, signing_key, link, qr) =
            create_session_bundle("https://chalztracker-relay.example.workers.dev/", false).unwrap();
        assert_ne!(room, key);
        assert!(link.starts_with("https://chalztracker.vercel.app/companion/#"));

        let fragment = link.strip_prefix("https://chalztracker.vercel.app/companion/#").unwrap();
        let raw_json = URL_SAFE_NO_PAD.decode(fragment.as_bytes()).unwrap();
        let parsed: Value = serde_json::from_slice(&raw_json).unwrap();
        assert_eq!(parsed["v"], 2);
        assert_eq!(parsed["url"], "https://chalztracker-relay.example.workers.dev");
        assert_eq!(parsed["room"], room);
        let host_bytes = decode_b64url_exact(&host_token, TOKEN_BYTES).unwrap();
        assert_eq!(room, URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, &host_bytes).as_ref()));
        assert_eq!(parsed["key"], key);
        assert_eq!(parsed["public_key"], URL_SAFE_NO_PAD.encode(signing_key.public_key().as_ref()));
        assert!(!link.contains(&host_token));
        assert!(parsed.get("host_token").is_none());
        assert!(qr.size >= 57);
        assert_eq!(qr.rows.len(), qr.size);
        let public_key = URL_SAFE_NO_PAD.encode(signing_key.public_key().as_ref());
        let local_link = build_companion_link_with_opts("http://127.0.0.1:8787", &room, &key, &public_key, true).unwrap();
        assert!(local_link.starts_with("http://127.0.0.1:4174/companion/#"));
    }
    #[test]
    fn encrypted_snapshot_message_uses_whitelisted_fields_and_aes_gcm() {
        let (room, key, _, signing_key, _, _) = create_session_bundle("https://relay.example.com", false).unwrap();
        let client_acc = json!({
            "id": "acc1",
            "provider": "codex",
            "label": "Work",
            "email": "private@example.com",
            "credentials": { "access": "secret-token" },
            "status": "Reporting",
            "limits": [{
                "id": "5h",
                "label": "5-Hour Window",
                "usedFraction": 0.25,
                "resetsAt": 1700003600000i64
            }],
            "updatedAt": 1700000000000i64
        });

        let msg_text = build_encrypted_snapshot_message(&room, &key, &signing_key, 1, &[client_acc], 1700000001000).unwrap();
        let envelope: Value = serde_json::from_str(&msg_text).unwrap();
        assert_eq!(envelope["type"], "snapshot");
        let nonce = envelope["nonce"].as_str().unwrap();
        let ct = envelope["ciphertext"].as_str().unwrap();
        let sig = URL_SAFE_NO_PAD.decode(envelope["signature"].as_str().unwrap()).unwrap();
        let signed = format!("chalz-live-v2\n{room}\n1\n{nonce}\n{ct}");
        let verifier = ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, signing_key.public_key().as_ref());
        assert!(verifier.verify(signed.as_bytes(), &sig).is_ok());
        assert!(verifier.verify(format!("chalz-live-v2\nother-room\n1\n{nonce}\n{ct}").as_bytes(), &sig).is_err());
        assert!(verifier.verify(format!("chalz-live-v2\n{room}\n1\n{nonce}\n{ct}x").as_bytes(), &sig).is_err());
        assert!(verifier.verify(format!("chalz-live-v2\n{room}\n2\n{nonce}\n{ct}").as_bytes(), &sig).is_err());

        let plaintext = decrypt_snapshot(&key, nonce, ct).unwrap();
        let decrypted: Value = serde_json::from_slice(&plaintext).unwrap();
        assert_eq!(decrypted["version"], 1);
        assert_eq!(decrypted["generatedAt"], 1700000001000i64);
        let acc = &decrypted["accounts"][0];
        assert_eq!(acc["label"], "Work");
        assert!(acc.get("email").is_none());
        assert!(acc.get("credentials").is_none());
    }

    #[test]
    fn debug_never_leaks_room_key_or_share_url() {
        let share = LiveShare::new();
        {
            let mut s = share.state.lock().unwrap();
            s.enabled = true;
            s.active_relay_url = "https://relay.example.com".to_owned();
            s.room = "SUPER_SECRET_ROOM_TOKEN".to_owned();
            s.key = "SUPER_SECRET_AES_KEY".to_owned();
            s.share_url = "https://chalztracker.vercel.app/companion/#SECRET_FRAGMENT".to_owned();
        }
        let dbg = format!("{share:?}");
        assert!(!dbg.contains("SUPER_SECRET_ROOM_TOKEN"));
        assert!(!dbg.contains("SUPER_SECRET_AES_KEY"));
        assert!(!dbg.contains("SECRET_FRAGMENT"));
    }

    #[test]
    fn guest_joined_detection_matches_protocol() {
        assert!(is_guest_joined_message(r#"{"type":"guest-joined"}"#));
        assert!(!is_guest_joined_message(r#"{"type":"ping"}"#));
        assert!(!is_guest_joined_message("not-json"));
    }

    #[tokio::test]
    async fn enable_rotate_and_disable_manage_ephemeral_secrets() {
        let share = LiveShare::new();
        assert!(!share.is_enabled());
        let initial = share.status_json();
        assert_eq!(initial["enabled"], false);
        assert!(initial["shareUrl"].is_null());

        let enabled = share.enable(Some("https://relay.example.com"), None).await.unwrap();
        assert_eq!(enabled["enabled"], true);
        assert_eq!(enabled["connected"], false);
        assert_eq!(enabled["status"], "connecting");
        let first_link = enabled["shareUrl"].as_str().unwrap().to_owned();
        assert_eq!(*share.subscribe_cancel().borrow(), share.current_generation());
        assert!(first_link.starts_with("https://chalztracker.vercel.app/companion/#"));

        let rotated = share.rotate(None, None).await.unwrap();
        let second_link = rotated["shareUrl"].as_str().unwrap().to_owned();
        assert_ne!(first_link, second_link);

        assert_eq!(*share.subscribe_cancel().borrow(), share.current_generation());
        let disabled = share.disable().await;
        assert_eq!(disabled["enabled"], false);
        assert_eq!(disabled["connected"], false);
        assert_eq!(disabled["status"], "disabled");
        assert!(disabled["shareUrl"].is_null());
        assert!(disabled["qrMatrix"].is_null());
        assert_eq!(*share.subscribe_cancel().borrow(), share.current_generation());
        assert!(!share.is_enabled());
    }

    #[tokio::test]
    async fn startup_restores_enabled_relay_and_respects_explicit_disable() {
        let dir = tempfile::tempdir().unwrap();
        let first = LiveShare::with_preferences(dir.path().to_owned());
        first.enable(Some("http://127.0.0.1:8787"), Some(true)).await.unwrap();
        let first_link = first.status_json()["shareUrl"].as_str().unwrap().to_owned();
        let saved = fs::read_to_string(dir.path().join(AUTO_START_FILE)).unwrap();
        assert!(!saved.contains(&first_link));
        assert!(!saved.contains(&first.state.lock().unwrap().key));

        let restarted = LiveShare::with_preferences(dir.path().to_owned());
        restarted.restore_at_startup().await;
        assert!(restarted.is_enabled());
        assert_eq!(restarted.status_json()["relayUrl"], "http://127.0.0.1:8787");
        assert_ne!(restarted.status_json()["shareUrl"], first_link);
        restarted.disable().await;
        let disabled = LiveShare::with_preferences(dir.path().to_owned());
        disabled.state.lock().unwrap().default_relay_url = Some("https://relay.example.com".to_owned());
        disabled.restore_at_startup().await;
        assert!(!disabled.is_enabled());
    }

    #[tokio::test]
    async fn startup_migrates_previous_default_relay() {
        let dir = tempfile::tempdir().unwrap();
        save_auto_start(dir.path(), &AutoStartPreferences {
            enabled: true,
            relay_url: "https://chalztracker-relay.xuanmailbridge.workers.dev".to_owned(),
            allow_local_http: false,
        }).unwrap();
        let share = LiveShare::with_preferences(dir.path().to_owned());
        share.state.lock().unwrap().default_relay_url = Some("https://new-relay.example.com".to_owned());
        share.restore_at_startup().await;
        assert_eq!(share.status_json()["relayUrl"], "https://new-relay.example.com");
        assert_eq!(load_auto_start(dir.path()).unwrap().unwrap().relay_url, "https://new-relay.example.com");
    }

    #[tokio::test]
    async fn startup_enables_operator_config_without_saved_preferences() {
        let dir = tempfile::tempdir().unwrap();
        let share = LiveShare::with_preferences(dir.path().to_owned());
        share.state.lock().unwrap().default_relay_url = Some("https://relay.example.com".to_owned());
        share.restore_at_startup().await;
        assert!(share.is_enabled());
        assert_eq!(share.status_json()["relayUrl"], "https://relay.example.com");
    }

    #[tokio::test]
    async fn enabled_session_connects_and_sends_snapshot_without_prior_subscribers() {
        use futures_util::StreamExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let relay = format!("http://{}", listener.local_addr().unwrap());
        let share = std::sync::Arc::new(LiveShare::new());
        share.enable(Some(&relay), Some(true)).await.unwrap();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let task_share = share.clone();
        let task = tokio::spawn(async move {
            run_live_share_loop(&task_share, Vec::new, |_| {}, shutdown_rx).await;
        });
        let (tcp, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept()).await.unwrap().unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let message = tokio::time::timeout(Duration::from_secs(3), ws.next()).await.unwrap().unwrap().unwrap();
        let envelope: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        assert_eq!(envelope["type"], "snapshot");
        assert_eq!(share.status_json()["connected"], true);
        shutdown_tx.send_replace(true);
        tokio::time::timeout(Duration::from_secs(3), task).await.unwrap().unwrap();
    }
}
