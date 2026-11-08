#!/usr/bin/env bash
# Keeps hermes on main: fast-forwards the checkout to origin/main, then
# reinstalls dependencies and systemd units when they changed. Run hourly by
# willys-bot-update@<household>.timer, and by hand straight after a push
# (see CLAUDE.md). It fails (and the operator is emailed) when the checkout
# cannot fast-forward, for example with local changes; it never resets them.
#   deploy/update.sh lau
set -euo pipefail
cd "$(dirname "$0")/.."
household="${1:?usage: deploy/update.sh <household>}"

git fetch -q origin main
old=$(git rev-parse HEAD)
new=$(git rev-parse origin/main)
[[ "$old" == "$new" ]] && exit 0

git merge -q --ff-only origin/main
changed=$(git diff --name-only "$old" "$new")
grep -qx 'package-lock.json' <<<"$changed" && npm ci --omit=dev --no-audit --no-fund
if grep -q '^deploy/systemd/' <<<"$changed"; then
  units="$HOME/.config/systemd/user"
  cp deploy/systemd/*.service deploy/systemd/*.timer "$units/"
  systemctl --user daemon-reload
  systemctl --user enable --now "willys-bot-snapshot@$household.timer" "willys-bot-inbox@$household.timer" "willys-bot-plan@$household.timer" "willys-bot-update@$household.timer" "willys-bot-publish@$household.timer"
fi
echo "updated $(git log --oneline -1 "$old" | cut -c1-60) -> $(git log --oneline -1 "$new" | cut -c1-60)"
