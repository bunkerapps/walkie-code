#!/bin/bash
# Maneja walkie-code como agente de launchd: arranca solo al iniciar sesión y se reinicia si se cae.
#   scripts/service.sh install | uninstall | restart | status | logs
set -euo pipefail

LABEL="net.bunkerapps.walkie-code"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/.walkie-code/walkie-code.log"
NODE="$(command -v node)"
DOMAIN="gui/$(id -u)"

install() {
  mkdir -p "$(dirname "$PLIST")" "$HOME/.walkie-code"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "walkie-code instalado como servicio ($PLIST). Logs: $LOG"
}

case "${1:-}" in
  install) install ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "walkie-code desinstalado." ;;
  restart) launchctl kickstart -k "$DOMAIN/$LABEL" && echo "walkie-code reiniciado." ;;
  status) launchctl print "$DOMAIN/$LABEL" | grep -E "state =|pid =|last exit code" ;;
  logs) tail -f "$LOG" ;;
  *) echo "uso: $0 install | uninstall | restart | status | logs" >&2; exit 1 ;;
esac
