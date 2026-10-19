# willys-bot

food-bot plans a household's weekly Willys shop around the week's offers, emails the plan, and
on approval fills the Willys cart and books a pickup slot. Placing the order stays manual.

## Email

food-bot has its own address (`mail.address` in `household.json`, for example
`food@ai.lau.engineering`) on a domain Resend sends and receives for. Plans go out from it, and
members can write to it any time:

- Reply **yes** or **no** to a plan email to approve or skip it.
- Anything else ("we are out of milk", "no coriander ever", "swap the pork for chicken") goes to
  Claude with the shopping list, pantry and preferences tools. It makes the change, replies to the
  household saying what it did, and asks the planner for a revised plan when the week's plan
  should change.

Only mail from a household member whose domain Resend verified (DMARC, or DKIM aligned with the
From domain) is acted on. Everything else is recorded and ignored without a reply.

The Resend API key needs full access: a sending-only key cannot read received mail. The domain
needs Resend's receiving MX record in addition to the sending records.

## Running on hermes

Timers per household (`deploy/systemd/`): offer snapshot daily at 06:30, inbox every five
minutes, plan on Wednesdays at 07:00.

From the Mac, once:

```sh
deploy/sync-secrets.sh          # Resend key from Infisical (Food Bot), Willys login from Keychain
deploy/push-household.sh lau    # config, preferences and database
```

On hermes:

```sh
git clone git@github.com:toshi38/willys-bot.git ~/code/willys-bot
cd ~/code/willys-bot && deploy/setup.sh lau
deploy/run.sh lau inbox --dry-run                       # by hand, with the timers' credentials
journalctl --user -u 'willys-bot-*@lau'                 # logs
```

Once pushed, hermes holds the live household data; the Mac's copy under `data/` and
`households/` is no longer updated.

## Development

```sh
npm test
npm run typecheck
npm run wb -- --help
```
