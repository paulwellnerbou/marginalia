#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: dev-worktree.sh [--dry-run] [--data-dir PATH]

Interactive helper that:
1. lists all git worktrees for this repo
2. lets you select one
3. runs `bun install`
4. starts the app with a shared `MARGINALIA_DATA_DIR`

Options:
  --dry-run         Print the commands instead of running them.
  --data-dir PATH   Override the shared data dir.
  -h, --help        Show this help.
EOF
}

dry_run=0
data_dir_override=""

while (($# > 0)); do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --data-dir)
      if (($# < 2)); then
        echo "--data-dir requires a path" >&2
        exit 1
      fi
      data_dir_override="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Could not locate the git repo from $script_dir" >&2
  exit 1
}

declare -a worktree_paths=()
declare -a worktree_labels=()

current_path=""
current_ref=""

flush_worktree() {
  if [[ -z "$current_path" ]]; then
    return
  fi

  local label
  label="$(basename "$current_path")"
  if [[ -n "$current_ref" ]]; then
    label="$label [$current_ref]"
  else
    label="$label [detached]"
  fi
  label="$label - $current_path"

  worktree_paths+=("$current_path")
  worktree_labels+=("$label")

  current_path=""
  current_ref=""
}

while IFS= read -r line; do
  case "$line" in
    worktree\ *)
      flush_worktree
      current_path="${line#worktree }"
      ;;
    branch\ refs/heads/*)
      current_ref="${line#branch refs/heads/}"
      ;;
    detached)
      current_ref="detached"
      ;;
    "")
      flush_worktree
      ;;
  esac
done < <(git -C "$repo_root" worktree list --porcelain)

flush_worktree

if ((${#worktree_paths[@]} == 0)); then
  echo "No worktrees found for $repo_root" >&2
  exit 1
fi

primary_worktree=""
for path in "${worktree_paths[@]}"; do
  if [[ -d "$path/.git" ]]; then
    primary_worktree="$path"
    break
  fi
done
if [[ -z "$primary_worktree" ]]; then
  primary_worktree="${worktree_paths[0]}"
fi

shared_data_dir="${data_dir_override:-${MARGINALIA_DATA_DIR:-"$primary_worktree/.data"}}"

echo "Shared data dir: $shared_data_dir"
selected_index=""

if command -v fzf >/dev/null 2>&1 && [[ -t 0 && -t 1 ]]; then
  declare -a fzf_entries=()
  for i in "${!worktree_paths[@]}"; do
    fzf_entries+=("$(printf '%s\t%s' "$i" "${worktree_labels[$i]}")")
  done

  selected_line="$(
    printf '%s\n' "${fzf_entries[@]}" | \
      fzf \
        --delimiter=$'\t' \
        --with-nth=2 \
        --prompt='Worktree > ' \
        --height=40% \
        --reverse \
        --border \
        --info=inline \
        --header='Type to filter. Double-click or press Enter to select.'
  )" || exit 130

  selected_index="${selected_line%%$'\t'*}"
else
  echo "Available worktrees:"
  PS3="Select worktree number: "
  select choice in "${worktree_labels[@]}"; do
    if [[ -n "${choice:-}" ]]; then
      selected_index=$((REPLY - 1))
      break
    fi
    echo "Invalid selection." >&2
  done
fi

selected_path="${worktree_paths[$selected_index]}"

echo "Selected worktree: $selected_path"

if ((dry_run)); then
  printf 'cd %q\n' "$selected_path"
  printf 'bun install\n'
  printf 'MARGINALIA_DATA_DIR=%q bun run dev\n' "$shared_data_dir"
  exit 0
fi

cd "$selected_path"
bun install
exec env MARGINALIA_DATA_DIR="$shared_data_dir" bun run dev
