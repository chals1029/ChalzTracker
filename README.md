<div align="center">
  <img src="assets/chalz-icon-192.png" alt="ChalzTracker logo" width="96">
  <h1>ChalzTracker</h1>
  <p>Track your AI subscription usage in one place.</p>
  <p><a href="https://chalztracker.vercel.app/">Website</a> · <a href="https://github.com/chals1029/ChalzTracker/releases/latest">Download for Windows</a></p>
  <img src="Features/Screenshot%202026-11-08%20063107.png" alt="ChalzTracker dashboard showing account summaries and Smart Router" width="800">
</div>

ChalzTracker is an open-source Windows desktop app for monitoring AI subscription usage. Connect supported accounts, check quota windows and reset times, and compare available headroom. The desktop release includes its runtime; Node.js and Python are not required to run it.

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

1. Download the Windows x64 **Setup.exe** from the [latest release](https://github.com/chals1029/ChalzTracker/releases/latest).
2. Open setup, choose an installation folder, and click **Install**. Then click **Launch**.
3. Select **Add account**, choose a provider, and follow its sign-in instructions.

**Portable option:** Download the Windows x64 ZIP, extract it completely, and run `ChalzTracker.exe` from the extracted folder. Keep the launcher together with `assets`, `lib`, `dist-app`, and the other installed files.

**SmartScreen:** The setup and launcher are unsigned, so Windows may show a warning.

**Uninstall:** Setup does not add an entry to Windows Apps & Features. Delete the installation folder and Start menu shortcut to remove the app. Delete `~/.chalztracker` separately only if you also want to remove saved accounts and settings.

Use **W** to open the compact widget or **M** for the mini button. The app also appears in the Windows system tray; use its tray menu to quit.

### Updates

ChalzTracker checks GitHub Releases for updates while the desktop app is running; these requests disclose your IP address to GitHub. When an update is available, use the **Update** button to download it and restart the app. The updater checks the archive against the SHA-256 digest reported by GitHub and keeps your locally stored accounts and settings. This detects corruption but does not protect against a compromised GitHub release account.

Automatic installation requires 64-bit Windows, Windows PowerShell, and Windows Management Instrumentation (WMI). Versions that do not yet include the updater must be updated manually once. Future Windows release ZIPs must include `updater.js` and `updater-helper.ps1` alongside `main.js`, and publish the Windows ZIP with its GitHub SHA-256 digest.

## Development

From a source checkout, run `node server.js --open` with Node.js 18 or newer. Rebuild the launcher with `build-exe.cmd`, or build setup from an assembled release ZIP with `build-setup.cmd path\to\release.zip path\to\setup.exe`.

After replacing the Electron distribution, run `python brand-runtime.py` to regenerate the branded runtime. Python is only needed for that maintenance step.

## License

ChalzTracker source code is available under the [MIT License](LICENSE). Third-party provider logos are owned by their respective rights holders; see [assets/SOURCES.txt](assets/SOURCES.txt). The bundled Electron runtime includes its own license notices in `dist-app`.
