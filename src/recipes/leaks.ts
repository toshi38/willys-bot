// Checks that text going to the public recipe site carries nothing that
// should stay private: a known secret value, an email address, or
// something shaped like an API key or token. It runs on hermes before the
// recipes are pushed and again in CI before the site is deployed.

const PATTERNS: [string, RegExp][] = [
  ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["a Resend API key", /\bre_[A-Za-z0-9_]{16,}/],
  ["a GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["an Anthropic or OpenAI key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a Netlify token", /\bnfp_[A-Za-z0-9]{20,}/],
  ["a JSON web token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a URL with credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
];

// A run of 32 or more letters, digits and token punctuation that mixes
// cases and digits: what keys look like and recipe text does not.
const LONG = /[A-Za-z0-9_+/=-]{32,}/g;

export function leakProblems(where: string, text: string, secrets: string[] = []): string[] {
  const problems: string[] = [];
  for (const s of secrets) {
    if (s.length >= 6 && text.includes(s)) problems.push(`${where} contains the value of a secret.`);
  }
  for (const [what, re] of PATTERNS) {
    if (re.test(text)) problems.push(`${where} contains what looks like ${what}.`);
  }
  for (const m of text.matchAll(LONG)) {
    const s = m[0];
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) {
      problems.push(`${where} contains a long token-like string (${s.slice(0, 6)}...).`);
      break;
    }
  }
  return [...new Set(problems)];
}
