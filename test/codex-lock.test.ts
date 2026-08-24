import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireFileLock,
  codexLockPath,
  resolveCodexHome,
  withCodexLock,
  CODEX_LOCK_FILENAME
} from "../src/providers/codex-lock.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prowl-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

describe("resolveCodexHome / codexLockPath", () => {
  it("resolves CODEX_HOME with a ~/.codex default and the lock filename", () => {
    expect(resolveCodexHome({ CODEX_HOME: "/x/codex" })).toBe("/x/codex");
    expect(resolveCodexHome({})).toMatch(/\.codex$/);
    expect(codexLockPath("/x/codex")).toBe(join("/x/codex", CODEX_LOCK_FILENAME));
  });
});

describe("acquireFileLock", () => {
  it("serializes two concurrent acquisitions of the same lock", async () => {
    const lockPath = join(dir, "lock");
    const release1 = await acquireFileLock(lockPath, { pollIntervalMs: 1 });
    expect(existsSync(lockPath)).toBe(true);

    let acquired2 = false;
    const second = acquireFileLock(lockPath, { pollIntervalMs: 1 }).then((release) => {
      acquired2 = true;
      return release;
    });

    // While the first holder keeps the lock, the second must not acquire it.
    await tick();
    expect(acquired2).toBe(false);

    release1();
    const release2 = await second;
    expect(acquired2).toBe(true);
    release2();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims a stale lock left by a dead process", async () => {
    const lockPath = join(dir, "lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() }));
    const release = await acquireFileLock(lockPath, {
      pollIntervalMs: 1,
      isProcessAlive: () => false
    });
    // The lock is now ours (record rewritten with our pid).
    const record = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(record.pid).toBe(process.pid);
    release();
  });

  it("times out when a live holder never releases", async () => {
    const lockPath = join(dir, "lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 4242, ts: Date.now() }));
    let clock = 1000;
    const error = await acquireFileLock(lockPath, {
      pollIntervalMs: 1,
      timeoutMs: 50,
      isProcessAlive: () => true,
      now: () => clock,
      sleep: async () => {
        clock += 100; // advance past the timeout on the next check
      }
    }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Timed out .* waiting for the Codex lock/);
  });
});

describe("withCodexLock", () => {
  it("runs fn without touching the lock file when disabled", async () => {
    const lockPath = join(dir, "lock");
    const result = await withCodexLock({ enabled: false, lockPath }, async () => "ok");
    expect(result).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("serializes overlapping in-process operations", async () => {
    const lockPath = join(dir, "lock");
    const order: string[] = [];
    const op = (id: string) =>
      withCodexLock({ enabled: true, lockPath, acquireOptions: { pollIntervalMs: 1 } }, async () => {
        order.push(`start-${id}`);
        await tick();
        order.push(`end-${id}`);
      });

    await Promise.all([op("a"), op("b")]);
    // Neither op interleaves: each fully starts and ends before the next runs.
    expect(order).toEqual(["start-a", "end-a", "start-b", "end-b"]);
    expect(existsSync(lockPath)).toBe(false);
  });
});
