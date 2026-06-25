# Releasing prowl-review

prowl-review publishes to **npm** via a tag-triggered workflow, and is also
available through **Homebrew**. This is the maintainer release checklist (#42).

## Prerequisites (one-time)

- An npm **automation token** with publish rights to `prowl-review`, stored as the
  `NPM_TOKEN` repository secret (Settings → Secrets and variables → Actions).
- Publish access to the [`Prowl-qa/homebrew-tap`](https://github.com/Prowl-qa/homebrew-tap) repo.

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
4. The **`publish` workflow** runs automatically: it verifies the tag matches
   `package.json`, builds + lints + tests, runs `npm publish --provenance --access
   public`, and creates a GitHub Release from the matching CHANGELOG section.
   - The version guard fails the run if the tag and `package.json` disagree, so a
     mismatched tag never publishes.

## Update the Homebrew tap

After the npm tarball is live:

```bash
version=X.Y.Z
url="https://registry.npmjs.org/prowl-review/-/prowl-review-${version}.tgz"
curl -sL "$url" | shasum -a 256
```

Copy [`packaging/homebrew/prowl-review.rb`](../packaging/homebrew/prowl-review.rb)
to `Formula/prowl-review.rb` in `Prowl-qa/homebrew-tap`, set `url` to the tarball
URL and `sha256` to the hash above, and open a PR on the tap. Verify with:

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
