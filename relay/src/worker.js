import { DurableObject } from "cloudflare:workers";

const TOKEN_BYTES = 32;
const NONCE_BYTES = 12;
const MIN_CIPHERTEXT_BYTES = 16; // AES-GCM 16-byte authentication tag
const MAX_CIPHERTEXT_BYTES = 192 * 1024;
const MAX_CREATE_BODY_BYTES = 1024;
const MAX_PUT_BODY_BYTES = 256 * 1024;
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LIVE_MESSAGE_BYTES = 270 * 1024;
const MAX_LIVE_GUESTS = 16;
const LIVE_RATE_WINDOW_MS = 10 * 1000;
const LIVE_RATE_MAX_MESSAGES = 30;
const CREATE_WINDOW_MS = 60 * 1000;
const CREATE_GLOBAL_LIMIT = 30;
const CREATE_CLIENT_LIMIT = 10;
const CREATE_DAY_MS = 24 * 60 * 60 * 1000;
const CREATE_DAILY_LIMIT = 200;
const LIVE_JOIN_NOTIFY_MS = 1000;
const WS_CONNECTING = typeof WebSocket !== "undefined" && typeof WebSocket.CONNECTING === "number" ? WebSocket.CONNECTING : 0;
const WS_OPEN = typeof WebSocket !== "undefined" && typeof WebSocket.OPEN === "number" ? WebSocket.OPEN : 1;
const WS_CLOSED = typeof WebSocket !== "undefined" && typeof WebSocket.CLOSED === "number" ? WebSocket.CLOSED : 3;
const DEFAULT_ALLOWED_ORIGINS = ["https://chalztracker.vercel.app"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function errorResponse(status, message, extraHeaders = {}) {
  return jsonResponse(status, { error: message }, extraHeaders);
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function parseAllowedOrigins(env) {
  const allowed = new Set(DEFAULT_ALLOWED_ORIGINS);
  const raw = env && typeof env.ALLOWED_ORIGINS === "string" ? env.ALLOWED_ORIGINS : "";
  if (raw.trim().length > 0) {
    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      try {
        const parsed = new URL(trimmed);
        if (
          (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) &&
          parsed.origin === trimmed
        ) {
          allowed.add(parsed.origin);
        }
      } catch {
        // Ignore malformed configured origin entries
      }
    }
  }
  return allowed;
}

function isAllowedOrigin(originHeader, env) {
  if (typeof originHeader !== "string" || originHeader.length === 0 || originHeader === "null") {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(originHeader);
  } catch {
    return false;
  }
  if (parsed.origin !== originHeader) {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    return false;
  }
  if (isLoopbackHost(parsed.hostname)) {
    return true;
  }
  return parseAllowedOrigins(env).has(parsed.origin);
}

function normalizeCloseCode(code, fallback = 1000) {
  if (typeof code !== "number" || !Number.isInteger(code)) {
    return fallback;
  }
  if (code === 1000 || (code >= 3000 && code <= 4999)) {
    return code;
  }
  return fallback;
}

function truncateUtf8Bytes(value, maxBytes) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) {
    return value;
  }
  let result = "";
  let bytes = 0;
  for (const ch of value) {
    const chBytes = encoder.encode(ch).byteLength;
    if (bytes + chBytes > maxBytes) {
      break;
    }
    result += ch;
    bytes += chBytes;
  }
  return result;
}

function validateLiveSnapshotEnvelope(message) {
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_LIVE_MESSAGE_BYTES) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const keys = Object.keys(parsed);
  if (
    keys.length !== 5 ||
    !Object.prototype.hasOwnProperty.call(parsed, "type") ||
    !Object.prototype.hasOwnProperty.call(parsed, "nonce") ||
    !Object.prototype.hasOwnProperty.call(parsed, "ciphertext") ||
    !Object.prototype.hasOwnProperty.call(parsed, "sequence") ||
    !Object.prototype.hasOwnProperty.call(parsed, "signature") ||
    parsed.type !== "snapshot"
  ) {
    return null;
  }
  if (!decodeBase64UrlStrict(parsed.nonce, NONCE_BYTES)) {
    return null;
  }
  if (!decodeBase64UrlStrict(parsed.ciphertext, null, MIN_CIPHERTEXT_BYTES, MAX_CIPHERTEXT_BYTES)) {
    return null;
  }
  if (typeof parsed.sequence !== "string" || !/^[1-9][0-9]{0,19}$/.test(parsed.sequence) ||
      !decodeBase64UrlStrict(parsed.signature, 64)) return null;
  return parsed;
}

function encodeBase64Url(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64UrlStrict(value, exactBytes = null, minBytes = 0, maxBytes = Infinity) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  if (value.length % 4 === 1) {
    return null;
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // Reject non-canonical trailing bits.
  if (encodeBase64Url(bytes) !== value) {
    return null;
  }
  if (exactBytes !== null && bytes.byteLength !== exactBytes) {
    return null;
  }
  if (bytes.byteLength < minBytes || bytes.byteLength > maxBytes) {
    return null;
  }
  return bytes;
}

function constantTimeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.byteLength !== b.byteLength) {
    return false;
  }
  if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

function extractBearerTokenBytes(request) {
  const auth = request.headers.get("Authorization");
  if (!auth) return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/i.exec(auth.trim());
  if (!match) return null;
  return decodeBase64UrlStrict(match[1], TOKEN_BYTES);
}

class PayloadTooLargeError extends Error {}
class InvalidMediaTypeError extends Error {}
class InvalidJsonError extends Error {}

async function readJsonBounded(request, maxBytes) {
  const contentType = request.headers.get("Content-Type") || "";
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new InvalidMediaTypeError("Content-Type must be application/json.");
  }

  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new PayloadTooLargeError("Payload exceeds size limit.");
    }
  }

  if (!request.body) {
    throw new InvalidJsonError("Request body is required.");
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PayloadTooLargeError("Payload exceeds size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
  } catch {
    throw new InvalidJsonError("Invalid JSON request body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidJsonError("Request body must be a JSON object.");
  }
  return parsed;
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

export class RoomObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.utf8Encoder = new TextEncoder();
    this.disconnectedSessions = new Set();
    this.hostRateWindows = new Map();
    this.latestSnapshot = null;
    this.lastJoinNotification = 0;
  }

  ensureSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS room (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        read_hash BLOB NOT NULL,
        write_hash BLOB NOT NULL,
        nonce TEXT,
        ciphertext TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER
      );
    `);
  }

  getRoomRow() {
    const tables = this.sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room';"
    ).toArray();
    if (tables.length === 0) {
      return null;
    }
    const rows = this.sql.exec(
      "SELECT read_hash, write_hash, nonce, ciphertext, created_at, updated_at FROM room WHERE id = 1;"
    ).toArray();
    return rows.length > 0 ? rows[0] : null;
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/live/")) {
        return await this.handleLiveUpgrade(request, url);
      }
      if (url.pathname === "/internal/create-quota" && request.method === "POST") {
        return this.handleCreateQuota(request);
        
      }

      switch (request.method) {
        case "POST":
          return await this.handleCreate(request);
        case "PUT":
          return await this.handlePut(request);
        case "GET":
          return await this.handleGet(request);
        case "DELETE":
          return await this.handleDelete(request);
        default:
          return errorResponse(405, "Method not allowed.");
      }
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return errorResponse(413, err.message);
      }
      if (err instanceof InvalidMediaTypeError) {
        return errorResponse(415, err.message);
      }
      if (err instanceof InvalidJsonError) {
        return errorResponse(400, err.message);
      }
      return errorResponse(500, "Internal relay error.");
    }
  }

  // A single named Durable Object serializes quota decisions across all room IDs.
  // This bounds room allocations, not billed requests or distributed denial of service;
  // deploy Cloudflare edge rate limits and abuse controls as a separate protection.
  handleCreateQuota(request) {
    const client = request.headers.get("X-Quota-Client");
    if (!client || !/^[A-Za-z0-9_-]{43}$/.test(client)) return errorResponse(503, "Creation quota unavailable.");
    const now = Date.now();
    const window = Math.floor(now / CREATE_WINDOW_MS);
    const day = Math.floor(now / CREATE_DAY_MS);
    this.sql.exec("CREATE TABLE IF NOT EXISTS creation_quota (client TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS creation_daily_quota (id INTEGER PRIMARY KEY CHECK (id = 1), day INTEGER NOT NULL, count INTEGER NOT NULL)");
    const allowed = this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM creation_quota WHERE window != ?", window);
      const global = this.sql.exec("SELECT count FROM creation_quota WHERE client = '*' AND window = ?", window).toArray()[0]?.count || 0;
      const count = this.sql.exec("SELECT count FROM creation_quota WHERE client = ? AND window = ?", client, window).toArray()[0]?.count || 0;
      const daily = this.sql.exec("SELECT count FROM creation_daily_quota WHERE id = 1 AND day = ?", day).toArray()[0]?.count || 0;
      if (global >= CREATE_GLOBAL_LIMIT || count >= CREATE_CLIENT_LIMIT || daily >= CREATE_DAILY_LIMIT) return false;
      this.sql.exec("INSERT INTO creation_quota (client, window, count) VALUES ('*', ?, 1) ON CONFLICT(client) DO UPDATE SET count = count + 1", window);
      this.sql.exec("INSERT INTO creation_quota (client, window, count) VALUES (?, ?, 1) ON CONFLICT(client) DO UPDATE SET count = count + 1", client, window);
      this.sql.exec("INSERT INTO creation_daily_quota (id, day, count) VALUES (1, ?, 1) ON CONFLICT(id) DO UPDATE SET count = CASE WHEN day = excluded.day THEN count + 1 ELSE 1 END, day = excluded.day", day);
      return true;
    });
    return allowed ? jsonResponse(200, { ok: true }) : errorResponse(429, "Room creation rate limit exceeded.");
  }


  safeGetAttachment(ws) {
    try {
      const att = ws.deserializeAttachment();
      return att && typeof att === "object" ? att : null;
    } catch {
      return null;
    }
  }

  safeClose(ws, code = 1000, reason = "") {
    if (!ws || ws.readyState === WS_CLOSED) {
      return;
    }
    const safeCode = normalizeCloseCode(code, 1000);
    const safeReason = truncateUtf8Bytes(reason, 123);
    try {
      ws.close(safeCode, safeReason);
    } catch {
      try {
        ws.close(1000);
      } catch {}
    }
  }

  getActiveHostSocket() {
    for (const ws of this.ctx.getWebSockets("host")) {
      if (ws.readyState !== WS_OPEN) continue;
      const att = this.safeGetAttachment(ws);
      if (!att || att.role !== "host" || typeof att.sessionId !== "string") continue;
      if (this.disconnectedSessions.has(att.sessionId)) continue;
      return { ws, sessionId: att.sessionId };
    }
    return null;
  }

  getActiveGuestSockets(sessionId) {
    const active = [];
    for (const ws of this.ctx.getWebSockets("guest")) {
      if (ws.readyState !== WS_OPEN) continue;
      const att = this.safeGetAttachment(ws);
      if (!att || att.role !== "guest" || att.sessionId !== sessionId) continue;
      active.push(ws);
    }
    return active;
  }

  allowHostMessage(sessionId) {
    const now = Date.now();
    let entry = this.hostRateWindows.get(sessionId);
    if (!entry || now - entry.windowStart >= LIVE_RATE_WINDOW_MS) {
      entry = { windowStart: now, count: 1 };
      this.hostRateWindows.set(sessionId, entry);
      if (this.hostRateWindows.size > 16) {
        for (const [k, v] of this.hostRateWindows) {
          if (now - v.windowStart >= LIVE_RATE_WINDOW_MS) {
            this.hostRateWindows.delete(k);
          }
        }
      }
      return true;
    }
    entry.count += 1;
    return entry.count <= LIVE_RATE_MAX_MESSAGES;
  }

  async handleLiveUpgrade(request, url) {
    if (request.method !== "GET") {
      return errorResponse(405, "Method not allowed.");
    }
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return errorResponse(426, "Expected WebSocket upgrade.", { Upgrade: "websocket" });
    }

    const roles = url.searchParams.getAll("role");
    if (roles.length !== 1 || (roles[0] !== "host" && roles[0] !== "guest")) {
      return errorResponse(400, "Query parameter role must be 'host' or 'guest'.");
    }
    const role = roles[0];

    if (role === "host") {
      const token = extractBearerTokenBytes(request);
      const room = url.pathname.slice("/v1/live/".length);
      const roomBytes = decodeBase64UrlStrict(room, TOKEN_BYTES);
      if (!token || !roomBytes || !constantTimeEqual(await sha256Bytes(token), roomBytes)) {
        return errorResponse(403, "Host authorization required.");
      }
      if (this.getActiveHostSocket()) {
        return errorResponse(409, "A host is already connected to this room.");
      }
      this.latestSnapshot = null;
      this.lastJoinNotification = 0;
      // Close any orphaned guests from an earlier host session before starting a new one.
      for (const staleGuest of this.ctx.getWebSockets("guest")) {
        this.safeClose(staleGuest, 4001, "Host session replaced.");
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const sessionId = crypto.randomUUID();
      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({
        role: "host",
        sessionId,
        connectedAt: Date.now(),
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    const activeHost = this.getActiveHostSocket();
    if (!activeHost) {
      return errorResponse(404, "Host is not connected.");
    }

    const activeGuests = this.getActiveGuestSockets(activeHost.sessionId);
    if (activeGuests.length >= MAX_LIVE_GUESTS) {
      return errorResponse(429, "Maximum concurrent guests reached.");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["guest"]);
    server.serializeAttachment({
      role: "guest",
      sessionId: activeHost.sessionId,
      connectedAt: Date.now(),
    });

    try {
      if (this.latestSnapshot) server.send(this.latestSnapshot);
      const now = Date.now();
      if (now - this.lastJoinNotification >= LIVE_JOIN_NOTIFY_MS) {
        this.lastJoinNotification = now;
        activeHost.ws.send(JSON.stringify({ type: "guest-joined" }));
      }
    } catch {
      this.safeClose(server, 4000, "Host disconnected.");
      await this.handleHostDisconnect(activeHost.ws, activeHost.sessionId, 1000, "Host disconnected.");
      return errorResponse(404, "Host is not connected.");
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleHostDisconnect(hostWs, sessionId, code = 1000, reason = "Host disconnected.") {
    if (sessionId) {
      if (this.disconnectedSessions.has(sessionId)) {
        this.safeClose(hostWs, code, reason);
        return;
      }
      this.disconnectedSessions.add(sessionId);
      if (this.disconnectedSessions.size > 64) {
        const oldest = this.disconnectedSessions.values().next().value;
        this.disconnectedSessions.delete(oldest);
      }
      this.hostRateWindows.delete(sessionId);
      this.latestSnapshot = null;
    }

    const offlinePayload = JSON.stringify({ type: "host-offline" });
    for (const guest of this.ctx.getWebSockets("guest")) {
      const gAtt = this.safeGetAttachment(guest);
      if (sessionId && gAtt?.sessionId && gAtt.sessionId !== sessionId) {
        continue;
      }
      if (guest.readyState === WS_OPEN) {
        try {
          guest.send(offlinePayload);
        } catch {}
      }
      this.safeClose(guest, 4000, "Host disconnected.");
    }

    this.safeClose(hostWs, code, reason);
  }

  async webSocketMessage(ws, message) {
    const att = this.safeGetAttachment(ws);
    if (!att || (att.role !== "host" && att.role !== "guest")) {
      this.safeClose(ws, 4008, "Invalid session.");
      return;
    }

    if (att.role === "guest") {
      this.safeClose(ws, 4008, "Guests cannot send application messages.");
      return;
    }

    if (this.disconnectedSessions.has(att.sessionId)) {
      this.safeClose(ws, 4000, "Session closed.");
      return;
    }

    if (typeof message !== "string") {
      await this.handleHostDisconnect(ws, att.sessionId, 4003, "Text messages only.");
      return;
    }

    if (message.length > MAX_LIVE_MESSAGE_BYTES || this.utf8Encoder.encode(message).byteLength > MAX_LIVE_MESSAGE_BYTES) {
      await this.handleHostDisconnect(ws, att.sessionId, 4009, "Message exceeds size limit.");
      return;
    }

    if (!this.allowHostMessage(att.sessionId)) {
      await this.handleHostDisconnect(ws, att.sessionId, 4008, "Message rate limit exceeded.");
      return;
    }

    if (!validateLiveSnapshotEnvelope(message)) {
      await this.handleHostDisconnect(ws, att.sessionId, 4008, "Invalid snapshot message.");
      return;
    }
    this.latestSnapshot = message;

    const guests = this.getActiveGuestSockets(att.sessionId);
    for (const guest of guests) {
      try {
        guest.send(message);
      } catch {
        this.safeClose(guest, 4000, "Guest send failed.");
      }
    }
  }

  async webSocketClose(ws, code, reason, _wasClean) {
    const att = this.safeGetAttachment(ws);
    if (att?.role === "host") {
      await this.handleHostDisconnect(ws, att.sessionId, code, reason);
      return;
    }
    this.safeClose(ws, code, typeof reason === "string" ? reason : "");
  }

  async webSocketError(ws, _error) {
    const att = this.safeGetAttachment(ws);
    if (att?.role === "host") {
      await this.handleHostDisconnect(ws, att.sessionId, 1000, "Host transport error.");
      return;
    }
    this.safeClose(ws, 1000, "Transport error.");
  }
  async handleCreate(request) {
    const body = await readJsonBounded(request, MAX_CREATE_BODY_BYTES);
    const readHash = decodeBase64UrlStrict(body.readHash, TOKEN_BYTES);
    const writeHash = decodeBase64UrlStrict(body.writeHash, TOKEN_BYTES);
    if (!readHash || !writeHash) {
      return errorResponse(400, "Valid base64url SHA-256 readHash and writeHash are required.");
    }
    if (constantTimeEqual(readHash, writeHash)) {
      return errorResponse(400, "readHash and writeHash must be distinct.");
    }

    const now = Date.now();
    this.ensureSchema();

    let created = false;
    this.ctx.storage.transactionSync(() => {
      const existing = this.sql.exec("SELECT id FROM room WHERE id = 1;").toArray();
      if (existing.length > 0) {
        return;
      }
      this.sql.exec(
        "INSERT INTO room (id, read_hash, write_hash, nonce, ciphertext, created_at, updated_at) VALUES (1, ?, ?, NULL, NULL, ?, NULL);",
        readHash,
        writeHash,
        now
      );
      created = true;
    });

    if (!created) {
      return errorResponse(409, "Room already exists.");
    }

    await this.ctx.storage.setAlarm(now + ROOM_TTL_MS);
    return jsonResponse(201, { ok: true, createdAt: now });
  }

  async handlePut(request) {
    const tokenBytes = extractBearerTokenBytes(request);
    if (!tokenBytes) {
      return errorResponse(401, "Missing or invalid bearer token.");
    }
    const candidateHash = await sha256Bytes(tokenBytes);

    const row = this.getRoomRow();
    if (!row) {
      return errorResponse(404, "Room not found.");
    }

    const storedWriteHash = asUint8Array(row.write_hash);
    if (!storedWriteHash || !constantTimeEqual(candidateHash, storedWriteHash)) {
      return errorResponse(403, "Forbidden.");
    }

    const body = await readJsonBounded(request, MAX_PUT_BODY_BYTES);
    const nonceBytes = decodeBase64UrlStrict(body.nonce, NONCE_BYTES);
    const ciphertextBytes = decodeBase64UrlStrict(
      body.ciphertext,
      null,
      MIN_CIPHERTEXT_BYTES,
      MAX_CIPHERTEXT_BYTES
    );
    if (!nonceBytes || !ciphertextBytes) {
      return errorResponse(400, "Valid base64url nonce (12 bytes) and ciphertext are required.");
    }

    const now = Date.now();
    this.ensureSchema();
    const updated = this.ctx.storage.transactionSync(() => {
      const existing = this.sql.exec("SELECT id FROM room WHERE id = 1;").toArray();
      if (existing.length === 0) {
        return false;
      }
      this.sql.exec(
        "UPDATE room SET nonce = ?, ciphertext = ?, updated_at = ? WHERE id = 1;",
        body.nonce,
        body.ciphertext,
        now
      );
      return true;
    });

    if (!updated) {
      return errorResponse(404, "Room not found.");
    }

    await this.ctx.storage.setAlarm(now + ROOM_TTL_MS);
    return jsonResponse(200, { ok: true, updatedAt: now });
  }

  async handleGet(request) {
    const tokenBytes = extractBearerTokenBytes(request);
    if (!tokenBytes) {
      return errorResponse(401, "Missing or invalid bearer token.");
    }
    const candidateHash = await sha256Bytes(tokenBytes);

    const row = this.getRoomRow();
    if (!row) {
      return errorResponse(404, "Room not found.");
    }

    const storedReadHash = asUint8Array(row.read_hash);
    if (!storedReadHash || !constantTimeEqual(candidateHash, storedReadHash)) {
      return errorResponse(403, "Forbidden.");
    }

    if (typeof row.nonce !== "string" || typeof row.ciphertext !== "string") {
      return errorResponse(404, "No snapshot published yet.");
    }

    return jsonResponse(200, {
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      updatedAt: row.updated_at,
    });
  }

  async handleDelete(request) {
    const tokenBytes = extractBearerTokenBytes(request);
    if (!tokenBytes) {
      return errorResponse(401, "Missing or invalid bearer token.");
    }
    const candidateHash = await sha256Bytes(tokenBytes);

    const row = this.getRoomRow();
    if (!row) {
      return errorResponse(404, "Room not found.");
    }

    const storedWriteHash = asUint8Array(row.write_hash);
    if (!storedWriteHash || !constantTimeEqual(candidateHash, storedWriteHash)) {
      return errorResponse(403, "Forbidden.");
    }

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return jsonResponse(200, { ok: true });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, "Invalid request URL.");
    }

    const isLivePath = url.pathname.startsWith("/v1/live/");
    const isSecureProtocol = url.protocol === "https:" || (isLivePath && url.protocol === "wss:");
    const isLoopbackAllowed = isLoopbackHost(url.hostname) && (url.protocol === "http:" || (isLivePath && url.protocol === "ws:"));
    if (!isSecureProtocol && !isLoopbackAllowed) {
      return errorResponse(400, "HTTPS is required.");
    }

    const liveMatch = /^\/v1\/live\/([^/]+)$/.exec(url.pathname);
    if (liveMatch) {
      const room = liveMatch[1];
      if (!decodeBase64UrlStrict(room, TOKEN_BYTES)) {
        return errorResponse(400, "Invalid room identifier.");
      }
      if (request.method !== "GET") {
        return errorResponse(405, "Method not allowed.");
      }
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return errorResponse(426, "Expected WebSocket upgrade.", { Upgrade: "websocket" });
      }

      for (const paramKey of url.searchParams.keys()) {
        if (paramKey !== "role") {
          return errorResponse(400, "Unexpected query parameter.");
        }
      }
      const roles = url.searchParams.getAll("role");
      if (roles.length !== 1 || (roles[0] !== "host" && roles[0] !== "guest")) {
        return errorResponse(400, "Query parameter role must be 'host' or 'guest'.");
      }

      const origin = request.headers.get("Origin");
      if (origin !== null && !isAllowedOrigin(origin, env)) {
        return errorResponse(403, "Origin not allowed.");
      }

      const stub = env.ROOMS.get(env.ROOMS.idFromName(`live:${room}`));
      return stub.fetch(request);
    }

    const match = /^\/v1\/rooms\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      return errorResponse(404, "Not found.");
    }

    const room = match[1];
    if (!decodeBase64UrlStrict(room, TOKEN_BYTES)) {
      return errorResponse(400, "Invalid room identifier.");
    }

    if (!["GET", "POST", "PUT", "DELETE"].includes(request.method)) {
      return errorResponse(405, "Method not allowed.");
    }

    if (request.method === "POST") {
      const client = request.headers.get("CF-Connecting-IP") || (isLoopbackHost(url.hostname) ? "loopback" : null);
      if (!client || client.length > 128) return errorResponse(503, "Creation quota unavailable.");
      const clientHash = encodeBase64Url(await sha256Bytes(new TextEncoder().encode(client)));
      try {
        const quota = env.ROOMS.get(env.ROOMS.idFromName("internal:creation-quota:v1"));
        const result = await quota.fetch(new Request("https://quota.internal/internal/create-quota", {
          method: "POST", headers: { "X-Quota-Client": clientHash },
        }));
        if (!result.ok) return errorResponse(result.status === 429 ? 429 : 503, "Room creation quota unavailable or exceeded.");
      } catch {
        return errorResponse(503, "Room creation quota unavailable.");
      }
    }

    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    return stub.fetch(request);
  },
};
