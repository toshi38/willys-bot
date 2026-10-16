#!/usr/bin/env bash
# Copies food-bot's secrets to hermes, where each is encrypted as a machine-bound systemd
# credential. Run from the Mac after creating or rotating one.
#   Resend API key (full access, for sending and reading received mail): from Infisical,
#     read with your own Infisical login.
#   Willys login: from the Mac's Keychain (service willys-bot-willys, accounts username and password).
set -euo pipefail

host="${HERMES_HOST:-hermes}"
project="${INFISICAL_PROJECT_ID:?set INFISICAL_PROJECT_ID to the Infisical project holding the Resend key}"
env="${INFISICAL_ENV:-prod}"
secret="${INFISICAL_SECRET:-RESEND_API_KEY}"

store() { # name, value on stdin
  ssh "$host" "set -e; umask 077; v=\$(cat)
    [ -n \"\$v\" ] || { echo 'refusing: $1 is empty' >&2; exit 1; }
    mkdir -p ~/.config/credstore.encrypted
    printf %s \"\$v\" | systemd-creds encrypt --user --name=$1 - ~/.config/credstore.encrypted/$1
    echo \"$1 stored\""
}

infisical secrets get "$secret" --projectId "$project" --env "$env" \
  --domain https://eu.infisical.com --plain --silent |
  { v=$(cat); case "$v" in re_?*) printf %s "$v" ;; *) echo "refusing: $secret is empty or not a Resend key" >&2; exit 1 ;; esac; } |
  store willys-bot-resend-key

for account in username password; do
  security find-generic-password -s willys-bot-willys -a "$account" -w | tr -d '\n' | store "willys-bot-willys-$account"
done
