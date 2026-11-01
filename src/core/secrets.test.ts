import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSecret } from "./secrets.ts";

// Every test sets CREDENTIALS_DIRECTORY, so the macOS Keychain is never
// asked.
function credentials(files: Record<string, string>): void {
  const dir = mkdtempSync(join(tmpdir(), "creds-"));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), value);
  process.env.CREDENTIALS_DIRECTORY = dir;
}

test("a systemd credential is read as <service>-<account>, without surrounding whitespace", () => {
  credentials({ "willys-bot-lau-willys-username": "  carin@lau.engineering\n" });
  assert.equal(readSecret("willys-bot-lau-willys", "username"), "carin@lau.engineering");
});

test("a password is read from <service>-password before <service>", () => {
  credentials({ "willys-bot-lau-willys-password": "specific\n", "willys-bot-lau-willys": "single\n" });
  assert.equal(readSecret("willys-bot-lau-willys", "password"), "specific");
});

test("a password stored as a single value is read from <service>", () => {
  credentials({ "willys-bot-lau-willys": "single\n" });
  assert.equal(readSecret("willys-bot-lau-willys", "password"), "single");
});

test("only a password falls back to the bare service name", () => {
  credentials({ "willys-bot-lau-resend": "re_key\n" });
  assert.throws(() => readSecret("willys-bot-lau-resend", "key"), {
    message: "Missing systemd credential willys-bot-lau-resend-key: add LoadCredentialEncrypted for it",
  });
});

test("a missing credential names the credential to add", () => {
  credentials({});
  assert.throws(() => readSecret("willys-bot-lau-willys", "password"), /Missing systemd credential willys-bot-lau-willys-password/);
});
