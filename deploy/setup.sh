#!/usr/bin/env bash
# One-time (and repeatable) setup on hermes: dependencies and systemd timers for one household.
#   deploy/setup.sh lau
set -euo pipefail
cd "$(dirname "$0")/.."
household="${1:?usage: deploy/setup.sh <household>}"

creds="$HOME/.config/credstore.encrypted"
units="$HOME/.config/systemd/user"

npm ci --omit=dev

[[ -f "$HOME/.config/willys-bot/households/$household/household.json" ]] ||
  { echo "No household $household on this machine: run deploy/push-household.sh $household from the Mac first" >&2; exit 1; }
for cred in willys-bot-resend-key willys-bot-willys-username willys-bot-willys-password; do
  [[ -f "$creds/$cred" ]] || { echo "Missing credential $creds/$cred: run deploy/sync-secrets.sh from the Mac" >&2; exit 1; }
done

mkdir -p "$units"
cp deploy/systemd/*.service deploy/systemd/*.timer "$units/"
systemctl --user daemon-reload
systemctl --user enable --now "willys-bot-snapshot@$household.timer" "willys-bot-inbox@$household.timer" "willys-bot-plan@$household.timer" "willys-bot-update@$household.timer"
systemctl --user list-timers 'willys-bot-*' --no-pager
