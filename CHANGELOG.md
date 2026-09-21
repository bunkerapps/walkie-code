# Changelog

All notable changes to Walkie-Code are documented here. The project follows [Semantic Versioning](https://semver.org).

[Leer en español](CHANGELOG.es.md)

## [1.6.0] — 2026-09-21

### Added

- **Face ID lock.** The link gets you to the server, but writing to the terminal now also takes your face (or fingerprint, or passcode). The Mac does the verification — signature, single-use challenge and credential counter — written with `node:crypto`, no libraries. The key lasts half a day and never leaves that phone; hooks, which run on the Mac itself, never need it.
- **Token rotation.** From the Mac with `npm run token`: the old link stops working immediately and the new one is printed. From the phone it only works with the lock on, so that whoever picks up your phone can't lock you out.
- **It knows whether you're at the Mac.** From the keyboard idle time and the screen state, the hook tells Claude whether you are using the Mac, nearby or away, so it knows whether to show something on screen or say it out loud. If the keyboard moves while you're dictating into the walkie, it flags that someone else is at the Mac.
- **Alert when someone touches your Mac.** While you're away, someone waking it up reaches your phone as a notification, at most once every ten minutes.
- **Channel dial.** Tapping the channel number brings up the full list, with the tuned one highlighted, a mark on those with a reply waiting, and a search box when there are many. Swiping still works.
- **Cancel before sending.** While holding to talk, drag your finger to the left: the bin appears, you let go and the recording is dropped.

### Changed

- **Less battery on the phone.** The screen is no longer forced on the whole time: only while recording, while Claude works and while it speaks. Channels are polled every 30 seconds instead of every 10, and the usage limit every 5 minutes instead of every minute.
- The folder published for the TV no longer serves hidden files, `node_modules` or files that hold secrets (`.env`, keys, databases).

### Fixed

- The on-screen history and replies waiting on other channels survive reloading the app: they are kept on the phone. Those from channels that were closed are dropped.
- "Claude is thinking" is now per channel: switching channels no longer leaves the sign up for a channel that isn't working.
- A channel's recap no longer shows another channel's conversation. It uses the transcript the hook reports, checks it belongs to the same folder and, with several Claude Code sessions open in one folder, doesn't guess.
- Opening the app asks for the channel recap again, without repeating what is already on screen.

## [1.5.0] — 2026-09-20

### Added

- **Folder trust is answered from the phone.** The first time you open a folder, Claude Code asks whether you trust it. That question now shows up in the same panel as permissions, with the path in view and two buttons: TRUST and DON'T OPEN.

### Fixed

- **Trusting a folder no longer closes the channel.** Claude Code's menu starts on "No, exit", so the Enter the walkie sent picked exactly that: Claude quit and the terminal was left at the shell. The walkie now reads the screen, moves the selection to the right option and only then confirms.
- **The tuned channel survives Claude Code restarting.** After accepting trust (or on an update) Claude Code restarts, and for a few seconds there is no process in that terminal. The channel was treated as closed and the phone jumped to CH01; now it waits for it while the tab is still open, and anything you dictate meanwhile is typed once Claude is back.
- **The screen no longer gets stuck on "Claude is thinking".** Answering the trust question starts no turn, so nothing is left waiting.
- **Channels keep their number.** The order came from iTerm2, which lists windows by which one is in front: opening a new folder put it first and shifted every channel. Each channel now keeps the number it got when it appeared, new ones go last, and the order survives restarts.
- **Error messages tell the truth.** Anything that went wrong ended up as "no connection to the Mac". The phone now tells apart being offline, not reaching the Mac, and an error the Mac actually returned — naming what it was doing.
- A transient iTerm2 error (while a window opens or closes) no longer leaves the phone with no channels at all: it retries.

## [1.4.0] — 2026-09-20

### Added

- **Remote control for the projected page.** The TV has no touch or scroll of its own, so the phone became a trackpad: drag moves a pointer drawn on the page, a tap clicks, press-and-drag lets you drag things (like a before/after slider), and four keys move through the page. The page listens with long polling, so it reacts without a visible delay.
- **Several photos at once.** Up to six from the gallery: they upload in parallel, the screen shows the progress and all the paths travel at the end of the message. If one fails to upload, nothing is sent.
- **Laboratorio.** Projects created from the phone are born in a `laboratorio` folder and are shown as PRUEBA. Inside one there are two more actions: promote it out of the lab, or delete it — with confirmation — to the Trash. Nothing outside the lab can be deleted or moved, and a project with an open channel is never deleted.

### Changed

- The TV lives in its own key at the bottom, with the classic cast icon, and opens a panel with the device, cast/stop, the trackpad and the scroll keys. Replay and mute are icons now too.

## [1.3.0] — 2026-09-20

### Added

- **Cast to a TV.** A page from the tuned project can be shown on a Chromecast: the Mac serves that folder on the local network, only while casting, and every change reloads the page on the TV, so you can develop live on the big screen. The TELE row in settings casts the project's newest page and takes it down again; the device is picked from the ones found on the network and remembered. Also available from the terminal with `scripts/cast.js` (`--devices`, `--device`, `--stop`, `--status`). Needs `catt`.
- **New project from the phone.** PROYECTO NUEVO, in the folder browser, creates a folder inside `projectsRoot` with a starter page and opens its own Claude Code channel, ready to cast.

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

[1.6.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.6.0
[1.5.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.5.0
[1.4.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.4.0
[1.3.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.3.0
[1.2.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.2.0
[1.1.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.1.0
[1.0.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.0.0
