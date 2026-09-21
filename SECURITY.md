# Security

Walkie-Code turns speech on a phone into keystrokes in a terminal on your Mac. That is powerful, so this document explains what protects you and what you are responsible for.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting ("Report a vulnerability" in the Security tab of the repository). We aim to answer within a week.

## Threat model

**What we protect against**

- **Other devices on your network or the internet.** The server listens on `127.0.0.1` only. The phone reaches it through `tailscale serve`, which is limited to devices in your tailnet.
- **Anyone who reaches the server without the token.** Every `/api/*` request needs a 128-bit random token from `~/.walkie-code/config.json` (file mode `0600`), compared in constant time.
- **Malicious websites (DNS rebinding and CSRF).** Requests whose `Host` is not `localhost`, `127.0.0.1`, `*.ts.net` or a configured `allowedHosts` entry are rejected. The API needs a custom header or the token, and sends no CORS headers.
- **Typing into the wrong place.** Text is written only into iTerm2 sessions where a `claude` process is running, never into a plain shell. Control characters (Enter, Escape, Ctrl+C…) are stripped before typing.
- **Path tricks.** Static files cannot escape `public/`. Folders opened from the phone must be inside `projectsRoot`, with `..` and symlinks resolved first. Transcript paths reported by hooks must be `.jsonl` files under `~/.claude/projects`. Uploaded images are validated by their bytes (JPEG, PNG, GIF, WebP; 8 MB max) and stored with random names and mode `0600`.
- **Hooks slowing down Claude Code.** The hook never blocks: if the server is down or slow it exits within 1.5 seconds and changes nothing.
- **The page itself.** It is served with a Content-Security-Policy (own origin plus Google Fonts), `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy: no-referrer`.
- **A phone that fell into someone else's hands (optional).** With the Face ID lock on, the token alone is not enough: every `/api/*` call from the phone also needs a session opened with the platform authenticator. The Mac verifies the assertion itself (ES256 signature, single-use challenge no older than two minutes, `UV` flag required, credential counter must move forward). Sessions last 12 hours, are stored as SHA-256 hashes in `~/.walkie-code/lock.json` (mode `0600`) and can all be closed at once. Hooks running on the Mac are exempt.
- **Being locked out of your own walkie.** Rotating the token (`npm run token`) works from the Mac always; from the phone only when the lock is on.

**What we do not protect against**

- **Anyone holding the token inside your tailnet** (with the Face ID lock off) can dictate to Claude Code as you. Claude Code's own permission prompts still apply. Treat the token like a password: it is saved in the phone's storage and appears in the URL you open once.
- **Other processes running as your user on the Mac.** They can read the config and talk to the local server, but they could also type into your terminal directly.
- **Race conditions.** Channels are checked right before typing, but if Claude Code exits in that same instant, the text could land in the shell underneath.
- **Exposing the server publicly** (Tailscale Funnel, ngrok, port forwarding…) is not supported.

## Data stored on the Mac

| Path | Contents |
| --- | --- |
| `~/.walkie-code/config.json` | Token and settings |
| `~/.walkie-code/push.json` | VAPID keys and push subscriptions |
| `~/.walkie-code/lock.json` | Face ID credential (public key only) and open session hashes |
| `~/.walkie-code/transcripts.json` | Which Claude Code transcript belongs to each terminal |
| `~/.walkie-code/uploads/` | Photos sent from the phone, deleted after 7 days |
| `~/.walkie-code/walkie-code.log` | Service log, including dictated text |
| `~/.claude/settings.json` | The hooks installed by `scripts/install-hooks.js`. A backup is kept next to it |

Audio is transcribed in memory and never written to disk. Push notifications go through Apple's push service, encrypted end to end (RFC 8291) and containing only the first 140 characters of an answer.
