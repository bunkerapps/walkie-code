# Changelog

All notable changes to Walkie-Code are documented here. The project follows [Semantic Versioning](https://semver.org).

## [1.2.0] — 2026-09-19

### Added

- Replies from other channels no longer overlap. A short alert plays, the screen shows "MSJ CH03" and the answer waits: you hear it when you tune that channel (tap the alert, swipe or use your voice). A reply for the current channel that arrives while something is playing waits its turn.

### Fixed

- Replies and alerts now carry the channel's exact id. They were matched by project name, which broke when a channel was renamed or two names looked alike.

## [1.1.0] — 2026-09-19

### Changed

- Buttons reorganized for one-handed use:
  - bottom, in the thumb zone: REPETIR, SILENCIO and a camera icon on the right, where messaging apps put it;
  - top, away from the thumb: ESC (red, so Claude isn't interrupted by accident), open project (＋) and settings (gear).
- Icons are SVG now, and the top keys have a 44 px touch area.

### Fixed

- Each channel keeps its own on-screen history. Before, switching channels mixed the new channel's messages under the previous one's. Coming back to a channel now restores its history without repeating the title or the recap.

## [1.0.0] — 2026-09-19

First official release: a push-to-talk walkie-talkie for Claude Code, from an iPhone to iTerm2 on a Mac.

### Talking to Claude

- Real push-to-talk from a Home Screen web app. Speech-to-text runs locally with Whisper (`whisper-server`, large-v3-turbo).
- Text is typed into the tuned iTerm2 session, only where Claude Code is running and never into a plain shell.
- Dictated prompts ask Claude for listen-friendly answers through the `UserPromptSubmit` hook. Text typed on the Mac is not affected.
- Unclear dictation makes Claude ask before acting.
- Photos: send a picture (camera, gallery or screenshot) with your next message, or on its own.

### Hearing Claude

- Answers are synthesized on the Mac with `say` and played only on the phone that talked.
- Markdown is cleaned for speech: code blocks and tables are announced, and paths are shortened.
- Voice picker showing quality (premium, enhanced, standard), speed, and voice volume up to 300 %. There is a shortcut to install better voices from System Settings.
- Per-effect volume for press, release, incoming and notice sounds. Original sounds are synthesized by `scripts/make-sounds.js`, and you can override them locally in `~/.walkie-code/sounds/`.
- Channel recap: the last prompt and answer of each session, even if typed on the Mac. REPETIR reads it aloud.

### Channels

- Every iTerm2 session running Claude Code is a channel. Switch by swiping, by voice ("canal superprecio", "canal tres"), or from the Dynamic Island.
- The tuned tab is painted orange on the Mac with a "📻 CH03" badge.
- Custom name per channel.
- Open Claude Code in any folder under `projectsRoot` from the phone, and close a channel from the phone.
- The tuned channel and pending answers survive a server restart.

### Permissions and notifications

- Permission requests show exactly what Claude wants to run, with APPROVE / ALWAYS / DENY buttons (or "sí" / "no" by voice). The answer goes back through the `PermissionRequest` hook as an official decision.
- Web Push when the phone is locked. Missed answers are recovered and played when you come back from a notification.
- Alerts when a long task finishes in any channel, and a usage-limit warning with the reset time (`StopFailure` hook).
- Life bar showing Claude's usage limit.
- Lock screen and Dynamic Island show the channel and the start of the last answer.

### Mac side

- Node.js server with no npm dependencies, running as a `launchd` agent and reachable only through `tailscale serve`. Web Push is implemented with `node:crypto`.
- Walkie Wake: a Wake-on-LAN relay to wake the Mac from another machine.
- Security hardening:
  - 128-bit token compared in constant time;
  - `Host` allow-list against DNS rebinding;
  - Content-Security-Policy on the page;
  - path checks for static files, folders and transcripts;
  - control characters stripped before typing.

  See [SECURITY.md](SECURITY.md).

[1.2.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.2.0
[1.1.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.1.0
[1.0.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.0.0
