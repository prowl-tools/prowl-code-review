import { describe, expect, it } from "vitest";
import { redactSecrets, isSensitiveFile } from "../src/review/redact.js";

describe("redactSecrets", () => {
  it("redacts an AWS access key id", () => {
    const r = redactSecrets("aws id = AKIAIOSFODNN7EXAMPLE end");
    expect(r.count).toBe(1);
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.text).toContain("[REDACTED:aws-access-key]");
  });

  it("redacts a GitHub token", () => {
    const r = redactSecrets(`token ghp_${"a".repeat(36)} done`);
    expect(r.count).toBe(1);
    expect(r.text).toContain("[REDACTED:github-token]");
  });

  it("redacts LLM keys (sk- and sk-ant-)", () => {
    expect(redactSecrets(`sk-ant-${"A".repeat(30)}`).count).toBe(1);
    expect(redactSecrets(`sk-${"A".repeat(24)}`).count).toBe(1);
  });

  it("redacts a private key block without leaking the body", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIsecretbytes\n-----END RSA PRIVATE KEY-----";
    const r = redactSecrets(pem);
    expect(r.count).toBe(1);
    expect(r.text).toContain("[REDACTED:private-key]");
    expect(r.text).not.toContain("MIIsecretbytes");
  });

  it("redacts the value of a secret assignment but keeps the key name", () => {
    const r = redactSecrets('DB_PASSWORD="hunter2supersecret"');
    expect(r.count).toBe(1);
    expect(r.text).not.toContain("hunter2supersecret");
    expect(r.text).toContain("PASSWORD=");
    expect(r.text).toContain("[REDACTED:assignment]");
  });

  it("leaves ordinary code untouched", () => {
    const code = "const total = a + b; // running sum";
    const r = redactSecrets(code);
    expect(r.count).toBe(0);
    expect(r.text).toBe(code);
  });
});

describe("isSensitiveFile", () => {
  it("flags credential/secret files", () => {
    for (const path of [
      ".env",
      "config/.env.production",
      "deploy/id_rsa",
      "certs/server.pem",
      "secrets.json",
      ".npmrc"
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it("does not flag ordinary source files", () => {
    for (const path of ["src/a.ts", "README.md", "package.json", "docs/env-setup.md"]) {
      expect(isSensitiveFile(path), path).toBe(false);
    }
  });
});
