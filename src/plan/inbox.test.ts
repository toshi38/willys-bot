import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Context } from "../core/context.ts";
import type { Household } from "../core/household.ts";
import { Store } from "../core/store.ts";
import { handleInbox, messageLanguage } from "./inbox.ts";

const household = {
  id: "test",
  dir: "/nonexistent",
  preferences: "",
  config: {
    name: "Test",
    members: [{ name: "Carin", email: "carin@lau.engineering", tailscale: [] }],
    mail: { address: "food@ai.lau.engineering", name: "food-bot", secret: "test" },
  },
} as unknown as Household;

const verified = { spf: "pass", dkim: "pass", dmarc: "pass" };

function fakeResend(emails: { id: string; from: string; to?: string; authentication: object | null }[]) {
  const sent: unknown[] = [];
  const full = emails.map((e, i) => ({
    id: e.id,
    from: e.from,
    to: [e.to ?? "food@ai.lau.engineering"],
    cc: [],
    subject: "Hello",
    created_at: new Date(Date.now() - (emails.length - i) * 1000).toISOString(),
    message_id: `<${e.id}@test>`,
    text: "We are out of milk",
    html: null,
    authentication: e.authentication,
  }));
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === "POST") {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ id: "sent" });
    }
    if (path === "/emails/receiving") return Response.json({ data: [...full].reverse(), has_more: false });
    return Response.json(full.find((e) => path.endsWith(e.id)));
  }) as typeof fetch;
  return { fetchImpl, sent };
}

test("mail from strangers, unverified senders or to other addresses is ignored without a reply", async (t) => {
  const store = new Store(":memory:");
  store.set("mail.since", new Date(Date.now() - 60_000).toISOString());
  const { fetchImpl, sent } = fakeResend([
    { id: "stranger", from: "Mallory <mallory@evil.test>", authentication: verified },
    { id: "spoofed", from: "Carin <carin@lau.engineering>", authentication: { spf: "fail", dkim: "fail", dmarc: "fail" } },
    { id: "other-bot", from: "carin@lau.engineering", to: "albert@ai.lau.engineering", authentication: verified },
  ]);
  t.mock.method(globalThis, "fetch", fetchImpl);
  process.env.CREDENTIALS_DIRECTORY = new URL("../notify/testdata/", import.meta.url).pathname;
  t.after(() => delete process.env.CREDENTIALS_DIRECTORY);

  const log = await handleInbox({ store, household } as unknown as Context);

  assert.equal(log.length, 2);
  assert.equal(store.mailRecord("stranger")?.status, "ignored");
  assert.equal(store.mailRecord("spoofed")?.status, "ignored");
  assert.equal(store.mailRecord("other-bot"), null);
  assert.deepEqual(sent, []);
});

test("a reply follows the language the member wrote in, not the thread's", () => {
  assert.equal(messageLanguage("also carin wants a weeks worth of skyr"), "English");
  assert.equal(messageLanguage("remove the bananas and the dishwasher stuff"), "English");
  assert.equal(messageLanguage("Ta bort glutenfritt bröd det behöver vi inte"), "Swedish");
  assert.equal(messageLanguage("vi kan ta det till fredag"), "Swedish");
  assert.equal(messageLanguage("Kan vi ta 2 skyr"), "Swedish");
  // Swedish product names do not make an English message Swedish.
  assert.equal(messageLanguage("It used 2 x Kycklinglårfilé 700g and the butternut from the plan"), "English");
  assert.equal(messageLanguage("lårfilé"), "Swedish");
});
