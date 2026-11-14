# ChalzTracker Privacy Policy

Last updated: November 14, 2026

ChalzTracker is a Windows app that displays usage information for AI accounts you choose to connect.

## Information the app uses

Depending on the provider and sign-in method, ChalzTracker handles account identifiers, email addresses, organization and subscription details, access or refresh tokens, API keys, usage and quota information, and reset times. It also stores your app settings and local usage history.

## Storage and security

The app stores this information on your device, normally in the `.chalztracker` folder under your Windows user profile. Account credentials are stored in a local JSON file and are not separately encrypted by ChalzTracker. Anyone or any software with access to your Windows account or those files may be able to read them. Protect your device and Windows account, and do not share your data files.

## Connections to other services

ChalzTracker communicates with the AI providers you choose to connect to authenticate your accounts, refresh credentials, and retrieve usage information. Those providers receive the information needed for these requests, including credentials and your network address, and handle it under their own privacy policies.

The Microsoft Store version receives app updates through Microsoft. The version downloaded directly from GitHub checks GitHub Releases for updates; GitHub can see your network address. Microsoft and GitHub handle information under their own privacy policies.

ChalzTracker calculates its usage analytics locally. Mobile Companion sync is optional. Live browser sharing starts automatically when a relay is configured unless you disable it; otherwise the app does not send usage data to a relay.

## Mobile and browser sharing

Mobile Companion is optional and disabled by default. Live browser sharing starts automatically when a relay is configured unless you disable it. Both provide a read-only view of usage; account sign-in credentials are not included in the shared data.

Shared usage is encrypted before it leaves your PC. The relay stores encrypted mobile snapshots and temporarily holds the latest encrypted live snapshot for connecting viewers. Cloudflare and the relay operator can observe connection information, including IP addresses, connection times, and data sizes. The relay retains hashed IP addresses and request counts for abuse prevention; these records may remain during inactivity.

Anyone with your private browser link or mobile pairing information can view the shared usage. Keep them private. You can disable live sharing or rotate its link in the desktop app. Closing the desktop ends the live session.

For Mobile Companion, **Disconnect & Revoke** stops syncing and attempts to delete the remote data. The app reports if deletion cannot be confirmed. The default relay also removes inactive mobile rooms after 30 days.

## Retention and deletion

Data remains on your device until you remove it. You can remove a connected account in the app; this removes its stored account record and credentials. Local history and other settings may remain. Uninstalling the app may leave local data behind. To remove all of it, quit the app and delete the `.chalztracker` folder in your Windows user profile. You can also revoke the app's access through the relevant provider, where supported.

## Support

If you contact us through [GitHub Issues](https://github.com/chals1029/ChalzTracker/issues), the information you submit is handled by GitHub and may be publicly visible. Do not include tokens, API keys, or other secrets in an issue.

## Changes

This policy may be updated when the app or its data practices change. The latest version will be available at this page.
