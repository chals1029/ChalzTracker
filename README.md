<div align="center">
  <img src="assets/chalz-icon-192.png" alt="ChalzTracker logo" width="96">
  <h1>ChalzTracker</h1>
  <p>Track your AI subscription usage in one place.</p>
  <p><a href="https://chalztracker.vercel.app/">Website</a> · <a href="https://github.com/chals1029/ChalzTracker/releases/latest">Download for Windows</a></p>
  <img src="Features/Screenshot%202026-11-08%20063107.png" alt="ChalzTracker dashboard showing account summaries and Smart Router" width="800">
</div>

ChalzTracker is an open-source Windows desktop app for monitoring AI subscription usage. Connect supported accounts, check quota windows and reset times, and compare available headroom. It is a native Rust app built with Tauri: a 4.7 MB installer, no bundled browser, and no Node.js or Python needed to run it.

## Features

- Monitor multiple accounts, usage windows, and reset times.
- Find available accounts with Smart Account Router.
- Review usage history and upcoming resets.
- Use the compact widget, mini button, and system tray.
- Receive usage and reset notifications.
- Customize the app's appearance and sounds.
- View usage from a phone or browser with Live Share.

ChalzTracker is built with Rust and Tauri and uses the Windows WebView2 runtime.

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

1. Install from the [Microsoft Store](https://apps.microsoft.com/detail/9PN35S9FWL4M), or download the Windows x64 installer (`ChalzTracker-Setup.exe`) from the [latest GitHub release](https://github.com/chals1029/ChalzTracker/releases/latest).
2. If using the GitHub installer, open it, choose an installation folder, and click **Next**. On the last page, choose whether to launch ChalzTracker and create a desktop shortcut, then click **Finish**.
3. Select **Add account**, choose a provider, and follow its sign-in instructions.

ChalzTracker installs for your Windows account only and does not require administrator rights.
**GitHub installer / SmartScreen:** The installer is not code-signed, so Windows may show a warning. Microsoft Store handles package signing for Store installations.

**Uninstall:** Remove ChalzTracker from Windows **Settings > Apps > Installed apps**. Your accounts and settings in `~/.chalztracker` are kept unless you also delete that folder.

Use **W** to open the compact widget or **M** for the mini button. The app also appears in the Windows system tray; use its tray menu to quit.

### Updates

GitHub installations can update from within the app. Microsoft Store installations update through the Store.

## Live browser sharing

Open **Live Share** in the desktop app, then scan the QR code or copy the private link. Keep the desktop app running while viewing usage. The browser view is read-only.

Treat the link and QR code as private. You can disable sharing or rotate the link in the desktop app. A new link is created whenever the app restarts.

## Mobile companion

The optional mobile companion provides another read-only view of your usage. See [mobile/README.md](mobile/README.md) for setup instructions.

## Development

The desktop app lives in `src-tauri`; the interface is in the repository root. On Windows, install Rust, the Microsoft C++ build tools, WebView2, and Node.js, then run:

```sh
npx @tauri-apps/cli@2 dev
```

Run the Rust tests with `cargo test --manifest-path src-tauri/Cargo.toml`. Use an isolated `CHALZTRACKER_HOME` when testing to avoid changing your personal data. Release builds may require additional provider and signing configuration; keep credentials out of the repository.

The installer pages are a customized NSIS template; see [src-tauri/installer/README.md](src-tauri/installer/README.md).

## License

ChalzTracker source code is available under the [MIT License](LICENSE). Third-party provider logos are owned by their respective rights holders; see [assets/SOURCES.txt](assets/SOURCES.txt).
