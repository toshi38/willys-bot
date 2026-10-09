import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Secrets come from systemd credentials on the XPS and the macOS Keychain on
// a Mac. They are never read from environment variables or files in the
// repo, so they cannot leak into an agent's context by accident.
//
// A secret is addressed as (service, account). In the Keychain that is the
// generic password's service and account; under systemd it is the
// credential named "<service>-<account>", or "<service>" for account
// "password" when a single value is stored.
export function readSecret(service: string, account: string): string {
  const credDir = process.env.CREDENTIALS_DIRECTORY;
  if (credDir) {
    for (const name of [`${service}-${account}`, ...(account === "password" ? [service] : [])]) {
      try {
        return readFileSync(join(credDir, name), "utf8").trim();
      } catch {
        // try the next name
      }
    }
    throw new Error(`Missing systemd credential ${service}-${account}: add LoadCredentialEncrypted for it`);
  }
  if (process.platform === "darwin") {
    try {
      return execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      throw new Error(`Secret missing from Keychain. Add it with: security add-generic-password -s ${service} -a ${account} -w`);
    }
  }
  throw new Error(`No secret ${service}/${account}: run under systemd with LoadCredentialEncrypted`);
}
