# Example review

This is an illustrative sample of what prowl-review posts on a pull request — a
single walkthrough summary comment (updated in place on each push), plus inline
comments on the diff. It renders live when viewed on GitHub. This example is from
a **Claude + Gemini ensemble** run, so it includes the 🤝 consensus badge and the
per-model breakdown.

The summary is built to fit on one screen: a single status line (impact, effort,
finding counts), then three collapsed rows — **📝 Walkthrough** (summary,
findings table, per-model breakdown, nitpicks, optional diagram),
**🗂️ Changed files** (grouped inventory, plus anything the guardrails did not
review), and **🔍 Review info** (coverage, grounding and verification notes,
with bulk context-retrieval chatter rolled up one level deeper). Nothing is
dropped; it is just one click away instead of competing with the findings.

> A short screen capture / GIF of a live review is tracked as a follow-up; this
> rendered sample is the canonical "what it looks like" reference in the meantime.

---

<!-- prowl-review:summary -->
## prowl-review

> [!CAUTION]
> **Impact:** 🔴 High &nbsp;·&nbsp; **Estimated effort:** ▰▰▰▱▱ (3/5) &nbsp;·&nbsp; **Findings:** 🔴 1 &nbsp; 🟠 1 &nbsp; 🟡 1

<details>
<summary><b>📝 Walkthrough</b></summary>

Adds a token-bucket rate limiter to the public API and wires it into the request
middleware. The limiter logic is sound, but the middleware applies it after auth
instead of before, and a refill rounding bug lets bursts slightly exceed the cap.

### Findings

| Severity | Location | Finding |
| :-- | :-- | :-- |
| 🔴 critical | `src/api/middleware.ts:42` | **Rate limit applied after authentication** — unauthenticated requests bypass the limiter, leaving the login route open to brute force. 🤝 2/2 |
| 🟠 major | `src/api/rate-limit.ts:58` | **Refill rounds up** — `Math.ceil` on the refill interval lets a client exceed the configured burst by up to one token per window. |

### Per-model findings

<details>
<summary>🟧 anthropic — 2 findings</summary>

- 🔴 critical `src/api/middleware.ts:42` — Limiter runs after `requireAuth`, so unauthenticated traffic is never throttled.
- 🟠 major `src/api/rate-limit.ts:58` — `Math.ceil` refill overshoots the burst cap.

</details>

<details>
<summary>🟩 gemini — 2 findings</summary>

- 🔴 critical `src/api/middleware.ts:42` — Rate limiting is bypassed for unauthenticated requests; move it ahead of auth.
- 🔵 trivial `src/api/rate-limit.ts:12` — Inline window size; extract a constant.

</details>

<details>
<summary>🧹 Nitpicks (1)</summary>

- 🔵 trivial `src/api/rate-limit.ts:12` — magic number `60_000` for the window; consider a named constant.

</details>

</details>

<details>
<summary><b>🗂️ Changed files (3 · 1 not reviewed)</b></summary>

**src/api/**
- `src/api/middleware.ts` — modified (+8 −2)
- `src/api/rate-limit.ts` — added (+41 −0)

**test/**
- `test/rate-limit.test.ts` — added (+36 −0)

**Not reviewed**
- ignored - matched the ignore list: `package-lock.json`

</details>

<details>
<summary><b>🔍 Review info</b></summary>

**Coverage:** 4/4 passes

- Ensemble review (#53): consolidated findings from 2 providers (anthropic, gemini). 🤝 marks findings ≥2 providers independently raised.
- Linter grounding: Semgrep not available in the workspace; skipped SAST grounding.
- Hid 2 low-confidence finding(s) below the confidence floor.

<details>
<summary>Context retrieval (4 notes · 3 suggested paths skipped)</summary>

- Context retrieval: Skipped Codex-suggested path src/api/limits.ts: File not found: src/api/limits.ts.
- Context retrieval: Skipped Codex-suggested path src/api/index.ts: File not found: src/api/index.ts.
- Context retrieval: Skipped Codex-suggested path docs/api.md: File not found: docs/api.md.
- Context retrieval: Reached max tool rounds (6).

</details>

</details>

---

## Actionable comments

Findings at or above `review.inlineMinSeverity` (default `minor`) also post as
one GitHub review whose body leads with the actionable count and a collapsed
prompt covering every comment, so the whole review can be handed to a coding
agent at once:

> **Actionable comments posted: 2** · 🔴 1 critical · 🟠 1 major
>
> <details><summary>🧰 Prompt for all review comments with AI agents</summary>
>
> ```text
> Resolve all 2 prowl-review findings below, one at a time.
>
> --- Finding 1 of 2 ---
> Resolve this prowl-review finding.
> …
> ```
>
> </details>

Each inline comment carries a severity badge, a committable ` ```suggestion `
block when a safe fix exists (high confidence, structurally valid, and real code
rather than prose), and (unless `agentPrompt: false`) a copy-paste "Resolve with
an AI agent" prompt. Trivial/info nitpicks stay in the summary's collapsed
section, where a fix that fails the same gate is shown as a plain "Proposed fix"
line instead of a one-click commit. Posted on `src/api/middleware.ts:42`:

> 🔴 **[critical] Rate limit applied after authentication**
>
> The limiter runs after `requireAuth`, so unauthenticated requests never reach
> it — the login route is left open to brute force. Move the limiter ahead of the
> auth middleware.
>
> ````suggestion
> app.use(rateLimit(publicApiBucket));
> app.use(requireAuth);
> ````
>
> <sub>🤖 Resolve with an AI agent: "In `src/api/middleware.ts`, move the
> `rateLimit(publicApiBucket)` middleware above `requireAuth` so unauthenticated
> requests are throttled, and add a test covering an unauthenticated burst."</sub>

---

To try it on your own repo, see [Getting started](getting-started.md).
