#!/usr/bin/env bash
set -Eeuo pipefail

# One-way mirror for Elice Runbox AI Hub:
#   /home/elicer -> /mnt/elice/datahub/runbox-*
#
# It copies new/changed files and removes only files this script has previously
# synced, so multiple runboxes can share /mnt with less risk of deleting each
# other's files.

SOURCE_DIR="${SOURCE_DIR:-/home/elicer}"
DATAHUB_ROOT="${DATAHUB_ROOT:-/mnt/elice/datahub}"
TARGET_DIR="${TARGET_DIR:-}"
TARGET_WAIT_SECONDS="${TARGET_WAIT_SECONDS:-120}"
WATCH_MODE="${WATCH_MODE:-poll}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-5}"
DEBOUNCE_SECONDS="${DEBOUNCE_SECONDS:-1}"
LOG_FILE="${LOG_FILE:-/tmp/runbox-aihub-sync.log}"
STATE_DIR="${STATE_DIR:-/tmp/runbox-aihub-sync}"
PID_FILE="${PID_FILE:-$STATE_DIR/sync.pid}"
LOCK_DIR="${LOCK_DIR:-$STATE_DIR/lock}"
MANIFEST_FILE="${MANIFEST_FILE:-$STATE_DIR/manifest.json}"
SYNC_EXCLUDES="${SYNC_EXCLUDES:-}"

log() {
  mkdir -p "$(dirname "$LOG_FILE")"
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  runbox-aihub-sync.sh start   # run in the background
  runbox-aihub-sync.sh run     # run in the foreground
  runbox-aihub-sync.sh once    # sync once and exit
  runbox-aihub-sync.sh status  # show background process status
  runbox-aihub-sync.sh stop    # stop background process

Environment variables:
  SOURCE_DIR=/home/elicer
  DATAHUB_ROOT=/mnt/elice/datahub
  TARGET_DIR=                 # optional; auto-detects DATAHUB_ROOT/runbox-*
  TARGET_WAIT_SECONDS=120
  WATCH_MODE=poll             # poll, inotify, or auto
  POLL_INTERVAL_SECONDS=5
  DEBOUNCE_SECONDS=1
  SYNC_EXCLUDES=".cache/:.local/share/Trash/:*.tmp"
USAGE
}

script_path() {
  cd "$(dirname "${BASH_SOURCE[0]}")"
  printf '%s/%s\n' "$(pwd -P)" "$(basename "${BASH_SOURCE[0]}")"
}

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

acquire_lock() {
  mkdir -p "$STATE_DIR"

  if is_running; then
    log "sync is already running with pid $(cat "$PID_FILE")"
    exit 0
  fi

  rm -rf "$LOCK_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "another sync process appears to be starting"
    exit 0
  fi

  printf '%s\n' "$$" > "$PID_FILE"
  trap 'rm -rf "$LOCK_DIR"; rm -f "$PID_FILE"' EXIT INT TERM
}

build_rsync_excludes() {
  RSYNC_EXCLUDE_ARGS=()
  if [[ -n "$SYNC_EXCLUDES" ]]; then
    IFS=':' read -r -a patterns <<< "$SYNC_EXCLUDES"
    for pattern in "${patterns[@]}"; do
      [[ -n "$pattern" ]] && RSYNC_EXCLUDE_ARGS+=(--exclude "$pattern")
    done
  fi
}

resolve_target_dir() {
  if [[ -n "$TARGET_DIR" ]]; then
    return 0
  fi

  local deadline
  deadline=$((SECONDS + TARGET_WAIT_SECONDS))

  while true; do
    if [[ ! -d "$DATAHUB_ROOT" ]]; then
      if (( SECONDS >= deadline )); then
        die "AI Hub datahub root does not exist: $DATAHUB_ROOT"
      fi
      log "waiting for AI Hub datahub root: $DATAHUB_ROOT"
      sleep 2
      continue
    fi

    local matches=()
    local dir
    for dir in "$DATAHUB_ROOT"/runbox-*; do
      [[ -d "$dir" ]] && matches+=("$dir")
    done

    if [[ "${#matches[@]}" -eq 1 ]]; then
      TARGET_DIR="${matches[0]}"
      log "auto-detected AI Hub target: $TARGET_DIR"
      return 0
    fi

    if [[ "${#matches[@]}" -eq 0 ]]; then
      if (( SECONDS >= deadline )); then
        die "could not find AI Hub target directory: $DATAHUB_ROOT/runbox-*"
      fi
      log "waiting for AI Hub target directory: $DATAHUB_ROOT/runbox-*"
      sleep 2
      continue
    fi

    log "found multiple AI Hub target directories:"
    printf '  %s\n' "${matches[@]}" | tee -a "$LOG_FILE"
    die "set TARGET_DIR explicitly to the correct runbox-* path"
  done
}

validate_paths() {
  resolve_target_dir
  [[ -d "$SOURCE_DIR" ]] || die "source directory does not exist: $SOURCE_DIR"
  mkdir -p "$TARGET_DIR"

  local source_real target_real
  source_real="$(cd "$SOURCE_DIR" && pwd -P)"
  target_real="$(cd "$TARGET_DIR" && pwd -P)"

  case "$target_real/" in
    "$source_real"/*)
      die "target directory must not be inside source directory: $TARGET_DIR"
      ;;
  esac

  [[ "$source_real" != "$target_real" ]] || die "source and target must be different"
  command -v rsync >/dev/null 2>&1 || die "rsync is required"
  command -v python3 >/dev/null 2>&1 || die "python3 is required"
}

sync_deleted_files_from_manifest() {
  python3 - "$SOURCE_DIR" "$TARGET_DIR" "$MANIFEST_FILE" "$SYNC_EXCLUDES" <<'PY'
import fnmatch
import json
import os
import shutil
import sys
from pathlib import Path

source = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).resolve()
manifest = Path(sys.argv[3])
exclude_raw = sys.argv[4]
exclude_patterns = [p for p in exclude_raw.split(":") if p]


def excluded(rel: str) -> bool:
    rel_posix = rel.replace(os.sep, "/")
    for pattern in exclude_patterns:
        normalized = pattern.replace(os.sep, "/")
        if normalized.endswith("/"):
            prefix = normalized.rstrip("/") + "/"
            if rel_posix == normalized.rstrip("/") or rel_posix.startswith(prefix):
                return True
        if fnmatch.fnmatch(rel_posix, normalized):
            return True
    return False


def iter_entries(root: Path):
    for current_root, dirs, files in os.walk(root, topdown=True, followlinks=False):
        current = Path(current_root)
        rel_dir = current.relative_to(root).as_posix()
        kept_dirs = []
        for dirname in dirs:
            rel = dirname if rel_dir == "." else f"{rel_dir}/{dirname}"
            if not excluded(rel + "/"):
                kept_dirs.append(dirname)
        dirs[:] = kept_dirs

        for name in files:
            path = current / name
            rel = path.relative_to(root).as_posix()
            if not excluded(rel):
                yield rel

        for dirname in dirs:
            path = current / dirname
            if path.is_symlink():
                rel = path.relative_to(root).as_posix()
                if not excluded(rel):
                    yield rel


current = set(iter_entries(source))
previous = set()
if manifest.exists():
    try:
        previous = set(json.loads(manifest.read_text()))
    except Exception:
        previous = set()

for rel in sorted(previous - current, key=lambda item: item.count("/"), reverse=True):
    destination = (target / rel).resolve()
    if target not in destination.parents and destination != target:
        continue
    try:
        if destination.is_symlink() or destination.is_file():
            destination.unlink()
        elif destination.is_dir():
            destination.rmdir()
    except FileNotFoundError:
        pass
    except OSError:
        # Keep non-empty directories; they may contain files owned by another
        # runbox's sync process.
        pass

for current_root, dirs, files in os.walk(target, topdown=False, followlinks=False):
    path = Path(current_root)
    if path == target:
        continue
    try:
        path.rmdir()
    except OSError:
        pass

manifest.parent.mkdir(parents=True, exist_ok=True)
tmp = manifest.with_suffix(".json.tmp")
tmp.write_text(json.dumps(sorted(current), ensure_ascii=False, indent=2))
tmp.replace(manifest)
PY
}

sync_once() {
  validate_paths
  build_rsync_excludes

  log "sync start: $SOURCE_DIR -> $TARGET_DIR"
  if [[ -n "$SYNC_EXCLUDES" ]]; then
    rsync -a --links --safe-links "${RSYNC_EXCLUDE_ARGS[@]}" "$SOURCE_DIR"/ "$TARGET_DIR"/ >> "$LOG_FILE" 2>&1
  else
    rsync -a --links --safe-links "$SOURCE_DIR"/ "$TARGET_DIR"/ >> "$LOG_FILE" 2>&1
  fi
  sync_deleted_files_from_manifest
  log "sync done"
}

run_loop() {
  acquire_lock
  sync_once

  if [[ "$WATCH_MODE" == "poll" ]]; then
    log "watching by polling every ${POLL_INTERVAL_SECONDS}s"
    while true; do
      sleep "$POLL_INTERVAL_SECONDS"
      sync_once
    done
  fi

  if [[ "$WATCH_MODE" == "inotify" || "$WATCH_MODE" == "auto" ]] && command -v inotifywait >/dev/null 2>&1; then
    log "watching with inotifywait"
    while true; do
      if inotifywait -qq -r -e close_write,create,delete,move,modify,attrib "$SOURCE_DIR"; then
        sleep "$DEBOUNCE_SECONDS"
        sync_once
      else
        log "inotifywait failed; falling back to polling for one cycle"
        sleep "$POLL_INTERVAL_SECONDS"
        sync_once
      fi
    done
  fi

  log "inotifywait is unavailable; polling every ${POLL_INTERVAL_SECONDS}s"
  while true; do
    sleep "$POLL_INTERVAL_SECONDS"
    sync_once
  done
}

start_background() {
  if is_running; then
    log "sync is already running with pid $(cat "$PID_FILE")"
    exit 0
  fi

  local self
  self="$(script_path)"
  mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")"
  nohup env \
    SOURCE_DIR="$SOURCE_DIR" \
    DATAHUB_ROOT="$DATAHUB_ROOT" \
    TARGET_DIR="$TARGET_DIR" \
    TARGET_WAIT_SECONDS="$TARGET_WAIT_SECONDS" \
    WATCH_MODE="$WATCH_MODE" \
    POLL_INTERVAL_SECONDS="$POLL_INTERVAL_SECONDS" \
    DEBOUNCE_SECONDS="$DEBOUNCE_SECONDS" \
    LOG_FILE="$LOG_FILE" \
    STATE_DIR="$STATE_DIR" \
    PID_FILE="$PID_FILE" \
    LOCK_DIR="$LOCK_DIR" \
    MANIFEST_FILE="$MANIFEST_FILE" \
    SYNC_EXCLUDES="$SYNC_EXCLUDES" \
    bash "$self" run >> "$LOG_FILE" 2>&1 &
  log "sync started in background with pid $!"
}

stop_background() {
  if ! is_running; then
    log "sync is not running"
    exit 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid"
  log "sent stop signal to pid $pid"
}

status() {
  if is_running; then
    printf 'running pid=%s\n' "$(cat "$PID_FILE")"
  else
    printf 'not running\n'
  fi
}

case "${1:-start}" in
  start)
    start_background
    ;;
  run)
    run_loop
    ;;
  once)
    sync_once
    ;;
  stop)
    stop_background
    ;;
  status)
    status
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
