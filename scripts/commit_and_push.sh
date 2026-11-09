#!/usr/bin/env bash
# Usage: scripts/commit_and_push.sh "message" path [path...]
# Commits the given paths and pushes, retrying if another workflow pushed first.
# Each workflow writes different files, so a rebase never conflicts.
set -euo pipefail
msg="$1"; shift
paths=()
for p in "$@"; do [ -e "$p" ] && paths+=("$p"); done
[ ${#paths[@]} -gt 0 ] && git add -A -- "${paths[@]}"
if git diff --cached --quiet; then
  echo "Nothing to commit."
  exit 0
fi
git commit -q -m "$msg"
for i in 1 2 3 4 5 6; do
  if git pull -q --rebase origin "${GITHUB_REF_NAME:-main}" && git push -q origin "HEAD:${GITHUB_REF_NAME:-main}"; then
    echo "Pushed: $msg"
    exit 0
  fi
  echo "Push failed (attempt $i); retrying..."
  sleep $((i * 5))
done
echo "Could not push after 6 attempts" >&2
exit 1
