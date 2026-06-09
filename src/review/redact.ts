/**
 * Secret redaction (backlog #15).
 *
 * BYOK means code goes to the user's *own* provider — but we still must not ship
 * credentials. `redactSecrets` strips obvious secrets (keys, tokens, private
 * keys, `.env`-style assignments) from any text before it enters a prompt, and
 * `isSensitiveFile` flags files we refuse to read into context at all. Redactions
 * are counted, never logged by value (core principle: no silent leakage).
 */

export interface RedactionResult {
  text: string;
  /** Number of secrets redacted. */
  count: number;
}

interface SecretPattern {
  name: string;
  regex: RegExp;
  /** Capture group holding the secret value (rest of the match is preserved). */
  valueGroup?: number;
}

// Conservative, high-signal patterns (Gitleaks-inspired). Order matters: specific
// token shapes first, then the generic key=value assignment catch-all.
const SECRET_PATTERNS: SecretPattern[] = [
  { name: "private-key", regex: /(?:[ 0-9]{6} [+\- ])?-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?(?:[ 0-9]{6} [+\- ])?-----END[ A-Z]*PRIVATE KEY-----/g },
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "github-pat", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "llm-key", regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "slack-token", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    name: "assignment",
    regex: /((?:api[_-]?key|secret[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|database[_-]?url|db[_-]?url|connection[_-]?string)["']?\s*[:=]\s*["']?)([^\s"'`]{8,})(["']?)/gi,
    valueGroup: 2
  }
];

/** Replace detected secrets with `[REDACTED:<type>]`, returning a count. */
export function redactSecrets(text: string): RedactionResult {
  let count = 0;
  let output = text;

  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern.regex, (match: string, ...groups: unknown[]) => {
      count += 1;
      if (pattern.valueGroup) {
        const prefix = (groups[0] as string) ?? "";
        const suffix = (groups[2] as string) ?? "";
        return `${prefix}[REDACTED:${pattern.name}]${suffix}`;
      }
      return `[REDACTED:${pattern.name}]`;
    });
  }

  return { text: output, count };
}

// Files whose contents are sensitive by nature — never read into a prompt.
// Repo paths may be POSIX or Windows-style depending on the local checkout.
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|ppk)$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /(^|[\\/])\.(npmrc|netrc|pgpass|htpasswd)$/i,
  /(^|[\\/])(credentials|secrets)(?:[\\/]|(?:\.[^\\/]*)?$|$)/i
];

/** True when a path looks like a credential/secret file we should not read. */
export function isSensitiveFile(path: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((re) => re.test(path));
}
