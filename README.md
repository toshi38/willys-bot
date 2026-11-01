# willys-bot

food-bot plans a household's weekly Willys shop around the week's offers, emails the plan, and
on approval fills the Willys cart and books a pickup slot. Placing the order stays manual.

## The weekly shop

Each pickup has one week in the database: its dishes (each linked to a recipe in the
household's recipe library) and the items to buy. Every item says why it is there:

- **request**: a member asked for it (from the shopping list, an email, Slack or the web UI). It
  stays until a member removes it.
- **dish**: an ingredient of one of the week's dishes. It goes when the dish goes.
- **staple**: the planner's own pick, a restock or an everyday basic.

On Wednesday morning the planner drafts the week for the next pickup, unless that week already
exists. With `plan.suggestions` above `plan.meals` (for example 6 and 3), it suggests more
dishes than the household cooks, and with `plan.wildcard` one of them is home cooking from
another country they probably do not know. Members pick the dishes they want with the Pick
buttons in Slack, by replying with their numbers ("1, 3, 5", or "1, 3, 5 yes" to order at
once), or in their own words; ordering waits for at least one pick, and only the picked dishes
are bought, with every request and basic. The draft is checked before anything is saved or sent (the right number of dishes, each
with a recipe and products, only known product codes, every list item bought or skipped, a real
summary); a draft that fails is retried once, and a second failure stops the run.

After that the week changes only through edits: Claude changes the one item or dish a member
asks about, and the household is shown the updated plan. Asking for a whole new set of dishes
redrafts the dishes and keeps every request. Approving fills the cart from the week's items and
sends the week's recipes.

## Ratings

The day before each pickup food-bot asks how the food from the last one was: in Slack, a post
per dish with 1 to 5 star buttons, and by email, answered with scores and comments ("1: 4, a bit
salty"). Members can also just say how a dish was at any time. The planner sees every recipe's
average and comments: it brings back what was rated 4 or more and never suggests a recipe rated
2 or less again. `npm run wb -- survey --force` asks now.

## Email

food-bot has its own address (`mail.address` in `household.json`, for example
`food@ai.lau.engineering`) on a domain Resend sends and receives for. Plans go out from it, and
members can write to it any time:

- Reply **yes** or **no** to a plan email to approve or skip it.
- Anything else ("we are out of milk", "no coriander ever", "2 skyr instead of 1", "swap the
  pork for chicken") goes to Claude with the week, shopping list, pantry and preferences tools.
  It makes just that change and replies to the household with what it did, and with the updated
  plan when the week changed.

Only mail from a household member whose domain Resend verified (DMARC, or DKIM aligned with the
From domain) is acted on. Everything else is recorded and ignored without a reply.

The Resend API key needs full access: a sending-only key cannot read received mail. The domain
needs Resend's receiving MX record in addition to the sending records.

## Slack

With `"slack": {"bot": "food"}` in `household.json` and slack-gateway (its own repo) running on
the same machine, food-bot keeps one thread per weekly shop in its Slack channel. The shop runs
up to the next pickup, so after Friday's pickup window closes, changes go into next week's
thread. The thread gets:

- the week's plan, with **Approve** and **Skip this week** buttons, also shown in the channel;
  the post is rewritten in place when the week changes, and replaced with the outcome however
  the week was decided,
- everything food-bot emails the household, and each member email it answered,
- the changes members make to the week, list, pantry and preferences, from any source (Slack,
  email, the web UI, the CLI, the MCP server), posted on the next inbox run or straight after a
  Slack message,
- the filled cart and pickup slot.

A message in the channel works like an email to the bot: a plain yes or no in the week's thread
decides the week, anything else goes to the same Claude agent. The gateway runs
`deploy/run.sh <household> slack` for each message or click. When the gateway is not running,
nothing is posted and email carries on as usual.

## Recipe site

The week's recipes are published at food.toshi38.com: a page per week, each recipe in full, and a
cook mode that walks the steps one at a time with timers. Netlify builds it from `site-data/`
(`netlify.toml`); `npm run site -- --data site-data` builds it locally into `dist/`.

How a recipe is written (steps in cooking order, timers, passive steps that run while you carry
on) is in `.claude/skills/recipe-writing/SKILL.md`, and `src/recipes/check.ts` enforces it.

The site is public, so secrets are kept out of it twice: the pre-commit hook (`.githooks/`, turned on by
`npm install`) checks staged `site-data/` files and runs gitleaks when it is installed, and the
Netlify build refuses data that looks like it carries a secret.

## Running on hermes

Timers per household (`deploy/systemd/`): offer snapshot daily at 06:30, inbox every five
minutes, plan on Wednesdays at 07:00, and an hourly update that fast-forwards hermes to `main`
(`deploy/update.sh`), so whatever is pushed to `main` is what runs. A failed run emails the operator (`operator` in
`household.json`, or the first member) its last log lines, at most once every six hours per
unit.

From the Mac, once:

```sh
deploy/sync-secrets.sh          # Resend key and Willys login from Infisical (Food Bot)
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
