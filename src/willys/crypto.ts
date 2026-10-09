import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

// Willys' login form encrypts the username and password in the browser before
// posting them (AES-128-CBC, key from PBKDF2 over a random numeric string that
// is sent alongside). It adds nothing on top of TLS, but the login endpoint
// only accepts this format. Ported from ErikHellman/willys-agent (MIT).

export interface EncryptedCredential {
  key: string;
  str: string;
}

export function encryptCredential(plaintext: string): EncryptedCredential {
  const iv = randomBytes(16);
  const salt = randomBytes(16);
  const key = digits(8) + digits(8);
  const derived = pbkdf2Sync(key, salt, 1000, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", derived, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const combined = `${iv.toString("hex")}::${salt.toString("hex")}::${encrypted.toString("base64")}`;
  return { key, str: Buffer.from(combined).toString("base64") };
}

function digits(n: number): string {
  let out = "";
  for (const b of randomBytes(n)) out += String(b % 10);
  return out;
}
