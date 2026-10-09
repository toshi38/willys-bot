import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyReply, senderAuthenticated, stripQuoted } from "./email.ts";

test("a bare yes approves, in English or Swedish", () => {
  for (const t of ["yes", "Yes!", "ok", "Ja", "kör", "👍"]) assert.equal(classifyReply(t).kind, "approve", t);
});

test("yes with more lines is a change request, not an approval", () => {
  const d = classifyReply("ok but swap the pork for chicken\nand add milk");
  assert.equal(d.kind, "change");
});

test("no and nej reject", () => {
  for (const t of ["no", "Nej tack", "skip this week"]) assert.equal(classifyReply(t).kind, "reject", t);
});

test("free text is feedback for the planner", () => {
  const d = classifyReply("Less fish please, and we have guests on Saturday");
  assert.deepEqual(d, { kind: "change", feedback: "Less fish please, and we have guests on Saturday" });
});

test("quoted history is removed from replies", () => {
  const text = "yes\n\nOn Fri, 10 Oct 2026 at 07:00, Willys bot <bot@example.com> wrote:\n> Reply yes to fill the cart";
  assert.equal(stripQuoted(text), "yes");
  assert.equal(stripQuoted("Ja\n\nDen fre 10 okt. 2026 skrev Willys bot:\n> hej"), "Ja");
});

const msg = (headers: string[]) => `${headers.join("\r\n")}\r\n\r\nyes`;

test("a reply passes with aligned DMARC from the trusted server", () => {
  const raw = msg([
    "Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@gmail.com header.s=20230601 header.b=abc;\r\n       spf=pass smtp.mailfrom=carin@gmail.com;\r\n       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=gmail.com",
    "From: Carin <carin@gmail.com>",
  ]);
  assert.equal(senderAuthenticated(raw, "carin@gmail.com", "mx.google.com", false), true);
});

test("DKIM from an unrelated domain does not vouch for the sender", () => {
  const raw = msg(["Authentication-Results: mx.google.com; dkim=pass header.d=evil.example; dmarc=fail header.from=gmail.com", "From: carin@gmail.com"]);
  assert.equal(senderAuthenticated(raw, "carin@gmail.com", "mx.google.com", false), false);
});

test("only the topmost Authentication-Results header counts", () => {
  const raw = msg([
    "Authentication-Results: mx.google.com; dmarc=fail header.from=gmail.com",
    "Authentication-Results: mx.google.com; dmarc=pass header.from=gmail.com",
    "From: carin@gmail.com",
  ]);
  assert.equal(senderAuthenticated(raw, "carin@gmail.com", "mx.google.com", false), false);
});

test("results from an untrusted server are ignored", () => {
  const raw = msg(["Authentication-Results: attacker.example; dmarc=pass header.from=gmail.com", "From: carin@gmail.com"]);
  assert.equal(senderAuthenticated(raw, "carin@gmail.com", "mx.google.com", false), false);
});

test("without Authentication-Results only mail the account sent itself counts", () => {
  const raw = msg(["From: stephen@lau.engineering"]);
  assert.equal(senderAuthenticated(raw, "stephen@lau.engineering", "mx.google.com", true), true);
  assert.equal(senderAuthenticated(raw, "stephen@lau.engineering", "mx.google.com", false), false);
});
