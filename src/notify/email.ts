import { randomBytes } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { marked } from "marked";
import { createTransport } from "nodemailer";
import type { Household } from "../core/household.ts";
import { isMember } from "../core/household.ts";
import { readSecret } from "../core/secrets.ts";

// Plan emails go to every household member over SMTP. Replies are read over
// IMAP from the same mailbox. A reply only counts when it answers a message
// this bot sent (its Message-ID is in In-Reply-To or References), comes from
// a member, and is authenticated (see senderAuthenticated).

export interface OutgoingEmail {
  subject: string;
  markdown: string;
  inReplyTo?: string;
}

export async function sendToMembers(household: Household, email: OutgoingEmail): Promise<string> {
  const mail = household.config.mail;
  const domain = mail.user.split("@")[1] ?? "localhost";
  const messageId = `<willys-bot.${randomBytes(8).toString("hex")}@${domain}>`;
  const transport = createTransport({
    host: mail.smtpHost,
    port: mail.smtpPort,
    secure: mail.smtpPort === 465,
    auth: { user: mail.user, pass: readSecret(mail.secret, "password") },
  });
  try {
    await transport.sendMail({
      from: mail.from,
      to: household.config.members.map((m) => `${m.name} <${m.email}>`),
      subject: email.subject,
      messageId,
      ...(email.inReplyTo ? { inReplyTo: email.inReplyTo, references: [email.inReplyTo] } : {}),
      text: email.markdown,
      html: `<!doctype html><html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.45; max-width: 760px">${marked.parse(email.markdown, { async: false })}</body></html>`,
    });
  } finally {
    transport.close();
  }
  return messageId;
}

export interface Reply {
  from: string;
  date: Date;
  messageId: string;
  // The new text of the reply, with quoted history removed.
  text: string;
}

// Replies to any of `sentIds` received since `since`, oldest first.
export async function fetchReplies(household: Household, sentIds: string[], since: Date): Promise<Reply[]> {
  const mail = household.config.mail;
  const client = new ImapFlow({
    host: mail.imapHost,
    port: mail.imapPort,
    secure: true,
    auth: { user: mail.user, pass: readSecret(mail.secret, "password") },
    logger: false,
  });
  await client.connect();
  const replies: Reply[] = [];
  try {
    // Gmail files a reply sent from the same account under Sent, not Inbox,
    // so search the all-mail folder when the server has one.
    const boxes = await client.list();
    const box = boxes.find((b) => b.specialUse === "\\All")?.path ?? "INBOX";
    const lock = await client.getMailboxLock(box, { readOnly: true });
    try {
      const uids = await client.search({ since }, { uid: true });
      if (!uids || !uids.length) return [];
      for await (const msg of client.fetch(uids, { source: true, labels: true }, { uid: true })) {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const refs = [parsed.inReplyTo ?? "", ...(Array.isArray(parsed.references) ? parsed.references : [parsed.references ?? ""])];
        if (!refs.some((r) => sentIds.includes(r))) continue;
        if (parsed.messageId && sentIds.includes(parsed.messageId)) continue;
        const from = parsed.from?.value[0]?.address ?? "";
        if (!isMember(household, from)) continue;
        const sentByMailbox = [...(msg.labels ?? [])].includes("\\Sent") && from.toLowerCase() === mail.user.toLowerCase();
        if (!senderAuthenticated(msg.source.toString("utf8"), from, mail.trustedAuthservId, sentByMailbox)) continue;
        replies.push({
          from,
          date: parsed.date ?? new Date(0),
          messageId: parsed.messageId ?? "",
          text: stripQuoted(parsed.text ?? ""),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return replies.sort((a, b) => a.date.getTime() - b.date.getTime());
}

// A reply is trusted when the receiving server vouches for its sender:
// the topmost Authentication-Results header (added by our own mail server,
// above anything the sender could inject) must come from the trusted
// authserv-id and show DMARC passing for the From domain, or DKIM passing
// with a signing domain aligned to it. Mail the mailbox account sent itself
// carries no such header; it is trusted only when the server files it as
// sent by that account.
export function senderAuthenticated(rawMessage: string, from: string, trustedAuthservId: string, sentByMailbox: boolean): boolean {
  const ar = topHeader(rawMessage, "authentication-results");
  if (!ar) return sentByMailbox;
  const [authserv, ...rest] = ar.split(";");
  if (authserv.trim().toLowerCase() !== trustedAuthservId.toLowerCase()) return false;
  const fromDomain = from.split("@")[1]?.toLowerCase() ?? "";
  if (!fromDomain) return false;
  const aligned = (d: string | undefined) => !!d && (d.toLowerCase() === fromDomain || fromDomain.endsWith(`.${d.toLowerCase()}`));
  for (const clause of rest) {
    const c = clause.trim();
    if (/^dmarc=pass\b/i.test(c) && aligned(c.match(/header\.from=([^\s;]+)/i)?.[1])) return true;
    if (/^dkim=pass\b/i.test(c) && aligned(c.match(/header\.d=([^\s;]+)/i)?.[1] ?? c.match(/header\.i=@?([^\s;]+)/i)?.[1]?.split("@").pop())) return true;
  }
  return false;
}

// The first occurrence of a header in a raw message, unfolded.
function topHeader(raw: string, name: string): string | null {
  const head = raw.split(/\r?\n\r?\n/, 1)[0];
  const lines = head.split(/\r?\n/);
  const prefix = `${name.toLowerCase()}:`;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().startsWith(prefix)) continue;
    let value = lines[i].slice(prefix.length);
    while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) value += ` ${lines[++i].trim()}`;
    return value.replace(/\s+/g, " ").trim();
  }
  return null;
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
