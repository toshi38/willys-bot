import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Household } from "../core/household.ts";
import { addressedTo, automated, classifyReply, getReceived, listReceived, planToken, replyText, sendToMembers, senderAuthenticated, stripQuoted } from "./email.ts";

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

const members = {
  config: {
    members: [
      { name: "Carin", email: "carin@lau.engineering", tailscale: [] },
      { name: "Stephen", email: "stephen@lau.engineering", tailscale: [] },
    ],
    mail: { secret: "test", address: "food@ai.lau.engineering", name: "food-bot" },
  },
} as unknown as Household;

// The Resend key comes from the test credential next to this file.
function resend(respond: (call: number) => Response | Promise<Response>) {
  process.env.CREDENTIALS_DIRECTORY = new URL("./testdata/", import.meta.url).pathname;
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return respond(calls.length);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ok = () => new Response(JSON.stringify({ id: "sent" }), { status: 200 });

test("an email goes to every member from the bot, with a Message-ID that is also its idempotency key", async () => {
  const { calls, fetchImpl } = resend(ok);
  const messageId = await sendToMembers(members, { subject: "Willys order: week 44 [wb:1a2b3c4d]", markdown: "**Chicken curry** & rice" }, fetchImpl);
  assert.match(messageId, /^<willys-bot\.[0-9a-f]{16}@ai\.lau\.engineering>$/);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, {
    "Content-Type": "application/json",
    "Idempotency-Key": messageId,
    Authorization: "Bearer re_test_not_a_real_key",
  });
  const body = JSON.parse(String(init.body));
  assert.equal(body.from, "food-bot <food@ai.lau.engineering>");
  assert.deepEqual(body.to, ["Carin <carin@lau.engineering>", "Stephen <stephen@lau.engineering>"]);
  assert.equal(body.subject, "Willys order: week 44 [wb:1a2b3c4d]");
  assert.deepEqual(body.headers, { "Message-ID": messageId });
  assert.equal(body.text, "**Chicken curry** & rice");
  assert.match(body.html, /^<!doctype html><html><body [^>]*><p><strong>Chicken curry<\/strong> &amp; rice<\/p>\n<\/body><\/html>$/);
});

test("each email gets its own Message-ID", async () => {
  const { fetchImpl } = resend(ok);
  const a = await sendToMembers(members, { subject: "a", markdown: "a" }, fetchImpl);
  const b = await sendToMembers(members, { subject: "b", markdown: "b" }, fetchImpl);
  assert.notEqual(a, b);
});

test("a reply threads under the email it answers and can go to chosen addresses only", async () => {
  const { calls, fetchImpl } = resend(ok);
  await sendToMembers(members, { subject: "Re: milk", markdown: "Added 2 x milk, 1 < 2", inReplyTo: "<abc@lau.engineering>", to: ["carin@lau.engineering"] }, fetchImpl);
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.to, ["carin@lau.engineering"]);
  assert.equal(body.headers["In-Reply-To"], "<abc@lau.engineering>");
  assert.equal(body.headers.References, "<abc@lau.engineering>");
  assert.match(body.html, /Added 2 x milk, 1 &lt; 2/);
});

test("a failed send reports the status and Resend's message", async () => {
  const { fetchImpl } = resend(() => new Response(JSON.stringify({ message: "Invalid `to` field" }), { status: 422 }));
  await assert.rejects(sendToMembers(members, { subject: "s", markdown: "m" }, fetchImpl), { message: "Resend POST /emails failed (422): Invalid `to` field" });
});

test("a failed read without a JSON body says there are no details and leaves out the query", async () => {
  const { fetchImpl } = resend(() => new Response("Bad Gateway", { status: 502 }));
  await assert.rejects(getReceived(members, "abc", fetchImpl), { message: "Resend GET /emails/receiving/abc failed (502): no details" });
  await assert.rejects(listReceived(members, new Date(0), fetchImpl), { message: "Resend GET /emails/receiving failed (502): no details" });
});

test("a received email is fetched by its escaped id", async () => {
  const { calls, fetchImpl } = resend(() => new Response(JSON.stringify({ id: "a/b", subject: "hej" }), { status: 200 }));
  const got = await getReceived(members, "a/b", fetchImpl);
  assert.equal(got.subject, "hej");
  assert.equal(calls[0].url, "https://api.resend.com/emails/receiving/a%2Fb");
  assert.equal(calls[0].init.method, undefined);
});

// Lets the retry schedule its wait, so the mocked clock can move past it.
const waitScheduled = () => new Promise((r) => setImmediate(r));

test("a read is retried after a network failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, fetchImpl } = resend((n) => {
    if (n === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ id: "abc" }), { status: 200 });
  });
  const got = getReceived(members, "abc", fetchImpl);
  await waitScheduled();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(2000);
  assert.equal((await got).id, "abc");
  assert.equal(calls.length, 2);
});

test("a read gives up after three network failures, waiting longer each time", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, fetchImpl } = resend(() => {
    throw new TypeError("fetch failed");
  });
  const outcome = assert.rejects(getReceived(members, "abc", fetchImpl), /fetch failed/);
  await waitScheduled();
  t.mock.timers.tick(1999);
  await waitScheduled();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  await waitScheduled();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(3999);
  await waitScheduled();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(1);
  await outcome;
  assert.equal(calls.length, 3);
});

test("a send is not retried after a network failure", async () => {
  const { calls, fetchImpl } = resend(() => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(sendToMembers(members, { subject: "s", markdown: "m" }, fetchImpl), /fetch failed/);
  assert.equal(calls.length, 1);
});

test("an HTTP error on a read is not retried", async () => {
  const { calls, fetchImpl } = resend(() => new Response("{}", { status: 500 }));
  await assert.rejects(getReceived(members, "abc", fetchImpl), /failed \(500\)/);
  assert.equal(calls.length, 1);
});
