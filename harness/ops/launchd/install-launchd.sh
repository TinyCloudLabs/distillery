#!/bin/bash
# install-launchd.sh — fill the plist placeholders + stage them into
# ~/Library/LaunchAgents/ (spec §7). Does NOT load them — loading touches
# Hunter's login session, so HE runs the `launchctl bootstrap` commands himself
# (printed at the end). This script only TEMPLATES + COPIES + validates.
#
#   bash harness/ops/launchd/install-launchd.sh
#
# Re-running is safe (idempotent overwrite of the staged plists).

set -euo pipefail

# This script lives at $REPO/harness/ops/launchd/, so the repo root is 3 up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$SCRIPT_DIR/logs"

CLOUDFLARED="$(command -v cloudflared || true)"
if [[ -z "$CLOUDFLARED" ]]; then
  echo "WARN: cloudflared not on PATH — the tunnel plist will be staged with a" >&2
  echo "      placeholder. Install cloudflared and re-run, or edit the path by hand." >&2
  CLOUDFLARED="/opt/homebrew/bin/cloudflared"
fi

mkdir -p "$AGENTS" "$LOGS"

PLISTS=(
  com.tinycloud.distillery.feedrun.plist
  com.tinycloud.distillery.server.plist
  com.tinycloud.distillery.tunnel.plist
)

echo "Repo:        $REPO"
echo "Home:        $HOME"
echo "cloudflared: $CLOUDFLARED"
echo "LaunchAgents:$AGENTS"
echo

for p in "${PLISTS[@]}"; do
  src="$SCRIPT_DIR/$p"
  dst="$AGENTS/$p"
  sed -e "s#__REPO__#$REPO#g" \
      -e "s#__HOME__#$HOME#g" \
      -e "s#__CLOUDFLARED__#$CLOUDFLARED#g" \
      "$src" > "$dst"
  # Validate the filled plist before anyone tries to load it.
  if plutil -lint "$dst" >/dev/null; then
    echo "staged + valid: $dst"
  else
    echo "INVALID PLIST: $dst — fix before loading." >&2
    exit 1
  fi
done

# Make the wrappers executable.
chmod +x "$SCRIPT_DIR/feedrun.sh" "$SCRIPT_DIR/server.sh"

echo
echo "================================================================"
echo "Staged. NOTHING IS LOADED YET — run these yourself (login session):"
echo
echo "  # 1. Fill the env files (once):"
echo "  cp harness/ops/launchd/feedrun.env.example harness/ops/launchd/feedrun.env   # PATH + TRANSCRIPT_DIRS"
echo "  cp harness/ops/launchd/server.env.example  harness/ops/launchd/server.env    # PATH + OPENKEY_ALLOWED_ADDRESSES"
echo "  # edit both; ensure .env has the Gemini key (GOOGLE_AI_API_KEY=...)"
echo
echo "  # 2. Load (bootstrap into your GUI session):"
echo "  UID_=\$(id -u)"
for p in "${PLISTS[@]}"; do
  echo "  launchctl bootstrap gui/\$UID_ \"$AGENTS/$p\""
done
echo
echo "  # 3. Inspect / run-now / uninstall:"
echo "  launchctl print gui/\$UID_/com.tinycloud.distillery.server      # status"
echo "  launchctl kickstart -k gui/\$UID_/com.tinycloud.distillery.feedrun  # run the feed-run NOW"
echo "  launchctl bootout gui/\$UID_/com.tinycloud.distillery.feedrun   # uninstall one"
echo
echo "  # Logs: harness/ops/launchd/logs/{feedrun,server,tunnel}.{out,err}.log"
echo "================================================================"
