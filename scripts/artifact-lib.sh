#!/usr/bin/env bash

artifact_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

ensure_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is required. Install it from https://bun.sh and retry." >&2
    exit 1
  fi
}

ensure_root_deps() {
  local root="$1"
  if [ ! -d "$root/node_modules" ]; then
    (cd "$root" && bun install)
  fi
}

ensure_feed_submodule() {
  local root="$1"
  if [ ! -f "$root/submodules/feed/package.json" ]; then
    git -C "$root" submodule update --init --recursive submodules/feed
  fi
}

ensure_feed_deps() {
  local root="$1"
  ensure_feed_submodule "$root"
  if [ ! -d "$root/submodules/feed/node_modules" ]; then
    (cd "$root/submodules/feed" && bun install)
  fi
}
