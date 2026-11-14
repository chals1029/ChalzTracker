# ChalzTracker Mobile Companion

Read-only, end-to-end encrypted Expo React Native companion app for **ChalzTracker** on Android, iOS, and Expo Web preview.

## Visual & Security Model

- **AMOLED Liquid-Glass UI:** Pure `#000000` OLED canvas with translucent frosted glass cards, specular top rims, and ChalzTracker brand accents (`Emerald`, `Violet`, `Cyan`, `Amber`, `Rose`).
- **End-to-End Encrypted (AES-256-GCM):** Your PC encrypts usage snapshots with a random 12-byte nonce and 16-byte authentication tag before uploading to the Cloudflare Worker relay. This app fetches ciphertext from `GET /v1/rooms/{room}` using `Authorization: Bearer <readKey>` and decrypts locally on-device.
- **Read-Only & Zero Provider Credentials:** OAuth tokens and API keys never leave your PC.
- **HTTPS Enforced:** Non-HTTPS URLs are rejected unless the host is an explicit local development loopback (`localhost`, `127.0.0.1`, `[::1]`, or Android emulator `10.0.2.2`).
- **Secure Storage:**
  - **Android / iOS (Primary):** Pairing credentials (`room`, `readKey`, AES `key`, relay `url`) are stored strictly in hardware-backed Android Keystore / iOS Keychain via `expo-secure-store` (never `AsyncStorage`). Only the already-encrypted ciphertext envelope is cached in `AsyncStorage` for instant offline display.
  - **Expo Web Preview:** Pairing secrets and cached snapshots are held **in tab memory only** (never `localStorage` or `sessionStorage`). Reloading the browser tab clears pairing credentials and requires pasting the pairing JSON again.

## Setup & Run

From the `mobile/` directory:

```bash
cd mobile
npm install
```

### Run on Android / iOS (Expo Go or Dev Build)

```bash
npm start
```

Or launch directly:

```bash
npm run android
npm run ios
```

### Preview in Browser (Expo Web)

```bash
npm run web
```

### Type Check

```bash
npm run typecheck
```

## Pairing with ChalzTracker Desktop

1. Open **ChalzTracker** on your Windows PC and enable **Mobile Companion** in settings.
2. Copy the pairing JSON (`{"v":1,"url":"...","room":"...","readKey":"...","key":"..."}`).
3. In the mobile app, tap **Paste** and then **Connect & Verify**.

## Platform Notes & Web Preview Limitations

- **Native Android / iOS** are the primary targets and do not have browser CORS restrictions or session-reset behavior.
- **Web Preview Reload:** Because web preview stores keys strictly in memory (never `localStorage`), refreshing the browser page requires re-pasting the pairing JSON.
- **Web Preview CORS:** Browsers enforce CORS on `fetch()` requests to the relay; your relay endpoint must return appropriate `Access-Control-Allow-Origin` and `Access-Control-Allow-Headers: Authorization, Content-Type, Cache-Control` headers for browser previews.
- **Local Relay Testing:**
  - iOS Simulator / Desktop Browser: `http://127.0.0.1:<port>` or `http://localhost:<port>`
  - Android Emulator: `http://10.0.2.2:<port>`
