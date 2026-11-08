<div align="center">
  <img src="assets/chalz-icon-192.png" alt="ChalzTracker logo" width="96">
  <h1>ChalzTracker</h1>
  <p>Track your AI subscription usage in one place.</p>
  <p><a href="https://chalztracker.vercel.app/">Website</a> · <a href="https://github.com/chals1029/ChalzTracker/releases/latest">Download for Windows</a></p>
  <img src="Features/Screenshot%202026-11-08%20063107.png" alt="ChalzTracker dashboard showing account summaries and Smart Router" width="800">
</div>

ChalzTracker is an open-source Windows desktop app for monitoring AI subscription usage. Connect supported accounts, check quota windows and reset times, and compare available headroom. It is a native Rust app built with Tauri: a 4.7 MB installer, no bundled browser, and no Node.js or Python needed to run it.

## Features

- **Multi-account monitoring:** Connect multiple accounts and view usage, remaining quota, and reset times in the Usage tab.
- **Smart Account Router:** Compare accounts by available headroom and reset timing to help choose which one to use.
- **Analytics and reset timeline:** Review usage history, burn-rate forecasts, and upcoming resets.
- **Compact desktop modes:** Switch to a widget with provider details or a draggable, always-on-top mini button.
- **Notifications and system tray:** Receive configurable usage and reset alerts, such as “5-Hour usage is at 84% used.” Closing the desktop window hides it to the tray.
- **Customization:** Change colors, card layout, opacity, background picture, and notification sounds. Preferences are saved locally.
- **Account privacy:** Emails are hidden by default. Reveal or hide them per account or across the Usage tab and Account Vault.
- **Account Vault:** Rename, tag, pin, pause, and manage connected accounts. Account data and settings are stored locally in `~/.chalztracker`.

## Built with Rust

ChalzTracker is a native app: a Rust backend with the WebView2 runtime built into Windows. The installer is a 4.7 MB download, and the installed app takes 19 MB.

- **Native backend:** Provider requests, token refresh, alerts, and local storage run in one Rust process, which used about 14 MB of private memory in our measurement.
- **No bundled browser:** The interface is drawn by the Microsoft Edge WebView2 runtime that ships with Windows 10 and 11, rather than a copy of Chromium inside the app. WebView2 accounts for most of the app's memory use; the whole app used about 180 MB of private memory in the same measurement. Memory use varies with your system and connected accounts.
- **Light background work:** Usage refreshes reuse one connection pool, and the app checks for updates and Google subscription plans only every six hours.

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

1. Download the Windows x64 installer (`ChalzTracker-Setup.exe`) from the [latest release](https://github.com/chals1029/ChalzTracker/releases/latest).
2. Open it, choose an installation folder, and click **Next**. On the last page, choose whether to launch ChalzTracker and create a desktop shortcut, then click **Finish**.
3. Select **Add account**, choose a provider, and follow its sign-in instructions.

ChalzTracker installs for your Windows account only and does not require administrator rights.
**SmartScreen:** The installer is not code-signed, so Windows may show a warning.

**Uninstall:** Remove ChalzTracker from Windows **Settings > Apps > Installed apps**. Your accounts and settings in `~/.chalztracker` are kept unless you also delete that folder.

Use **W** to open the compact widget or **M** for the mini button. The app also appears in the Windows system tray; use its tray menu to quit.

### Updates

You only install ChalzTracker once. While it runs, it checks for a new version when it starts and every six hours after that. When one is available, you get a Windows notification and an **Update** button appears in the app. Click it, and ChalzTracker downloads the update, installs it, and restarts itself. Update checks contact GitHub Releases, which can see your IP address. The updater verifies each update's signature against the public key built into ChalzTracker before installing, and keeps your locally stored accounts and settings.

## Development

The desktop app lives in `src-tauri`: the Rust backend is in `src-tauri/src`, and the web interface (`index.html`, `app.js`, `styles.css`, `assets`) is bundled from the repository root. The app reads the `~/.chalztracker` data directory; set `CHALZTRACKER_HOME` to an isolated directory when testing so your real accounts are not touched.

On Windows, install Rust, the Microsoft C++ build tools, WebView2 and Node.js, then run `npx @tauri-apps/cli@2 dev` from the checkout. Run the Rust tests with `cargo test --manifest-path src-tauri/Cargo.toml`.

The installer pages are a customized NSIS template; see [src-tauri/installer/README.md](src-tauri/installer/README.md).

## License

ChalzTracker source code is available under the [MIT License](LICENSE). Third-party provider logos are owned by their respective rights holders; see [assets/SOURCES.txt](assets/SOURCES.txt).
