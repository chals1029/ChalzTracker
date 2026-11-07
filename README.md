# ChalzTracker

## Introduction

ChalzTracker is a Windows desktop app for monitoring AI subscription usage in one place. Connect accounts from supported providers, check their quota windows and reset times, and compare which account has the most headroom. The desktop release includes its runtime; Node.js and Python are not required to run it.

![ChalzTracker dashboard showing account summaries and Smart Router](Features/Screenshot%202026-11-08%20063107.png)

## Features

- **Multi-account monitoring:** Connect multiple accounts and view usage, remaining quota, and reset times in the Usage tab.
- **Smart Account Router:** Compare accounts by available headroom and reset timing to help choose which one to use.
- **Analytics and reset timeline:** Review usage history, burn-rate forecasts, and upcoming resets.
- **Compact desktop modes:** Switch to a widget with provider details or a draggable, always-on-top mini button.
- **Notifications and system tray:** Receive configurable usage and reset alerts, such as “5-Hour usage is at 84% used.” Closing the desktop window hides it to the tray.
- **Customization:** Change colors, card layout, opacity, background picture, and notification sounds. Preferences are saved locally.
- **Account privacy:** Emails are hidden by default. Reveal or hide them per account or across the Usage tab and Account Vault.
- **Account Vault:** Rename, tag, pin, pause, and manage connected accounts. Account data and settings are stored locally in `~/.chalztracker`.

### Supported providers

Google Antigravity, OpenAI Codex / ChatGPT, Anthropic Claude, Cursor, Google Gemini CLI, GitHub Copilot, Kimi Code, xAI Grok, Z.AI GLM Coding Plan, and MiniMax Token Plan. Available sign-in methods and quota details vary by provider and plan.

### Screenshots

**Connected accounts and quota windows**

![Account cards showing usage windows and reset times](Features/Screenshot%202026-11-08%20063117.png)

**Connect a provider**

![Provider selection dialog](Features/Screenshot%202026-11-08%20063058.png)

**Customize the app**

![Appearance, opacity, layout, and sound customization](Features/Screenshot%202026-11-08%20063048.png)

**Mini button and compact widget**

![Floating mini usage button](Features/Screenshot%202026-11-08%20063153.png)

![Compact widget with provider details](Features/Screenshot%202026-11-08%20063250.png)

**Windows notifications**

![ChalzTracker usage reset notification](Features/Screenshot%202026-11-08%20065039.png)

## How to install

1. Download the ChalzTracker release for **64-bit Windows**.
2. Extract the entire downloaded archive to a folder on your computer. Folder paths containing spaces are supported.
3. Open the extracted folder and double-click **`ChalzTracker.exe`**.
4. Select **Add account**, choose a provider, and follow its sign-in instructions.

Keep the `.exe` together with the rest of the extracted files, including `assets`, `lib`, and `dist-app`. The `.exe` is a launcher and cannot run by itself. Windows may show a SmartScreen warning if the release is unsigned.

**Google sign-in setup:** Antigravity uses browser sign-in without per-user OAuth configuration. Gemini CLI requires your own Google OAuth client credentials: set the Windows user environment variables `CHALZ_GEMINI_CLI_CLIENT_ID` and `CHALZ_GEMINI_CLI_CLIENT_SECRET`, then restart ChalzTracker. The Google Cloud project must allow the scopes requested by Gemini CLI; access may require approval or may not be available to all projects. Do not commit or share your client secrets.

Use **W** to open the compact widget or **M** for the mini button. The app also appears in the Windows system tray; use its tray menu to quit.

For development, `node server.js --open` requires Node.js 18 or newer. To rebuild the launcher, run `build-exe.cmd`. After replacing the Electron distribution, run `python brand-runtime.py` to regenerate the branded runtime; Python is only needed for that maintenance step.

## License

ChalzTracker source code is available under the [MIT License](LICENSE). Third-party provider logos are owned by their respective rights holders; see [assets/SOURCES.txt](assets/SOURCES.txt). The bundled Electron runtime includes its own license notices in `dist-app`.
