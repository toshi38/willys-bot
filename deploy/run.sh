#!/usr/bin/env bash
# Runs a willys-bot command by hand on hermes with the same environment and credentials as the timers.
#   deploy/run.sh lau inbox --dry-run
#   deploy/run.sh lau plan --dry-run
#   deploy/run.sh lau plans
set -euo pipefail
cd "$(dirname "$0")/.."
household="${1:?usage: deploy/run.sh <household> <command> [args]}"
shift
creds="$HOME/.config/credstore.encrypted"
exec systemd-run --user --wait --pipe --quiet --collect \
  -p WorkingDirectory="$PWD" \
  -p UMask=0077 \
  -p Environment="WILLYS_BOT_HOUSEHOLD=$household" \
  -p Environment="WILLYS_BOT_DATA=$HOME/.local/state/willys-bot" \
  -p Environment="WILLYS_BOT_HOUSEHOLDS=$HOME/.config/willys-bot/households" \
  -p Environment="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  -p LoadCredentialEncrypted="willys-bot-resend-key:$creds/willys-bot-resend-key" \
  -p LoadCredentialEncrypted="willys-bot-willys-username:$creds/willys-bot-willys-username" \
  -p LoadCredentialEncrypted="willys-bot-willys-password:$creds/willys-bot-willys-password" \
  /usr/bin/node --no-warnings=ExperimentalWarning src/cli.ts "$@"
