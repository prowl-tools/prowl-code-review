# Cross-file context

The biggest bug-catching lever is **agentic cross-file context**: instead of an
embeddings index or a vector DB, the reviewer is handed sandboxed, bounded tools
over the checked-out repo and decides what to fetch on demand — catching broken
callers, contract/interface violations, and inconsistent patterns a diff-only
review misses.

## The tools

| Tool | What it does |
|---|---|
| `read_file` | Read a repo file (bounded, root-confined). |
| `search_repo` | Regex grep over file contents. |
| `list_files` | List files under a directory. |
| `find_definition` | Locate where a symbol is **declared** — language-aware, definition-shaped patterns (`function`/`class`/`const`, `def`, `func`, `fn`, Go receiver methods, assigned arrow functions, typed methods, C macros). |
| `find_references` | Find a symbol's call sites / references. |

`find_definition` / `find_references` are **language-aware** (across 23 detected
languages, with an optional `language` hint for precision) and give AST-grade
"where is X declared / who calls X" lookup — **without** a tree-sitter/WASM
dependency, keeping the "agentic grep, no heavy infra" design: no indexing step,
nothing extra shipped.

## Guards

Every tool is confined to the repo root, rejects symlinks and ignored paths,
skips binary files, bounds match/read sizes, validates search regexes, **redacts
secrets**, and **skips credential files** — so context gathering can never leak a
secret or escape the workspace. See [Privacy](privacy.md).

## Bounds

```yaml
context:
  enabled: true
  maxRounds: 6    # tool-use rounds
  maxFiles: 20    # distinct files the agent may read
```

Retrieval is risk-tiered (smaller diffs get fewer rounds/files) and everything
fetched — plus any truncation or limit hit — is reported in the review, never
dropped silently. Disable with `--no-context` or `context.enabled: false`.

## With the Codex provider

`provider: codex` gathers context differently: it runs a single
`codex exec --sandbox read-only` that returns a strict-schema file bundle, and
every returned path is then re-read through prowl-review's own sandboxed toolkit
and secret redaction, so Codex's raw shell output is never trusted. `maxFiles` and
token bounds are honored, with truncation reported.

**Read boundary.** That `--sandbox read-only` run happens against your **real repo
root**, so Codex's own shell can *read* any file in the checkout while exploring —
`read-only` stops it modifying the checkout, not reading it. prowl-review's
sensitive-file refusal and secret redaction protect the **bundle Codex returns**
(what enters the review), not what Codex may open on disk. The retrieval prompt
asks it to leave `.env`, keys, certificates, and credential files alone, but that
is guidance, not a sandbox guarantee. If a repo holds secrets a Codex process must
never read at all, don't use `provider: codex` for it. See
[Auth](auth.md#codex-subscription-provider-45) and [Privacy](privacy.md).
