import { randomBytes } from "node:crypto";
import { marked } from "marked";
import type { Household } from "../core/household.ts";
import { readSecret } from "../core/secrets.ts";

// The bot has its own address on a domain that Resend sends and receives
// for. Mail goes out through Resend's API, and mail to the bot's address is
// read back from Resend's received-email API, so no mailbox password is
// involved and nothing reads a person's own inbox.

// Overridable so integration tests can run against a local fake.
const API = process.env.RESEND_API_URL ?? "https://api.resend.com";

export interface OutgoingEmail {
  subject: string;
  markdown: string;
  // Message-ID this email answers, for threading.
  inReplyTo?: string;
  // Addresses to send to instead of every member.
  to?: string[];
}

// Sends to every household member (or `to`) and returns the Message-ID set on the
// email, so later emails can thread under it.
export async function sendToMembers(household: Household, email: OutgoingEmail, fetchImpl: typeof fetch = fetch): Promise<string> {
  const mail = household.config.mail;
  const domain = mail.address.split("@")[1];
  const messageId = `<willys-bot.${randomBytes(8).toString("hex")}@${domain}>`;
  const headers: Record<string, string> = { "Message-ID": messageId };
  if (email.inReplyTo) {
    headers["In-Reply-To"] = email.inReplyTo;
    headers.References = email.inReplyTo;
  }
  await call(household, "/emails", fetchImpl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": messageId },
    body: JSON.stringify({
      from: `${mail.name} <${mail.address}>`,
      to: email.to ?? household.config.members.map((m) => `${m.name} <${m.email}>`),
      subject: email.subject,
      headers,
      text: email.markdown,
      // Markdown only: any HTML in the text (a member's words quoted, Claude's
      // reply) is shown as text, never rendered.
      html: `<!doctype html><html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.45; max-width: 760px">${marked.parse(email.markdown.replace(/</g, "&lt;"), { async: false })}</body></html>`,
    }),
  });
  return messageId;
}

export interface ReceivedSummary {
  id: string;
  to: string[];
  cc: string[];
  from: string;
  subject: string;
  created_at: string;
  message_id: string;
}

export interface ReceivedEmail extends ReceivedSummary {
  text: string | null;
  html: string | null;
  headers: Record<string, string> | null;
  received_for?: string[] | null;
  authentication: { spf: string; dkim: string; dmarc: string } | null;
}

// Every email the domain received since `since`, newest first. The list
// covers the whole receiving domain; addressedTo picks out the bot's mail.
export async function listReceived(household: Household, since: Date, fetchImpl: typeof fetch = fetch): Promise<ReceivedSummary[]> {
  const out: ReceivedSummary[] = [];
  let after: string | undefined;
  for (;;) {
    const page = (await call(household, `/emails/receiving?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`, fetchImpl)) as {
      data: ReceivedSummary[];
      has_more: boolean;
    };
    for (const e of page.data) {
      if (new Date(e.created_at) < since) return out;
      out.push(e);
    }
    if (!page.has_more || !page.data.length) return out;
    after = page.data[page.data.length - 1].id;
  }
}

export async function getReceived(household: Household, id: string, fetchImpl: typeof fetch = fetch): Promise<ReceivedEmail> {
  return (await call(household, `/emails/receiving/${encodeURIComponent(id)}`, fetchImpl)) as ReceivedEmail;
}

async function call(household: Household, path: string, fetchImpl: typeof fetch, init: RequestInit = {}): Promise<unknown> {
  const key = readSecret(household.config.mail.secret, "key");
  const request = () => fetchImpl(`${API}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${key}` } });
  // Reads are retried after a network failure; a send is not, but it
  // carries an Idempotency-Key, so a retry by the caller cannot send twice.
  const res = init.method && init.method !== "GET" ? await request() : await withRetry(request);
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(`Resend ${init.method ?? "GET"} ${path.split("?")[0]} failed (${res.status}): ${body.message ?? "no details"}`);
  return body;
}

// The bare address in "Name <addr>" or "addr".
export function address(value: string): string {
  return (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();
}

export function addressedTo(email: Pick<ReceivedSummary, "to" | "cc">, bot: string): boolean {
  const b = bot.toLowerCase();
  return [...(email.to ?? []), ...(email.cc ?? [])].some((a) => address(a) === b);
}

// A sender is trusted when Resend's receiving server verified the From
// domain: DMARC passed, or DKIM passed (Resend reports DKIM as "gray"
// unless the signing domain matches the From domain). These verdicts are
// computed on receipt, not read from headers the sender could write.
export function senderAuthenticated(email: Pick<ReceivedEmail, "authentication">): boolean {
  const a = email.authentication;
  return !!a && (a.dmarc === "pass" || a.dkim === "pass");
}

// Out-of-office replies and other machine-sent mail, which must never get
// an answer or two bots can reply to each other forever.
export function automated(email: Pick<ReceivedEmail, "headers">): boolean {
  const h = Object.fromEntries(Object.entries(email.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
  if (h["auto-submitted"] && h["auto-submitted"] !== "no") return true;
  if (/^(bulk|junk|list|auto_reply)$/.test(h.precedence ?? "")) return true;
  return "x-autoreply" in h || "x-autorespond" in h;
}

// The new text of a reply, with quoted history removed.
export function replyText(email: Pick<ReceivedEmail, "text" | "html">): string {
  const text = email.text ?? htmlToText(email.html ?? "");
  return stripQuoted(text);
}

function htmlToText(html: string): string {
  return html
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n> quoted\n")
    .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*>/.test(line)) break;
    if (/^On .+wrote:\s*$/i.test(line) || /^Den .+ skrev\b.*:\s*$/i.test(line) || /^-{2,}\s*Original Message/i.test(line)) break;
    if (/^(From|Från):\s/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

// The plan token in a subject such as "Re: Willys order: week 42 [wb:1a2b3c4d]".
export function planToken(subject: string): string | null {
  return subject.match(/\[wb:([0-9a-f]{8})\]/)?.[1] ?? null;
}

export type Decision = { kind: "approve" } | { kind: "reject" } | { kind: "change"; feedback: string };

// The first word decides: yes/ok/ja approves, no/nej/stop rejects, anything
// else is a change request handed back to the planner.
export function classifyReply(text: string): Decision {
  const first = text.trim().split(/\n/)[0]?.trim().toLowerCase() ?? "";
  if (/^(yes|ok|okay|approve|approved|ja|japp|kör|godkänn|godkänt|👍)(?=$|[\s!.,])/u.test(first) && text.trim().split(/\n/).filter((l) => l.trim()).length === 1) {
    return { kind: "approve" };
  }
  if (/^(no|nej|reject|stop|cancel|skip|avbryt)\b/.test(first)) return { kind: "reject" };
  return { kind: "change", feedback: text.trim() };
}

// Retries a request that failed on the network (not with an HTTP error),
// waiting a little longer each time.
async function withRetry(f: () => Promise<Response>, attempts = 3, delayMs = 2000): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
}
