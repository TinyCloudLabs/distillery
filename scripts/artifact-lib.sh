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
  if [ ! -d "$root/submodules/feed/node_modules" ] || [ ! -x "$root/submodules/feed/node_modules/.bin/portless" ]; then
    (cd "$root/submodules/feed" && bun install)
  fi
}

check_feed_submodule_drift() {
  local root="$1"
  local sibling_feed="$root/../feed"

  if ! command -v git >/dev/null 2>&1; then
    return 0
  fi

  if [ ! -d "$root/submodules/feed/.git" ] && [ ! -f "$root/submodules/feed/.git" ]; then
    return 0
  fi

  if [ ! -d "$sibling_feed/.git" ] && [ ! -f "$sibling_feed/.git" ]; then
    return 0
  fi

  local submodule_head sibling_head submodule_ref sibling_ref
  submodule_head="$(git -C "$root/submodules/feed" rev-parse --short HEAD 2>/dev/null || true)"
  sibling_head="$(git -C "$sibling_feed" rev-parse --short HEAD 2>/dev/null || true)"

  if [ -z "$submodule_head" ] || [ -z "$sibling_head" ] || [ "$submodule_head" = "$sibling_head" ]; then
    return 0
  fi

  submodule_ref="$(git -C "$root/submodules/feed" branch --show-current 2>/dev/null || true)"
  if [ -z "$submodule_ref" ]; then
    submodule_ref="detached"
  fi
  sibling_ref="$(git -C "$sibling_feed" branch --show-current 2>/dev/null || true)"
  if [ -z "$sibling_ref" ]; then
    sibling_ref="detached"
  fi

  {
    echo "warning: artifactory feed submodule differs from sibling feed repo" >&2
    echo "  submodule: $submodule_head ($submodule_ref) at submodules/feed" >&2
    echo "  sibling:   $sibling_head ($sibling_ref) at ../feed" >&2
    echo "  dev mode uses the submodule. Push/update feed and then update the submodule pointer when ready." >&2
  }

  if [ "${ARTIFACT_FEED_DRIFT:-warn}" = "strict" ]; then
    echo "error: ARTIFACT_FEED_DRIFT=strict treats feed drift as a failure" >&2
    exit 1
  fi
}
