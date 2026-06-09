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

  it("redacts private key blocks after diff annotation", () => {
    const annotated = [
      "    10 +-----BEGIN RSA PRIVATE KEY-----",
      "    11 +MIIsecretbytes",
      "    12 +-----END RSA PRIVATE KEY-----"
    ].join("\n");
    const r = redactSecrets(annotated);
    expect(r.count).toBe(1);
    expect(r.text).toContain("[REDACTED:private-key]");
    expect(r.text).not.toContain("MIIsecretbytes");
    expect(r.text).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("redacts the value of a secret assignment but keeps the key name", () => {
    const r = redactSecrets('DB_PASSWORD="hunter2supersecret"');
    expect(r.count).toBe(1);
    expect(r.text).not.toContain("hunter2supersecret");
    expect(r.text).toContain("PASSWORD=");
    expect(r.text).toContain("[REDACTED:assignment]");
  });

  it("redacts full URL-valued secret assignments", () => {
    const r = redactSecrets("PASSWORD=postgres://user:pass@host/db");
    expect(r.count).toBe(1);
    expect(r.text).toBe("PASSWORD=[REDACTED:assignment]");
    expect(r.text).not.toContain("://user:pass");
  });

  it("redacts database URL assignments", () => {
    const r = redactSecrets('DATABASE_URL="postgres://user:pass@host/db"');
    expect(r.count).toBe(1);
    expect(r.text).toBe('DATABASE_URL="[REDACTED:assignment]"');
    expect(r.text).not.toContain("postgres://user:pass@host/db");
  });

  it("redacts common secret key assignments", () => {
    const r = redactSecrets("SECRET_KEY=django-insecure-super-secret-value");
    expect(r.count).toBe(1);
    expect(r.text).toBe("SECRET_KEY=[REDACTED:assignment]");
    expect(r.text).not.toContain("django-insecure");
  });

  it("redacts prefixed secret key assignments", () => {
    const r = redactSecrets(`STRIPE_SECRET_KEY=${"s".repeat(24)}`);
    expect(r.count).toBe(1);
    expect(r.text).toBe("STRIPE_SECRET_KEY=[REDACTED:assignment]");
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
      "secrets/prod.yaml",
      "credentials/aws.json",
      ".npmrc"
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it("flags credential/secret files with Windows separators", () => {
    for (const path of [
      "config\\.env.production",
      "certs\\server.pem",
      "deploy\\id_ed25519",
      "secrets\\prod.yaml",
      "credentials\\aws.json"
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it("does not flag ordinary source files", () => {
    for (const path of [
      "src/a.ts",
      "README.md",
      "package.json",
      "docs/env-setup.md",
      "src/secrets-helper.ts",
      "src/credentials-form.ts"
    ]) {
      expect(isSensitiveFile(path), path).toBe(false);
    }
  });
});
