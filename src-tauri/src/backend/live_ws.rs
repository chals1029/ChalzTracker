//! WebSocket client backed by `tokio-tungstenite` with `rustls` + `webpki-roots`.
//!
//! Security invariants:
//! - Requires `wss://` by default (`ws://` is permitted only for explicit local loopback dev opt-in).
//! - Omits the `Origin` header as a native desktop client.
//! - Enforces bounded inbound message/frame sizes and outbound text limits.
//! - Never logs URLs, room capabilities, or payloads.

use futures_util::{
    stream::{SplitSink, SplitStream},
    SinkExt, StreamExt,
};
use serde_json::Value;
use std::{net::SocketAddr, sync::Once, time::Duration};
use tokio::{net::{lookup_host, TcpStream}, time::timeout};
use tokio_tungstenite::{
    client_async_tls_with_config,
    tungstenite::{
        client::IntoClientRequest,
        error::Error as WsError,
        protocol::{frame::coding::CloseCode, CloseFrame, Message, WebSocketConfig},
    },
    Connector, MaybeTlsStream, WebSocketStream,
};
use url::{Host, Url};

const MAX_INBOUND_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_OUTBOUND_TEXT_BYTES: usize = 270 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const ADDRESS_TIMEOUT: Duration = Duration::from_secs(3);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

static INIT_RUSTLS: Once = Once::new();

fn ensure_rustls_provider() {
    INIT_RUSTLS.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[derive(Debug, PartialEq, Eq)]
pub enum WsEvent {
    Text(String),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    Close(Option<u16>, String),
}

type ClientWsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub struct WsReader {
    stream: SplitStream<ClientWsStream>,
}

pub struct WsWriter {
    stream: SplitSink<ClientWsStream, Message>,
    closed_sent: bool,
}

fn is_loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(d) => d.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
    }
}

pub async fn connect_ws(ws_url: &str, allow_local_http: bool, host_token: &str) -> Result<(WsReader, WsWriter), String> {
    let parsed = Url::parse(ws_url).map_err(|_| "Invalid WebSocket URL.".to_owned())?;
    let Some(host_enum) = parsed.host() else {
        return Err("WebSocket URL is missing a host.".to_owned());
    };
    let connector = match parsed.scheme() {
        "wss" => {
            ensure_rustls_provider();
            None
        }
        "ws" if allow_local_http && is_loopback(&host_enum) => Some(Connector::Plain),
        "ws" => {
            return Err(
                "Live relay connection requires wss:// (ws:// is only permitted for explicit local loopback development)."
                    .to_owned(),
            )
        }
        _ => return Err("Live relay connection requires wss://.".to_owned()),
    };

    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_INBOUND_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_INBOUND_MESSAGE_BYTES));

    let port = parsed.port_or_known_default().ok_or("WebSocket URL is missing a port.")?;
    let host = parsed.host_str().ok_or("WebSocket URL is missing a host.")?.trim_start_matches('[').trim_end_matches(']');
    let (ws_stream, _) = timeout(CONNECT_TIMEOUT, async {
        let addresses = lookup_host((host, port)).await
            .map_err(|err| format!("Relay address lookup failed ({}).", err.kind()))?;
        let mut v4 = Vec::new();
        let mut v6 = Vec::new();
        let mut first_is_v6 = false;
        for address in addresses {
            if v4.is_empty() && v6.is_empty() { first_is_v6 = address.is_ipv6(); }
            if address.is_ipv6() { v6.push(address); } else { v4.push(address); }
        }
        let mut ordered = Vec::with_capacity(v4.len() + v6.len());
        let mut v4 = v4.into_iter();
        let mut v6 = v6.into_iter();
        loop {
            let (first, second) = if first_is_v6 { (v6.next(), v4.next()) } else { (v4.next(), v6.next()) };
            if first.is_none() && second.is_none() { break; }
            ordered.extend(first);
            ordered.extend(second);
        }
        connect_addresses(ws_url, host_token, &ordered, config, connector, ADDRESS_TIMEOUT).await
    }).await.map_err(|_| "Relay connection timed out.".to_owned())??;

    let (write_half, read_half) = ws_stream.split();
    Ok((
        WsReader { stream: read_half },
        WsWriter {
            stream: write_half,
            closed_sent: false,
        },
    ))
}

async fn connect_addresses(
    ws_url: &str,
    host_token: &str,
    addresses: &[SocketAddr],
    config: WebSocketConfig,
    connector: Option<Connector>,
    attempt_timeout: Duration,
) -> Result<(ClientWsStream, tokio_tungstenite::tungstenite::handshake::client::Response), String> {
    let mut last_error = "Relay address lookup returned no addresses.".to_owned();
    for address in addresses {
        let mut request = ws_url.into_client_request().map_err(|_| "Invalid WebSocket request.".to_owned())?;
        let authorization = format!("Bearer {host_token}").parse().map_err(|_| "Invalid host authorization.".to_owned())?;
        request.headers_mut().insert("Authorization", authorization);
        let attempt = async {
            let tcp = TcpStream::connect(address).await.map_err(WsError::Io)?;
            client_async_tls_with_config(request, tcp, Some(config), connector.clone()).await
        };
        match timeout(attempt_timeout, attempt).await {
            Ok(Ok(connection)) => return Ok(connection),
            Ok(Err(err @ WsError::Http(_))) => return Err(sanitize_ws_connect_error(err)),
            Ok(Err(err)) => last_error = sanitize_ws_connect_error(err),
            Err(_) => last_error = "Relay connection timed out.".to_owned(),
        }
    }
    Err(last_error)
}

impl WsWriter {
    pub async fn send_text(&mut self, text: &str) -> Result<(), String> {
        if text.len() > MAX_OUTBOUND_TEXT_BYTES {
            return Err("Encrypted snapshot message exceeds WebSocket frame limit.".to_owned());
        }
        self.send_message(Message::text(text), WRITE_TIMEOUT).await
    }

    pub async fn send_ping(&mut self, payload: &[u8]) -> Result<(), String> {
        let bounded = payload[..payload.len().min(125)].to_vec();
        self.send_message(Message::Ping(bounded.into()), WRITE_TIMEOUT)
            .await
    }

    pub async fn send_pong(&mut self, payload: &[u8]) -> Result<(), String> {
        let bounded = payload[..payload.len().min(125)].to_vec();
        self.send_message(Message::Pong(bounded.into()), WRITE_TIMEOUT)
            .await
    }

    pub async fn send_close(&mut self, code: u16, reason: &str) {
        if self.closed_sent {
            return;
        }
        self.closed_sent = true;
        let mut end = reason.len().min(123);
        while end > 0 && !reason.is_char_boundary(end) {
            end -= 1;
        }
        let frame = CloseFrame {
            code: CloseCode::from(code),
            reason: reason[..end].to_owned().into(),
        };
        let _ = self
            .send_message(Message::Close(Some(frame)), Duration::from_millis(450))
            .await;
    }

    async fn send_message(&mut self, msg: Message, wait_limit: Duration) -> Result<(), String> {
        timeout(wait_limit, self.stream.send(msg))
            .await
            .map_err(|_| "WebSocket write timed out.".to_owned())?
            .map_err(sanitize_ws_io_error)
    }
}

impl WsReader {
    pub async fn recv(&mut self) -> Result<Option<WsEvent>, String> {
        loop {
            match self.stream.next().await {
                None | Some(Err(WsError::ConnectionClosed)) | Some(Err(WsError::AlreadyClosed)) => {
                    return Ok(None);
                }
                Some(Err(err)) => return Err(sanitize_ws_io_error(err)),
                Some(Ok(Message::Text(text))) => {
                    return Ok(Some(WsEvent::Text(text.to_string())));
                }
                Some(Ok(Message::Binary(_))) => {
                    // Ignore unexpected binary frames safely.
                    continue;
                }
                Some(Ok(Message::Ping(payload))) => {
                    return Ok(Some(WsEvent::Ping(payload.to_vec())));
                }
                Some(Ok(Message::Pong(payload))) => {
                    return Ok(Some(WsEvent::Pong(payload.to_vec())));
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = match frame {
                        Some(f) => {
                            let clean_reason: String =
                                f.reason.as_str().trim().chars().take(120).collect();
                            (Some(u16::from(f.code)), clean_reason)
                        }
                        None => (None, String::new()),
                    };
                    return Ok(Some(WsEvent::Close(code, reason)));
                }
                Some(Ok(Message::Frame(_))) => continue,
            }
        }
    }
}

fn sanitize_ws_connect_error(err: WsError) -> String {
    match err {
        WsError::Http(resp) => {
            let status = resp.status().as_u16();
            let detail = resp.body().as_deref().and_then(extract_json_error);
            match (status, detail) {
                (409, Some(msg)) => format!("Relay rejected live room (HTTP 409): {msg}"),
                (409, None) => "A host is already connected to this room (HTTP 409).".to_owned(),
                (code, Some(msg)) => {
                    format!("Relay rejected WebSocket upgrade (HTTP {code}): {msg}")
                }
                (code, None) => format!("Relay rejected WebSocket upgrade (HTTP {code})."),
            }
        }
        WsError::Tls(_) => "Relay TLS handshake failed.".to_owned(),
        WsError::Io(io_err) => format!("Relay connection failed ({}).", io_err.kind()),
        WsError::Url(_) => "Invalid WebSocket relay URL.".to_owned(),
        WsError::HttpFormat(_) | WsError::Protocol(_) => {
            "Relay handshake protocol error.".to_owned()
        }
        _ => "Relay connection failed.".to_owned(),
    }
}

fn sanitize_ws_io_error(err: WsError) -> String {
    match err {
        WsError::Io(io_err) => format!("WebSocket read/write error ({}).", io_err.kind()),
        WsError::Capacity(_) => "WebSocket message exceeded size limit.".to_owned(),
        WsError::Protocol(_) => "WebSocket protocol error.".to_owned(),
        WsError::Utf8 => "WebSocket message contained invalid UTF-8.".to_owned(),
        WsError::Tls(_) => "WebSocket TLS error.".to_owned(),
        _ => "WebSocket connection error.".to_owned(),
    }
}

fn extract_json_error(body: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(body).ok()?;
    let v: Value = serde_json::from_str(text.trim()).ok()?;
    let msg = v.get("error").and_then(Value::as_str)?;
    let clean: String = msg.trim().chars().take(160).collect();
    if clean.is_empty() {
        None
    } else {
        Some(clean)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::handshake::server::{Request as ServerRequest, Response as ServerResponse},
    };

    #[tokio::test]
    async fn falls_back_when_first_address_stalls_during_handshake() {
        let stalled = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let working = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addresses = [stalled.local_addr().unwrap(), working.local_addr().unwrap()];
        let stalled_task = tokio::spawn(async move {
            let (_socket, _) = stalled.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(3)).await;
        });
        let working_task = tokio::spawn(async move {
            let (socket, _) = working.accept().await.unwrap();
            tokio_tungstenite::accept_async(socket).await.unwrap()
        });
        let url = format!("ws://localhost:{}/", addresses[1].port());
        let result = connect_addresses(&url, "test", &addresses, WebSocketConfig::default(), Some(Connector::Plain), Duration::from_millis(500)).await;
        assert!(result.is_ok(), "second address should connect after a stalled handshake");
        working_task.await.unwrap();
        stalled_task.abort();
    }

    #[tokio::test]
    async fn rejects_non_loopback_ws_even_with_allow_local_http() {
        let err = connect_ws("ws://relay.example.com/v1/live/abc?role=host", true, "test")
            .await
            .err()
            .unwrap();
        assert!(err.contains("wss://"));
    }

    #[tokio::test]
    async fn handshake_masked_exchange_ping_pong_and_close_over_ephemeral_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let room = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let expected_pq = format!("/v1/live/{room}?role=host");
        let snapshot_msg = r#"{"type":"snapshot","nonce":"BBBBBBBBBBBBBBBB","ciphertext":"CCCCCCCCCCCCCCCCCCCCCC"}"#;

        let server_task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut saw_expected_path = false;
            let mut saw_origin_header = false;
            let mut ws = accept_hdr_async(
                tcp,
                |req: &ServerRequest, resp: ServerResponse| {
                    saw_expected_path = req
                        .uri()
                        .path_and_query()
                        .is_some_and(|pq| pq.as_str() == expected_pq);
                    saw_origin_header = req.headers().get("origin").is_some();
                    Ok(resp)
                },
            )
            .await
            .unwrap();

            assert!(saw_expected_path);
            assert!(!saw_origin_header);

            ws.send(Message::text(r#"{"type":"guest-joined"}"#))
                .await
                .unwrap();

            let mut received_snapshot = None;
            let mut received_close = None;
            while let Some(frame) = ws.next().await {
                match frame.unwrap() {
                    Message::Text(txt) => {
                        received_snapshot = Some(txt.to_string());
                    }
                    Message::Ping(_) => {
                        // tungstenite queues the automatic Pong reply on next flush/read.
                    }
                    Message::Close(cf) => {
                        received_close = cf.map(|f| (u16::from(f.code), f.reason.to_string()));
                        break;
                    }
                    _ => {}
                }
            }

            (received_snapshot, received_close)
        });

        let ws_url = format!("ws://127.0.0.1:{port}/v1/live/{room}?role=host");
        let (mut reader, mut writer) = connect_ws(&ws_url, true, "test").await.unwrap();

        assert_eq!(
            reader.recv().await.unwrap(),
            Some(WsEvent::Text(r#"{"type":"guest-joined"}"#.to_owned()))
        );

        writer.send_text(snapshot_msg).await.unwrap();
        writer.send_ping(b"ct").await.unwrap();

        let mut got_pong = false;
        for _ in 0..4 {
            match reader.recv().await.unwrap() {
                Some(WsEvent::Pong(p)) => {
                    assert_eq!(p, b"ct");
                    got_pong = true;
                    break;
                }
                Some(WsEvent::Ping(p)) => {
                    writer.send_pong(&p).await.unwrap();
                }
                other => panic!("unexpected frame before pong: {other:?}"),
            }
        }
        assert!(got_pong);

        writer.send_close(1000, "desktop exiting").await;
        drop(writer);

        let (received_snapshot, received_close) = server_task.await.unwrap();
        assert_eq!(received_snapshot.as_deref(), Some(snapshot_msg));
        assert_eq!(
            received_close,
            Some((1000, "desktop exiting".to_owned()))
        );
    }
}
