# Example review

This is an illustrative sample of what prowl-review posts on a pull request — a
single walkthrough summary comment, plus inline comments on the diff (not shown
here). It renders live when viewed on GitHub. This example is from a **Claude +
Gemini ensemble** run, so it includes the 🤝 consensus badge and the per-model
breakdown.

> A short screen capture / GIF of a live review is tracked as a follow-up; this
> rendered sample is the canonical "what it looks like" reference in the meantime.

---

<!-- prowl-review:summary -->
## prowl-review

> [!CAUTION]
> **Impact:** 🔴 High &nbsp;·&nbsp; **Estimated effort:** ▰▰▰▱▱ (3/5)

Adds a token-bucket rate limiter to the public API and wires it into the request
middleware. The limiter logic is sound, but the middleware applies it after auth
instead of before, and a refill rounding bug lets bursts slightly exceed the cap.

**Findings:** 🔴 1 &nbsp; 🟠 1 &nbsp; 🟡 1

| Severity | Location | Finding |
| :-- | :-- | :-- |
| 🔴 critical | `src/api/middleware.ts:42` | **Rate limit applied after authentication** — unauthenticated requests bypass the limiter, leaving the login route open to brute force. 🤝 2/2 |
| 🟠 major | `src/api/rate-limit.ts:58` | **Refill rounds up** — `Math.ceil` on the refill interval lets a client exceed the configured burst by up to one token per window. |

<details>
<summary>🧹 Nitpicks (1)</summary>

- 🟡 minor `src/api/rate-limit.ts:12` — magic number `60_000` for the window; consider a named constant.

</details>

### Per-model findings

<details>
<summary>🟧 anthropic — 2 findings</summary>

- 🔴 critical `src/api/middleware.ts:42` — Limiter runs after `requireAuth`, so unauthenticated traffic is never throttled.
- 🟠 major `src/api/rate-limit.ts:58` — `Math.ceil` refill overshoots the burst cap.

</details>

<details>
<summary>🟩 gemini — 2 findings</summary>

- 🔴 critical `src/api/middleware.ts:42` — Rate limiting is bypassed for unauthenticated requests; move it ahead of auth.
- 🟡 minor `src/api/rate-limit.ts:12` — Inline window size; extract a constant.

</details>

<details>
<summary><b>Changed files (3)</b></summary>

**src/api/**
- `src/api/middleware.ts` — modified (+8 −2)
- `src/api/rate-limit.ts` — added (+41 −0)

**test/**
- `test/rate-limit.test.ts` — added (+36 −0)

</details>

> [!NOTE]
> **Review notes**
> - Ensemble review (#53): consolidated findings from 2 providers (anthropic, gemini). 🤝 marks findings ≥2 providers independently raised.
> - Hid 2 low-confidence finding(s) below the confidence floor.

---

*Inline comments (not shown above) carry a severity badge and a committable
```suggestion``` block when a safe fix exists.*
