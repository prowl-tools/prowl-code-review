# Releasing prowl-review

prowl-review publishes to **npm** via a tag-triggered workflow. This is the
maintainer release checklist (#42). npm and the floating `v1` Action tag are the
only distribution channels — the Homebrew formula was dropped on 2026-08-26 (#70).

**Release policy in maintenance mode (2026-08-27):** the GitHub Action builds from the
checkout of whatever ref a workflow pins (`@main` on the owner's repos), so CI reviews never
depend on an npm release. Keep `CHANGELOG.md` `[Unreleased]` current with every merge (it is the
record of what changed), but cut a version only when something needs the npm package — a local
`npx prowl-review` user on a fixed version, or a deliberate `v1` repin. There is no cadence.

## Prerequisites (one-time)

- **npm Trusted Publishing (OIDC) — no stored token (#63).** `prowl-review` publishes
  to npm via **Trusted Publishing**: `.github/workflows/publish.yml` authenticates
  through GitHub's OIDC (`id-token: write`) and npm mints a short-lived token at
  publish time. The workflow does not read or use a stored npm publish secret. This requires a
  **one-time npmjs.com config**: on the
  [`prowl-review` package](https://www.npmjs.com/package/prowl-review) -> *Settings
  -> Trusted Publishing*, add a **GitHub Actions** trusted publisher for this
  repository (`prowl-tools/prowl-code-review`) with workflow filename `publish.yml`
  and allowed action `npm publish` selected. Selecting only `npm stage publish` does
  not authorize this workflow's direct publish. The workflow already carries
  `id-token: write` and pins a Trusted-Publishing-capable toolchain (Node 22.14.0,
  npm 11.5.1; npm 11.5.0 introduced OIDC publishing support, and npm 11.5.1 is the
  minimum compatible version). Until this config exists the `Publish to npm` step
  fails the run; that is expected and safely re-runnable once the trusted publisher
  is configured. **The standard workflow has no token fallback** — removing token
  dependence is the point of #63.

### Legacy token fallback is retired

The pre-#63 flow used a temporary npm token fallback. That fallback is now retired:
the standard release path must stay OIDC-only, and the workflow must not read or
use stored npm credentials for publishing.

For each release, verify the exact tagged version is live and provenance-attested:

```bash
set -euo pipefail
version=X.Y.Z
test "$(npm view "prowl-review@${version}" version)" = "${version}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT
(
  cd "${tmpdir}"
  npm init -y >/dev/null 2>&1
  npm install --ignore-scripts "prowl-review@${version}" >/dev/null
  npm audit signatures
)
```

Emergency direct-token auth is private-runbook-only. If a future emergency
appears to require it, stop the public release checklist before creating any
credential, repository secret, or CI change. The private maintainer security
runbook must already exist, be reviewed, and be accessible to every release
maintainer; it owns escalation contacts, the approval form, the revocation
checklist, the evidence archive location, and incident-closure criteria.

Direct token auth is permitted only for a release-blocking security or
correctness fix when waiting at least 24 hours for OIDC repair would create
greater user risk than delaying the release. Before any token is created, record
written approval from at least two core maintainers in a private issue, private
security advisory, or maintainer decision record. The release PR or emergency
commit message must link a public issue when safe; otherwise it must reference
the private record ID without secret details. That record must capture the
rationale, approvers, affected release, token scope, npm-side expiry, planned CI
secret location, revocation deadline, publish run URL, and owner for close-out
verification.

If approved, create a fresh, single-use npm granular access token scoped only to
publishing `prowl-review`, set its npm-side expiry to 24 hours or less at
creation, and add it to CI only for the emergency publish run. Never commit the
token or leave the secret available to later workflow runs. Immediately after the
package version and provenance are verified, revoke or delete the npm token,
remove the repository or CI secret, and verify revocation in npm and GitHub.
Download or archive the CI logs, job summary, and publish artifacts immediately,
then record the token ID, creation and revocation timestamps, secret-removal
evidence, publish run URL, and any npm or GitHub secret-scanning exposure checks
in the private incident record.

Do not create long-lived or reusable tokens, rely on later cleanup, use
classic/legacy automation tokens, publish without the second approver present, or
put token values, private contacts, operational timelines, deletion evidence, or
private record contents in public docs.

## Cut a release

1. **Update `CHANGELOG.md`.** Move the accumulated `[Unreleased]` notes under a new
   `## [X.Y.Z] - YYYY-MM-DD` heading (leave a fresh empty `[Unreleased]` above it).
   The release notes are extracted from this section.
2. **Bump the version** in `package.json` to `X.Y.Z` (no `v`). Commit both:
   ```bash
   git commit -am "release: vX.Y.Z"
   ```
3. **Tag and push** (the tag must be `vX.Y.Z` and match `package.json`):
   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```
4. The **`publish` workflow** runs automatically: it verifies the `vX.Y.Z` tag matches
   `package.json`, builds + lints + tests, verifies the versioned CHANGELOG section,
   prepares a draft GitHub Release from those notes, runs `npm publish --provenance --access
   public` via **Trusted Publishing (OIDC)** — no npm token — and publishes the GitHub
   Release after npm succeeds.
   - The version guard fails the run if the tag and `package.json` disagree, so a
     mismatched tag never publishes.
   - If the npmjs.com trusted publisher is not yet configured (see Prerequisites), the
     publish step fails; add the config and re-run the workflow — nothing else is burned.
5. **Verify the publish completed before moving `v1`.** Do not advance the floating
   tag until the tag-triggered `publish` workflow succeeded and the GitHub Release
   is published:
   ```bash
   release_commit="$(git rev-parse vX.Y.Z^{commit})"
   publish_run="$(
     gh run list --workflow publish.yml --event push --commit "${release_commit}" \
       --json databaseId,status,conclusion \
       --jq 'map(select(.status == "completed" and .conclusion == "success")) | .[0].databaseId // ""'
   )"
   test -n "${publish_run}"
   test "$(gh release view vX.Y.Z --json isDraft --jq .isDraft)" = "false"
   ```
6. **Advance the Action's floating `v1` tag** to the release commit, so
   `uses: prowl-tools/prowl-code-review@v1` workflows get the new release:
   ```bash
   git tag -f v1 vX.Y.Z
   git push origin v1 --force
   ```
   Confirm the remote tags now point at the same release commit before continuing:
   ```bash
   remote_v1="$(git ls-remote --tags origin refs/tags/v1 | awk '{print $1}')"
   remote_release="$(git ls-remote --tags origin refs/tags/vX.Y.Z | awk '{print $1}')"
   test -n "${remote_v1}" && test "${remote_v1}" = "${remote_release}"
   ```

## Verify

```bash
set -euo pipefail
version=X.Y.Z
npm view "prowl-review@${version}" version  # the new version is live
npx "prowl-review@${version}" --version     # X.Y.Z
```
