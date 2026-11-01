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
- Several Claude sessions often work in this repo at once. Say which files you are about to
  change, work in a worktree under `.worktrees/`, and rebase onto `main` before pushing.
