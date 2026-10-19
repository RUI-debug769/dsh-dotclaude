#!/usr/bin/env bash
# Host smoke test: compose the plugin into a pristine DeepSeek Harness profile,
# boot that host, and (optionally) exercise the dsh-tui compatibility matrix.
#
# The unit suite covers behavior with a host double. This script covers the
# other half: a real `dsh` launcher composing and booting the real bundle.
#
#   ./scripts/host-smoke.sh                 # compose + boot
#   DOTCLAUDE_MATRIX=1 ./scripts/host-smoke.sh   # also probe dsh-tui 0.14.0 / 0.16.1
#   DOTCLAUDE_SMOKE_KEEP=1 ./scripts/host-smoke.sh # keep the temporary DSH_HOME
#
# HARNESS points at a deepseek-harness checkout; the launcher is run from source
# through tsx, exactly like `pnpm dsh`.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="${HARNESS:-$HOME/projects/harness}"
PROFILE="${DOTCLAUDE_PROFILE:-dotclaude-smoke}"
DSH_HOME_DIR="${DSH_SMOKE_HOME:-$(mktemp -d "${TMPDIR:-/tmp}/dotclaude-smoke.XXXXXX")}"
BOOT_LOG="$DSH_HOME_DIR/boot.log"

if [[ ! -f "$HARNESS/apps/cli/src/bin.ts" ]]; then
  echo "host-smoke: no deepseek-harness checkout at $HARNESS (set HARNESS=...)" >&2
  exit 2
fi

cleanup() {
  if [[ -n "${BOOT_PID:-}" ]]; then kill "$BOOT_PID" 2>/dev/null || true; fi
  if [[ "${DOTCLAUDE_SMOKE_KEEP:-0}" != "1" ]]; then rm -rf "$DSH_HOME_DIR"; else echo "kept $DSH_HOME_DIR"; fi
}
trap cleanup EXIT

dsh() {
  ( cd "$HARNESS" && DSH_HOME="$DSH_HOME_DIR" node --import tsx/esm apps/cli/src/bin.ts "$@" )
}

echo "== plugin: $PLUGIN_DIR"
echo "== dsh home: $DSH_HOME_DIR"

echo "== 1/4 build"
( cd "$PLUGIN_DIR" && npm run --silent build )

echo "== 2/4 create profile from the shipped web template"
dsh --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null

echo "== 3/4 install the plugin and compose it"
dsh plugin --profile "$PROFILE" add "link:$PLUGIN_DIR" >/dev/null
composed="$(dsh --profile "$PROFILE" --dump-config)"
if ! grep -q "name: dsh-dotclaude" <<<"$composed"; then
  echo "host-smoke: FAIL the composed profile has no dsh-dotclaude row" >&2
  exit 1
fi
echo "   composed row present"

echo "== 4/4 boot the host"
( cd "$HARNESS" && DSH_HOME="$DSH_HOME_DIR" timeout 60 node --import tsx/esm apps/cli/src/bin.ts \
    --profile "$PROFILE" --port 0 --no-open >"$BOOT_LOG" 2>&1 ) &
BOOT_PID=$!
for _ in $(seq 1 40); do
  if grep -q "dsh web: http" "$BOOT_LOG"; then break; fi
  if ! kill -0 "$BOOT_PID" 2>/dev/null; then break; fi
  sleep 1
done
if grep -q "dsh web: http" "$BOOT_LOG"; then
  echo "   boot OK: $(grep -m1 'dsh web: http' "$BOOT_LOG" | sed 's/?token=.*//')"
else
  echo "host-smoke: FAIL the host did not reach a listening state" >&2
  tail -20 "$BOOT_LOG" >&2
  exit 1
fi
if grep -qi "dsh-dotclaude\|dotclaude" "$BOOT_LOG"; then
  echo "host-smoke: FAIL the boot log mentions the plugin (a load-time diagnostic)" >&2
  grep -i "dotclaude" "$BOOT_LOG" >&2
  exit 1
fi
kill "$BOOT_PID" 2>/dev/null || true

if [[ "${DOTCLAUDE_MATRIX:-0}" == "1" ]]; then
  echo "== matrix: dsh-tui 0.14.0 must be refused by this host"
  if dsh plugin --profile "$PROFILE" add @deepseek-harness-tui/dsh-tui@0.14.0 >"$DSH_HOME_DIR/matrix-014.log" 2>&1; then
    echo "host-smoke: FAIL 0.14.0 installed, but this host should refuse it" >&2
    exit 1
  fi
  if ! grep -q "incompatible with dsh" "$DSH_HOME_DIR/matrix-014.log"; then
    echo "host-smoke: FAIL 0.14.0 failed for an unexpected reason" >&2
    tail -5 "$DSH_HOME_DIR/matrix-014.log" >&2
    exit 1
  fi
  echo "   refused as incompatible"

  echo "== matrix: dsh-tui 0.16.1 must install and compose beside the plugin"
  dsh plugin --profile "$PROFILE" add @deepseek-harness-tui/dsh-tui@0.16.1 >/dev/null
  composed="$(dsh --profile "$PROFILE" --dump-config)"
  tuis="$(grep -c "dsh-tui-" <<<"$composed" || true)"
  if [[ "$tuis" -lt 1 ]] || ! grep -q "name: dsh-dotclaude" <<<"$composed"; then
    echo "host-smoke: FAIL dsh-tui rows or the plugin row are missing after the upgrade" >&2
    exit 1
  fi
  echo "   $tuis dsh-tui rows composed beside dsh-dotclaude"
fi

echo "host-smoke: PASS"
