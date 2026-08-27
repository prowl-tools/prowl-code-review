# Linter / SAST grounding

Deterministic tools run over the changed files and their results are fed into the
review as **grounding** — so the specialists reconcile with real linter/SAST output
instead of re-discovering (or hallucinating) issues. This lifts precision and
catches mechanical problems the LLM might gloss over.

Runners (each skips gracefully when the tool isn't installed — no failure, just a
note in the review):

| Runner | Catches | Languages |
|---|---|---|
| **ESLint** | Lint errors/warnings | JS/TS |
| **Ruff** | Lint issues | Python |
| **Gitleaks** | Committed secrets | any |
| **Semgrep** | SAST / security patterns | multi-language |
| **osv-scanner** | Dependency CVEs / license issues | manifests/lockfiles |

Findings are normalized (category `lint`/`security`, calibrated severity +
confidence), merged into the review, and de-duplicated by the judge against
anything the LLM independently found.

## Trust model

Repo-local linters can execute project-defined config/plugins, so prowl-review only
runs them when the workspace is **trusted** — enabled via `--trust-workspace` (CLI),
`PROWL_TRUST_WORKSPACE=true`, or the `trust-workspace` Action input, and
**disabled automatically for fork PRs**. Workspace trust is deliberately *not*
readable from repo config, so a PR can't grant itself execution. Untrusted
checkouts skip repo-local execution and say so in the review notes.

## Semgrep

Semgrep runs over changed source files and is on by default.

```yaml
grounding:
  enabled: true        # master switch
  semgrep:
    enabled: true
    config: p/default  # a Semgrep registry pack (p/…, r/…, auto)
```

**Ruleset sourcing.** The default `p/default` registry pack is fetched from
Semgrep's registry (cached after the first run) with **metrics and version checks
disabled**, so no project metadata is uploaded and your source stays on the
runner. That's why `--config auto`, which phones home, isn't the default. Only
registry refs (`p/…`, `r/…`, `auto`) are supported — repository-supplied rulesets
(e.g. `.semgrep.yml`) and remote `http(s)://` configs are skipped even on trusted
workspaces, since a PR could ship or point at a malicious or noisy ruleset.

For untrusted PR scans, repository `.gitignore` and `.semgrepignore` target
filters are bypassed and symlink targets are skipped, so explicitly changed
regular files cannot hide from SAST grounding.

To use Semgrep in CI, make it available on the runner (e.g. `pip install semgrep`
or a setup action). Without it, the rest of the review is unaffected.

## Dependency CVE / license scanning

When a PR changes a dependency lockfile, prowl-review scans it with
[osv-scanner v2](https://github.com/google/osv-scanner) and surfaces known
vulnerabilities as findings — one per advisory, with the CVE id, affected
`package@version`, and the fixed version when available. osv-scanner reads
lockfiles as data and never executes your code, so it runs even on untrusted
checkouts; repository-local `osv-scanner.toml` files are ignored so an untrusted
PR can't suppress findings through scanner config.

Lockfiles are scanned even though the ignore list excludes them from line-by-line
review — the scan sources changed manifests from the full diff. Supported
ecosystems follow osv-scanner (npm, PyPI, Go, Cargo, Maven, Composer, RubyGems,
and more).

Set an SPDX license allowlist to also flag dependencies whose license falls
outside your policy:

```yaml
dependencyScan:
  enabled: true                                  # default; set false to disable
  licenses:
    allow: [MIT, Apache-2.0, BSD-3-Clause, ISC]  # deps outside this list are flagged
```

## Bounds

Grounding runs at most two tool runners at a time. Gitleaks file scans and Semgrep
invalid-target retries are bounded inside their runners, and every runner honors
the grounding file/finding caps, so a large PR doesn't fan out unbounded external
processes.

Turn everything off with `--no-grounding` or `grounding.enabled: false`. See
[Privacy](privacy.md) for the exact outbound calls grounding can make (the Semgrep
registry and OSV.dev).
