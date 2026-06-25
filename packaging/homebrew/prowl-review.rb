# Homebrew formula template for prowl-review (#42).
#
# This file lives here as the canonical source; copy it to
# `Formula/prowl-review.rb` in the Prowl-qa/homebrew-tap repo on each release and
# fill in `url` + `sha256` for the just-published npm tarball:
#
#   version=0.1.0
#   url="https://registry.npmjs.org/prowl-review/-/prowl-review-${version}.tgz"
#   curl -sL "$url" | shasum -a 256
#
# See docs/releasing.md for the full flow.
class ProwlReview < Formula
  desc "BYOK AI code review for pull requests (Claude/OpenAI/Gemini)"
  homepage "https://prowl.tools"
  url "https://registry.npmjs.org/prowl-review/-/prowl-review-0.1.0.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256"
  license "Apache-2.0"

  depends_on "node@20"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/prowl-review --version")
  end
end
