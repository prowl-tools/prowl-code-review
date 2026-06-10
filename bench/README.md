# prowl-review quality benchmark (#13)

A fixed set of pull-request cases used by the **quality eval harness** to score
the reviewer's precision / recall / F1 and clean-PR false-alarm rate. Run it
with `prowl-review eval` (see `docs/eval.md`).

Cases are stored in-repo (never fetched from GitHub) so a run is reproducible
and needs no network — only the LLM call the reviewer itself makes.

## Layout

One sub-directory per case:

```
bench/<case-id>/
  case.json      # metadata + expected defects (required)
  input.diff     # the unified diff under review (required)
  context.txt    # optional cross-file context (as the retriever would supply)
  guidelines.md  # optional per-case review guidelines
```

### `case.json`

```jsonc
{
  "description": "Human summary of what the case exercises.",
  "kind": "bug",            // "bug" = contains the listed defects; "clean" = should yield no findings
  "expected": [             // required & non-empty for "bug"; must be empty/absent for "clean"
    {
      "file": "src/util/sum.ts",   // new-side path
      "line": 4,                    // 1-based new-side line where the defect sits
      "endLine": 6,                 // optional, for multi-line defects
      "category": "correctness",   // optional; only enforced with --require-category
      "severity": "major",         // optional; reporting only
      "note": "Why this is a defect."
    }
  ]
}
```

`line`/`endLine` are **new-side** line numbers — the same numbers the reviewer
cites — so they line up with the rendered diff. A finding counts as covering a
defect when it's on the same file and within ±`lineWindow` lines (default 3).

## Adding a case

1. Create `bench/<descriptive-id>/`.
2. Drop in `input.diff` (a real `diff --git` unified diff) and `case.json`.
3. For a `bug` case, point each `expected` entry at the changed line that holds
   the defect. For a `clean` case, set `"kind": "clean"` and omit `expected`.
4. Re-run `prowl-review eval` and confirm the case scores as intended.

Keep the set balanced: enough `bug` cases (across correctness/security/perf/
tests) to measure recall, and enough realistic `clean` cases to keep the
false-alarm rate honest.
