import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Household } from "../core/household.ts";
import { addressedTo, automated, classifyReply, listReceived, planToken, replyText, senderAuthenticated, stripQuoted } from "./email.ts";

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

test("an HTML-only reply is read as text without the quoted part", () => {
  const html = "<div>Ja&nbsp;tack</div><div><br></div><blockquote>Reply yes to fill the cart</blockquote>";
  assert.equal(replyText({ text: null, html }), "Ja tack");
});

test("DMARC or aligned DKIM verified by the receiving server vouches for the sender", () => {
  assert.equal(senderAuthenticated({ authentication: { spf: "pass", dkim: "pass", dmarc: "pass" } }), true);
  // p=none domains get a gray DMARC result; DKIM aligned with From still counts.
  assert.equal(senderAuthenticated({ authentication: { spf: "pass", dkim: "pass", dmarc: "gray" } }), true);
});

test("SPF alone, misaligned DKIM or missing results do not vouch for the sender", () => {
  assert.equal(senderAuthenticated({ authentication: { spf: "pass", dkim: "gray", dmarc: "gray" } }), false);
  assert.equal(senderAuthenticated({ authentication: { spf: "fail", dkim: "fail", dmarc: "fail" } }), false);
  assert.equal(senderAuthenticated({ authentication: null }), false);
});

test("mail counts as the bot's when the bot is in To or Cc, by bare address", () => {
  assert.equal(addressedTo({ to: ["food-bot <Food@ai.lau.engineering>"], cc: [] }, "food@ai.lau.engineering"), true);
  assert.equal(addressedTo({ to: ["stephen@lau.engineering"], cc: ["food@ai.lau.engineering"] }, "food@ai.lau.engineering"), true);
  assert.equal(addressedTo({ to: ["albert@ai.lau.engineering"], cc: [] }, "food@ai.lau.engineering"), false);
});

test("the plan token is read from a reply subject", () => {
  assert.equal(planToken("Re: Willys order: week 42 [wb:1a2b3c4d]"), "1a2b3c4d");
  assert.equal(planToken("We are out of milk"), null);
});

test("received mail is listed newest first and paging stops at the start date", async () => {
  const household = { config: { mail: { secret: "test", address: "food@x.test", name: "food-bot" } } } as unknown as Household;
  process.env.CREDENTIALS_DIRECTORY = new URL("./testdata/", import.meta.url).pathname;
  const pages = [
    { data: [mail("c", "2026-10-16T10:00:00Z"), mail("b", "2026-10-15T10:00:00Z")], has_more: true },
    { data: [mail("a", "2026-10-01T10:00:00Z")], has_more: true },
  ];
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
  }) as typeof fetch;
  const got = await listReceived(household, new Date("2026-10-10T00:00:00Z"), fetchImpl);
  delete process.env.CREDENTIALS_DIRECTORY;
  assert.deepEqual(got.map((e) => e.id), ["c", "b"]);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /after=b/);
});

const mail = (id: string, created_at: string) => ({ id, created_at, to: ["food@x.test"], cc: [], from: "a@b.test", subject: "", message_id: `<${id}@b.test>` });

test("out-of-office and other automated mail is recognised", () => {
  assert.equal(automated({ headers: { "Auto-Submitted": "auto-replied" } }), true);
  assert.equal(automated({ headers: { precedence: "auto_reply" } }), true);
  assert.equal(automated({ headers: { "auto-submitted": "no", from: "carin@lau.engineering" } }), false);
  assert.equal(automated({ headers: null }), false);
});
