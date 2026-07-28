# Releasing prowl-review

prowl-review publishes to **npm** via a tag-triggered workflow, and is also
available through **Homebrew**. This is the maintainer release checklist (#42).

## Prerequisites (one-time)

- Until backlog #63 removes token auth, an npm **granular access token** with publish
  rights to `prowl-review`, stored as the `NPM_TOKEN` repository secret (Settings →
  Secrets and variables → Actions). The token belongs to the npm account that owns
  the `prowl-review` package; the current token **expires 2026-10-12**. To rotate as
  a temporary fallback: create a granular access token scoped to package publishing
  for `prowl-review`, enable 2FA bypass for noninteractive CI publishing while npm
  still permits direct token publishing, set the shortest practical expiry, replace
  the repository secret, and verify with the next tag-triggered publish. Treat direct
  token publishing and 2FA bypass as an interim risk accepted only until #63 lands;
  do not create or document legacy/classic automation tokens. Migrating to **npm
  Trusted Publishing** (OIDC, no stored token) is the preferred replacement before
  expiry — tracked as backlog #63.
- Publish access to the [`prowl-tools/homebrew-tap`](https://github.com/prowl-tools/homebrew-tap) repo.

## Trusted Publishing migration (#63)

Before removing `NPM_TOKEN`, update `.github/workflows/publish.yml` to run a
Trusted Publishing-compatible toolchain: Node >=22.14.0 and npm >=11.5.1 (prefer
the current stable Node line from npm's GitHub Actions example). Then configure
the `prowl-review` package on npmjs.com with this repository and `publish.yml` as
the GitHub Actions trusted publisher, keep `id-token: write`, remove
`NODE_AUTH_TOKEN` and every `secrets.NPM_TOKEN` reference from
`.github/workflows/publish.yml`, and verify the next tag-triggered release publishes
through OIDC before deleting the npm token and repository secret.

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
   public`, and publishes the GitHub Release after npm succeeds.
   - The version guard fails the run if the tag and `package.json` disagree, so a
     mismatched tag never publishes.
5. **Advance the Action's floating `v1` tag** to the release commit, so
   `uses: prowl-tools/prowl-code-review@v1` workflows get the new release:
   ```bash
   git tag -f v1 vX.Y.Z
   git push origin v1 --force
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
npm view prowl-review version          # the new version is live
npx prowl-review@latest --version      # X.Y.Z
brew install prowl-tools/tap/prowl-review && prowl-review --version
```
