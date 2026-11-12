# willys-bot

## Workflow

This is a personal project that nobody else uses, and changes are not reviewed. So:

- Pull requests are optional. Open one when it is handy, for example to get a Netlify deploy
  preview of the recipe site. Otherwise commit to `main` and push.
- An open PR can be marked ready and merged without asking.
- Keep each change working before it lands on `main`: `npm test` and `npm run typecheck` pass,
  and for intake or tool behaviour, the relevant eval scenarios
  (`npm run eval -- --model sonnet --only <name>`) pass too. hermes runs whatever is on
  `main` once it is pulled there.
- After pushing to `main`, update hermes straight away rather than waiting for its hourly
  update timer: `ssh hermes 'cd ~/code/willys-bot && deploy/update.sh lau'`. It fast-forwards,
  runs `npm ci` when the lockfile changed and reinstalls the systemd units when they changed.
  hermes is the XPS (hostname `stephen-XPS`).
- hermes holds the live household data, not this repo: config and preferences in
  `~/.config/willys-bot/households/lau/`, the database in `~/.local/state/willys-bot/lau/`.
  A new household setting (such as `plan.suggestions`) has to be set there too.
- Several Claude sessions often work in this repo at once. Say which files you are about to
  change, work in a worktree under `.worktrees/`, and rebase onto `main` before pushing.

## Personal details: the repo is public

github.com/toshi38/willys-bot is public, and so are its commits, PRs and issues. Real
household data belongs on hermes (see above), never in the repo. Don't add any more
personal detail about real people: no names, email addresses, street addresses, phone
numbers, health or dietary conditions, eating habits, or schedules, and no hostnames,
IPs or account and database ids.

- New tests, eval scenarios, fixtures and examples use made-up people and addresses:
  names like those in `households/example/`, emails at `example.com` or a `.test` domain.
- The real names already in older tests and eval scenarios are known and accepted. Don't
  copy them into new files or spread them further.
- Copy text from a real email, Slack thread or household preference into a test only
  after replacing every personal detail in it.

**Review step before every commit and PR.** Read the staged diff (`git diff --cached`),
the commit message, and any PR or issue text for personal detail as listed above.
gitleaks in the pre-commit hook only catches credentials, not personal data, so this
read is the check. If something turns up, swap in a made-up value before committing.
If it is already pushed, tell His Eminence - Stephen rather than rewriting history on
your own.
