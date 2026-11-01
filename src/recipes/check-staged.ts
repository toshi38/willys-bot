import { execFileSync } from "node:child_process";
import { leakProblems } from "./leaks.ts";

// The pre-commit check for the recipe site's data: every staged file under
// site-data/ goes through the same leak check as the Netlify build, on the
// content being committed rather than the working tree.

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const staged = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z", "--", "site-data").split("\0").filter(Boolean);
const problems = staged.flatMap((path) => leakProblems(path, git("show", `:${path}`)));
if (problems.length) {
  for (const p of problems) console.error(p);
  console.error("Not committed: the recipe site is public. Remove the value from site-data/ and commit again.");
  process.exit(1);
}
