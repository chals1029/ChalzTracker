<div align="center">
  <img src="assets/chalz-icon-192.png" alt="ChalzTracker logo" width="96">
  <h1>ChalzTracker</h1>
  <p>Track your AI subscription usage in one place.</p>
  <p><a href="https://chalztracker.vercel.app/">Website</a> · <a href="https://github.com/chals1029/ChalzTracker/releases/latest">Download for Windows</a></p>
  <img src="Features/Screenshot%202026-11-08%20063107.png" alt="ChalzTracker dashboard showing account summaries and Smart Router" width="800">
</div>

ChalzTracker is an open-source Windows desktop app for monitoring AI subscription usage. Connect supported accounts, check quota windows and reset times, and compare available headroom. The app is built with Tauri and Rust and uses the Microsoft Edge WebView2 runtime included with Windows 10 and 11; Node.js and Python are not required to run it.

## Features

- **Multi-account monitoring:** Connect multiple accounts and view usage, remaining quota, and reset times in the Usage tab.
- **Smart Account Router:** Compare accounts by available headroom and reset timing to help choose which one to use.
- **Analytics and reset timeline:** Review usage history, burn-rate forecasts, and upcoming resets.
- **Compact desktop modes:** Switch to a widget with provider details or a draggable, always-on-top mini button.
- **Notifications and system tray:** Receive configurable usage and reset alerts, such as “5-Hour usage is at 84% used.” Closing the desktop window hides it to the tray.
- **Customization:** Change colors, card layout, opacity, background picture, and notification sounds. Preferences are saved locally.
- **Account privacy:** Emails are hidden by default. Reveal or hide them per account or across the Usage tab and Account Vault.
- **Account Vault:** Rename, tag, pin, pause, and manage connected accounts. Account data and settings are stored locally in `~/.chalztracker`.

## Supported providers

- <img src="assets/icons/antigravity.png" alt="" width="28"> Google Antigravity
- <img src="assets/icons/codex.png" alt="" width="28"> OpenAI Codex / ChatGPT
- <img src="assets/icons/claude.png" alt="" width="28"> Anthropic Claude
- <img src="assets/icons/cursor.png" alt="" width="28"> Cursor
- <img src="assets/icons/gemini-cli.png" alt="" width="28"> Google Gemini CLI
- <img src="assets/icons/copilot.png" alt="" width="28"> GitHub Copilot
- <img src="assets/icons/kimi.png" alt="" width="28"> Kimi Code
- <img src="assets/icons/xai.png" alt="" width="28"> xAI Grok
- <img src="assets/icons/zai.png" alt="" width="28"> Z.AI GLM Coding Plan
- <img src="assets/icons/minimax.png" alt="" width="28"> MiniMax Token Plan

Available sign-in methods and quota details vary by provider and plan.

## Screenshots

**Connected accounts and quota windows**

<img src="Features/Screenshot%202026-11-08%20063117.png" alt="Account cards showing usage windows and reset times" width="800">

**Connect a provider**

<img src="Features/Screenshot%202026-11-08%20063058.png" alt="Provider selection dialog" width="800">

**Customize the app**

<img src="Features/Screenshot%202026-11-08%20063048.png" alt="Appearance, opacity, layout, and sound customization" width="800">

**Mini button and compact widget**

<img src="Features/Screenshot%202026-11-08%20063153.png" alt="Floating mini usage button" width="400">

<img src="Features/Screenshot%202026-11-08%20063250.png" alt="Compact widget with provider details" width="400">

**Windows notifications**

<img src="Features/Screenshot%202026-11-08%20065039.png" alt="ChalzTracker usage reset notification" width="400">

## How to install

1. Download the Windows x64 installer (`ChalzTracker_<version>_x64-setup.exe`) from the [latest release](https://github.com/chals1029/ChalzTracker/releases/latest).
2. Open it, choose an installation folder, and click **Next**. On the last page, choose whether to launch ChalzTracker and create a desktop shortcut, then click **Finish**.
3. Select **Add account**, choose a provider, and follow its sign-in instructions.

ChalzTracker installs for your Windows account only and does not require administrator rights.

**Upgrading from an earlier Electron version:** Quit the old version from its tray menu, then install the new release once. Your accounts and settings in `~/.chalztracker` are kept. The old version cannot update itself to this release; remove its installation folder and shortcuts after the new version is working.

**SmartScreen:** The installer is not code-signed, so Windows may show a warning.

**Uninstall:** Remove ChalzTracker from Windows **Settings > Apps > Installed apps**. Your accounts and settings in `~/.chalztracker` are kept unless you also delete that folder.

Use **W** to open the compact widget or **M** for the mini button. The app also appears in the Windows system tray; use its tray menu to quit.

### Updates

ChalzTracker checks GitHub Releases for updates while the desktop app is running; these requests disclose your IP address to GitHub. When an update is available, use the **Update** button to download and install it, then restart the app. The updater verifies each update's signature against the public key built into ChalzTracker before installing, and keeps your locally stored accounts and settings.

## Development

The desktop app lives in `src-tauri`: the Rust backend is in `src-tauri/src`, and the web interface (`index.html`, `app.js`, `styles.css`, `assets`) is bundled from the repository root. The app reads the `~/.chalztracker` data directory; set `CHALZTRACKER_HOME` to an isolated directory when testing so your real accounts are not touched.

On Windows, install Rust, the Microsoft C++ build tools, WebView2 and Node.js, then run `npx @tauri-apps/cli@2 dev` from the checkout. Run the Rust tests with `cargo test --manifest-path src-tauri/Cargo.toml`.

The installer pages are a customized NSIS template; see [src-tauri/installer/README.md](src-tauri/installer/README.md).

### Releases

Antigravity sign-in needs a Google OAuth client that is embedded at build time and not stored in this repository. Set `CHALZ_ANTIGRAVITY_CLIENT_ID` and `CHALZ_ANTIGRAVITY_CLIENT_SECRET` before building; without them, the app builds but Antigravity sign-in and token refresh report that the client is missing. Gemini CLI reads `CHALZ_GEMINI_CLI_CLIENT_ID` and `CHALZ_GEMINI_CLI_CLIENT_SECRET` from the environment when the app runs.

For a signed updater installer, set `TAURI_SIGNING_PRIVATE_KEY` to the private key path and run `npx @tauri-apps/cli@2 build`. Keep the private key secure and backed up: installed clients cannot trust future updates signed with a different key. Publish the generated installer and `.sig` file along with a `latest.json` containing the release version and the Windows x86-64 installer URL and signature. Do not publish the private key. The updater reports an error until the latest release includes `latest.json`.

The Cursor integration tries Cursor's current-period usage service if the dashboard summary returns HTTP 403. Both endpoints are undocumented and may change; if neither returns usable quota data, the account remains stale rather than displaying invented usage.

## License

ChalzTracker source code is available under the [MIT License](LICENSE). Third-party provider logos are owned by their respective rights holders; see [assets/SOURCES.txt](assets/SOURCES.txt).
