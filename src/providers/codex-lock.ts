import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Machine-wide Codex serialization lock (backlog #45).
 *
 * OpenAI requires **one `auth.json` per serialized stream**, and #64 runs several
 * self-hosted runner instances against a single shared `CODEX_HOME`. An advisory
 * file lock at `$CODEX_HOME/.prowl-review.lock` serializes `codex` spawns across
 * every process on the host so two runs never share the one login concurrently.
 *
 * Within a single prowl-review process, an in-process queue serializes codex
 * operations too (so the specialist fan-out shares one lock holder rather than
 * self-contending on the file lock — the documented tradeoff is that codex passes
 * run sequentially, not in parallel). Stale locks left by a dead process are
 * reclaimed by checking the recorded pid. prowl-review never reads, copies, or
 * logs `auth.json` — only the `codex` binary does.
 */

export const CODEX_LOCK_FILENAME = ".prowl-review.lock";

/** Resolve `$CODEX_HOME` (or an explicit override), defaulting to `~/.codex`. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env, override?: string): string {
  const raw = override?.trim() || env.CODEX_HOME?.trim();
  return raw && raw.length > 0 ? raw : join(homedir(), ".codex");
}

/** Path to the advisory lock file inside a `CODEX_HOME`. */
export function codexLockPath(codexHome: string): string {
  return join(codexHome, CODEX_LOCK_FILENAME);
}

interface LockRecord {
  pid: number;
  ts: number;
}

export interface AcquireLockOptions {
  /** Poll interval while waiting for a held lock, ms. Default 50. */
  pollIntervalMs?: number;
  /** Max time to wait before giving up, ms. Default 120_000 (2 min). */
  timeoutMs?: number;
  /**
   * A held lock older than this is treated as stale even when the pid check is
   * inconclusive (e.g. pid reused), ms. Default 15 min — well past any real run.
   */
  maxAgeMs?: number;
  /** Injectable "is this pid alive?" check (default: `process.kill(pid, 0)`). */
  isProcessAlive?: (pid: number) => boolean;
  /** Injectable clock (ms since epoch). */
  now?: () => number;
  /** Injectable sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** Default liveness probe: signal 0 succeeds for a live pid, EPERM means it exists. */
function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but we can't signal it (still alive).
    // ESRCH: no such process (dead → reclaimable).
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockRecord(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
    if (typeof parsed?.pid === "number") {
      return { pid: parsed.pid, ts: typeof parsed.ts === "number" ? parsed.ts : 0 };
    }
    return null;
  } catch {
    return null;
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquire the advisory file lock, waiting (with stale-lock reclaim) until it is
 * free or the timeout elapses. Returns an idempotent release function.
 */
export async function acquireFileLock(
  lockPath: string,
  options: AcquireLockOptions = {}
): Promise<() => void> {
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxAgeMs = options.maxAgeMs ?? 15 * 60_000;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const start = now();

  mkdirSync(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      // O_EXCL create: succeeds only when the file does not already exist.
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, ts: now() }));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Best-effort: another reclaim may have already removed it.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // The lock is held. Reclaim it when the holder is dead or the record is
      // unreadable/too old; otherwise wait and retry until the timeout.
      const record = readLockRecord(lockPath);
      const stale =
        record === null ||
        !isProcessAlive(record.pid) ||
        (record.ts > 0 && now() - record.ts > maxAgeMs);
      if (stale) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Another process may have reclaimed it first; loop and retry.
        }
        continue;
      }
      if (now() - start >= timeoutMs) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for the Codex lock at ${lockPath} ` +
            `(held by pid ${record.pid}). Another prowl-review Codex run may be in progress on this machine.`,
          { cause: error }
        );
      }
      await sleep(pollIntervalMs);
    }
  }
}

// In-process queue: serialize every codex operation in THIS process so the
// specialist fan-out shares one lock holder instead of self-contending on the
// file lock. Kept module-global on purpose (one CODEX_HOME per host).
let processChain: Promise<unknown> = Promise.resolve();

function runExclusiveInProcess<T>(fn: () => Promise<T>): Promise<T> {
  const result = processChain.then(fn, fn);
  // Keep the chain moving whether fn resolved or rejected, without leaking the
  // rejection to the next queued op (each caller still sees its own result).
  processChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export interface CodexLockConfig {
  /** When false, run without any locking (opt-out for single-instance hosts). */
  enabled: boolean;
  /** Absolute path to the advisory lock file. */
  lockPath: string;
  /** Injectable acquire (for tests). */
  acquire?: typeof acquireFileLock;
  /** Options forwarded to the acquire call. */
  acquireOptions?: AcquireLockOptions;
}

/**
 * Run `fn` while holding the machine-wide Codex lock (and the in-process queue),
 * releasing both afterwards. With `enabled: false` it runs `fn` directly.
 */
export async function withCodexLock<T>(lock: CodexLockConfig, fn: () => Promise<T>): Promise<T> {
  if (!lock.enabled) {
    return fn();
  }
  const acquire = lock.acquire ?? acquireFileLock;
  return runExclusiveInProcess(async () => {
    const release = await acquire(lock.lockPath, lock.acquireOptions);
    try {
      return await fn();
    } finally {
      release();
    }
  });
}
