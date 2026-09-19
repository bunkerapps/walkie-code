# Contributing

Thanks for wanting to help! Issues, ideas and pull requests are welcome, in English or Spanish.

## Getting started

1. Fork and clone the repo. You need macOS, iTerm2, Node.js 20+, `whisper-cpp` and `ffmpeg` (see the README).
2. Run `npm test`. The suite uses `node:test` and has no dependencies.
3. Run a **separate instance** so you never touch your real setup:

   ```sh
   mkdir -p /tmp/wc-dev
   echo '{"port": 8790, "whisperPort": 8791, "model": "'"$HOME"'/.walkie-code/models/ggml-large-v3-turbo-q5_0.bin"}' > /tmp/wc-dev/config.json
   WALKIE_CODE_HOME=/tmp/wc-dev npm start
   ```

## Safety rules for development

Walkie-Code types into real terminals. When testing:

- **Never dictate into your own active Claude Code session.** Open a separate iTerm2 window. A tiny fake `claude` binary that just echoes its input is useful here: the server only needs a process named `claude` on that tty.
- Do not run `scripts/install-hooks.js` against your real `~/.claude/settings.json` while experimenting. Point `HOME` to a copy instead.
- Remember that connecting a browser to a dev instance still paints the tuned iTerm2 tab.

## Code style

- Plain ES modules and **no npm dependencies**. We implemented Web Push with `node:crypto` to keep it that way, so please discuss before adding one.
- Small functions, with pure logic in `lib/` and covered by tests in `test/`.
- Comments explain *why*, not *what*. Existing comments and UI texts are in Spanish; new code may use English.
- UI texts go in UPPERCASE, in the style of an LCD screen. Keep the layout working at 390 px wide.

## Good first contributions

- **Translations:** the UI, spoken phrases and voice commands are Spanish only today.
- **Other terminals:** Terminal.app, Ghostty and WezTerm (only iTerm2 is supported).
- **Other platforms** for the phone side (Android works in theory; it needs testing).
- **Better voice-command matching** for channel names.

## Pull requests

- One topic per PR, with tests for new logic.
- `npm test` must pass.
- Describe how you tested it, especially anything that touches iTerm2, hooks or the phone.
