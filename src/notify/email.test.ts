import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyReply, stripQuoted } from "./email.ts";

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
