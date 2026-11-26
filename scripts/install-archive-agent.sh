#!/bin/bash
# Install (or reinstall) the daily LaunchAgent that runs server/archive.mjs, so
# transcripts are digested into the archive before Claude Code's ~30-day
# cleanup deletes them — whether or not the dashboard gets opened.
#
#   ./scripts/install-archive-agent.sh      (or: make install-archive-agent)
#
# The agent pins the absolute path of the node found now (nvm's `node` is a
# shell function launchd can't see), so re-run this after switching Node
# versions. Uninstall:
#   launchctl bootout gui/$(id -u)/com.xander.claude-usage-archive
#   rm ~/Library/LaunchAgents/com.xander.claude-usage-archive.plist
set -euo pipefail

LABEL=com.xander.claude-usage-archive
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/claude-usage-archive.log"

NODE="$(zsh -ic 'command -v node >/dev/null; whence -p node || true' 2>/dev/null | tail -1)"
if [[ ! -x "$NODE" ]]; then
  NODE="$(ls -d "$HOME"/.nvm/versions/node/v"$(cat "$HOME/.nvm/alias/default" 2>/dev/null)"*/bin/node 2>/dev/null | tail -1)"
fi
[[ -x "$NODE" ]] || { echo "no node binary found" >&2; exit 1; }

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$REPO/server/archive.mjs</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$REPO</string>

    <!-- Daily at 12:30. A run missed while the Mac sleeps fires on wake. -->
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>12</integer>
        <key>Minute</key>
        <integer>30</integer>
    </dict>

    <key>RunAtLoad</key>
    <false/>

    <!-- Background work: yield CPU and disk to anything interactive. -->
    <key>ProcessType</key>
    <string>Background</string>
    <key>LowPriorityIO</key>
    <true/>
    <key>Nice</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (node: $NODE, log: $LOG)"
