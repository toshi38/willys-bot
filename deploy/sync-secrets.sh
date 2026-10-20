#!/usr/bin/env bash
# Copies food-bot's secrets to hermes, where each is encrypted as a machine-bound systemd
# credential. Run from the Mac after creating or rotating one.
# All three come from Infisical (project Food Bot, prod), read with your own Infisical login:
#   RESEND_API_KEY   full access, for sending and reading received mail
#   WILLYS_USERNAME  the household's willys.se login
#   WILLYS_PASSWORD
set -euo pipefail

host="${HERMES_HOST:-hermes}"
project="${INFISICAL_PROJECT_ID:-b83a832f-b552-48c8-bfa2-f4cb0f0878d9}" # Food Bot, in Lau Engineering AB
env="${INFISICAL_ENV:-prod}"

store() { # name, value on stdin
  ssh "$host" "set -e; umask 077; v=\$(cat)
    [ -n \"\$v\" ] || { echo 'refusing: $1 is empty' >&2; exit 1; }
    mkdir -p ~/.config/credstore.encrypted
    printf %s \"\$v\" | systemd-creds encrypt --user --name=$1 - ~/.config/credstore.encrypted/$1
    echo \"$1 stored\""
}

get() {
  infisical secrets get "$1" --projectId "$project" --env "$env" --domain https://eu.infisical.com --plain --silent
}

get RESEND_API_KEY |
  { v=$(cat); case "$v" in re_?*) printf %s "$v" ;; *) echo "refusing: RESEND_API_KEY is empty or not a Resend key" >&2; exit 1 ;; esac; } |
  store willys-bot-resend-key
get WILLYS_USERNAME | store willys-bot-willys-username
get WILLYS_PASSWORD | store willys-bot-willys-password
