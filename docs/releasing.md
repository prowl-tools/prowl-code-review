# Releasing prowl-review

prowl-review publishes to **npm** via a tag-triggered workflow, and is also
available through **Homebrew**. This is the maintainer release checklist (#42).

## Prerequisites (one-time)

- **npm Trusted Publishing (OIDC) — no stored token (#63).** `prowl-review` publishes
  to npm via **Trusted Publishing**: `.github/workflows/publish.yml` authenticates
  through GitHub's OIDC (`id-token: write`) and npm mints a short-lived token at
  publish time. The workflow does not read or use `NPM_TOKEN`. This requires a
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
- Publish access to the [`prowl-tools/homebrew-tap`](https://github.com/prowl-tools/homebrew-tap) repo.

### Retiring the legacy npm token (do this after the first OIDC release)

The pre-#63 flow authenticated with an npm **granular access token** stored as the
`NPM_TOKEN` repository secret (expires **2026-10-12**). Once the first tag-triggered
release publishes through OIDC, verify the exact tagged version is live and
provenance-attested:

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

After that passes, **delete the npm token and remove the `NPM_TOKEN` repository
secret** (Settings -> Secrets and variables -> Actions). The standard release path
does not use it anymore.

Last-resort fallback (only until the trusted publisher is configured): if an urgent
release cannot wait for the npmjs.com config and OIDC cannot be used, rotate **only**
to an npm granular access token scoped to package publishing for `prowl-review`, enable
2FA bypass for noninteractive CI publishing while npm still permits direct token
publishing, set the shortest possible expiry, wire it back into the publish step
temporarily, and verify with the next tag-triggered publish. Treat direct token
publishing and 2FA bypass as an interim risk; do not create or document legacy/classic
automation tokens, and remove the secret again once OIDC is confirmed working.

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

## Update the Homebrew tap

After the npm tarball is live:

```bash
version=X.Y.Z
url="https://registry.npmjs.org/prowl-review/-/prowl-review-${version}.tgz"
curl -sL "$url" | shasum -a 256
```

Copy [`packaging/homebrew/prowl-review.rb`](../packaging/homebrew/prowl-review.rb)
to `Formula/prowl-review.rb` in `prowl-tools/homebrew-tap` (tap name: `prowl-tools/tap`),
set `TARBALL_VERSION` to the released version and `TARBALL_SHA256` to the hash above,
and open a PR on the tap. The template raises during install if either placeholder is
left in place.
Verify with:

```bash
brew install --build-from-source ./Formula/prowl-review.rb
brew test prowl-review
```

## Verify

```bash
set -euo pipefail
version=X.Y.Z
npm view "prowl-review@${version}" version  # the new version is live
npx "prowl-review@${version}" --version     # X.Y.Z
brew install prowl-tools/tap/prowl-review && prowl-review --version
```
