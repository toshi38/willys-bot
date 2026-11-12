#!/usr/bin/env bash
# Copies a household's config, preferences and database from the Mac to hermes, once, when
# hermes takes over. After that hermes holds the live copy: the timers update it there.
#   deploy/push-household.sh lau [--force]
set -euo pipefail
cd "$(dirname "$0")/.."
household="${1:?usage: deploy/push-household.sh <household> [--force]}"
host="${SERVER_HOST:-hermes}"

if [[ "${2:-}" != "--force" ]] && ssh "$host" "test -e ~/.local/state/willys-bot/$household/willys-bot.sqlite"; then
  echo "hermes already has data for $household; pass --force to overwrite it with the Mac's copy" >&2
  exit 1
fi
ssh "$host" "umask 077; mkdir -p ~/.config/willys-bot/households/$household ~/.local/state/willys-bot/$household"
sqlite3 "data/$household/willys-bot.sqlite" ".backup '/tmp/willys-bot-$household.sqlite'"
scp -q "households/$household/household.json" "households/$household/preferences.md" "$host:.config/willys-bot/households/$household/"
scp -q "/tmp/willys-bot-$household.sqlite" "$host:.local/state/willys-bot/$household/willys-bot.sqlite"
rm "/tmp/willys-bot-$household.sqlite"
echo "Pushed $household to $host"
