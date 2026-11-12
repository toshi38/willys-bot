#!/usr/bin/env bash
# Copies a household's config, preferences and database from this machine to the server
# ($SERVER_HOST, an ssh host), once, when the server takes over. After that the server holds
# the live copy: the timers update it there.
#   SERVER_HOST=myserver deploy/push-household.sh <household> [--force]
set -euo pipefail
cd "$(dirname "$0")/.."
household="${1:?usage: deploy/push-household.sh <household> [--force]}"
host="${SERVER_HOST:?set SERVER_HOST to the ssh host of the server}"

if [[ "${2:-}" != "--force" ]] && ssh "$host" "test -e ~/.local/state/willys-bot/$household/willys-bot.sqlite"; then
  echo "$host already has data for $household; pass --force to overwrite it with this machine's copy" >&2
  exit 1
fi
ssh "$host" "umask 077; mkdir -p ~/.config/willys-bot/households/$household ~/.local/state/willys-bot/$household"
sqlite3 "data/$household/willys-bot.sqlite" ".backup '/tmp/willys-bot-$household.sqlite'"
scp -q "households/$household/household.json" "households/$household/preferences.md" "$host:.config/willys-bot/households/$household/"
scp -q "/tmp/willys-bot-$household.sqlite" "$host:.local/state/willys-bot/$household/willys-bot.sqlite"
rm "/tmp/willys-bot-$household.sqlite"
echo "Pushed $household to $host"
