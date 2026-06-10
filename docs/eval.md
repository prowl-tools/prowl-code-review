# Quality eval harness

`prowl-review` is built to *prove* parity with CodeRabbit/Greptile, not assert
it. The eval harness scores the reviewer against a fixed, in-repo benchmark of
pull requests with known bugs (and clean PRs that should stay quiet), so every
prompt/model/threshold change is measured instead of guessed — and regressions
are visible before release. (backlog #13)

## What it measures

Each benchmark case is a self-contained unified diff labelled `bug` (it contains
known, located defects) or `clean` (it should produce no findings). The runner
feeds each diff through the **real** review pipeline (multi-pass specialists →
judge → false-positive verification) and scores the findings:

- **Recall** — bug-level: did a finding cover each known defect? `coveredBugs / expectedBugs`.
- **Precision** — finding-level: did each finding hit a real defect? `matchedFindings / totalFindings`.
- **F1** — harmonic mean of precision and recall.
- **Clean-PR false-alarm rate** — average findings per `clean` case (lower is better).

A finding covers a defect when it's on the same file and within ±`lineWindow`
lines (default 3); `--require-category` additionally demands a category match.
Recall and precision are kept as separate notions deliberately, so several
findings landing on one bug don't distort either number.

Every report is stamped with the **provider/model** and a **prompt fingerprint**
(a hash of the shared specialist system block, the specialist set, and the
verifier prompt). Change a prompt and the fingerprint changes — so a score is
always attributable to the exact prompts that produced it.

## Running it

The harness calls the real reviewer, so it needs your provider key:

```bash
export PROWL_AI_KEY=sk-...           # and optionally PROWL_AI_PROVIDER / PROWL_AI_MODEL
node dist/cli.js eval                # scores ./bench, prints a markdown summary
```

Useful flags:

| Flag | Effect |
| --- | --- |
| `--bench <dir>` | Benchmark directory (default `./bench`). |
| `--json <path>` | Write the full JSON report (for archival/diffing across runs). |
| `--line-window <n>` | Line tolerance when matching findings to bugs (default 3). |
| `--require-category` | Require a finding's category to match the expected bug. |
| `--no-verify` | Skip the false-positive verification pass during the run. |
| `--min-severity <sev>` | Mirror a non-default review severity floor. |
| `--min-precision <0–1>` | Fail (exit 1) if precision is below this. |
| `--min-recall <0–1>` | Fail (exit 1) if recall is below this. |
| `--min-f1 <0–1>` | Fail (exit 1) if F1 is below this. |

The `--min-*` gates make the harness CI-usable: wire it into a manual or
scheduled workflow (it costs real LLM tokens, so it is **not** part of the
per-PR Action) and let a quality drop fail the job.

## Reproducibility

Cases are stored in-repo and never fetched from GitHub, so a run depends only on
the cases + the reviewer's own LLM call. Pin the comparison by recording each
JSON report against its `provider`, `model`, and `promptFingerprint`; a score
move is then either a prompt change (fingerprint differs) or a model/data change
(it doesn't). The harness logic itself is covered by unit tests that inject a
fake completion, so CI validates the scoring without spending tokens.

## Growing the benchmark

See [`bench/README.md`](../bench/README.md) for the case format and how to add
cases. Keep the set balanced — enough `bug` cases across
correctness/security/performance/tests to measure recall, and enough realistic
`clean` cases to keep the false-alarm rate honest.
