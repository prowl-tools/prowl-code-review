# Homebrew formula template for prowl-review (#42).
#
# This file lives here as the canonical source; copy it to
# `Formula/prowl-review.rb` in the Prowl-qa/homebrew-tap repo (tap name:
# `Prowl-qa/tap`) on each release, then set `TARBALL_VERSION` and
# `TARBALL_SHA256` below for the just-published npm tarball:
#
#   version=0.1.0
#   url="https://registry.npmjs.org/prowl-review/-/prowl-review-${version}.tgz"
#   curl -sL "$url" | shasum -a 256
#
# See docs/releasing.md for the full flow.
TARBALL_VERSION = "0.0.0"
TARBALL_SHA256 = "REPLACE_WITH_TARBALL_SHA256"
TARBALL_URL = "https://registry.npmjs.org/prowl-review/-/prowl-review-#{TARBALL_VERSION}.tgz"

class ProwlReview < Formula
  desc "BYOK AI code review for pull requests (Claude/OpenAI/Gemini)"
  homepage "https://prowl.tools"
  url TARBALL_URL
  version TARBALL_VERSION
  sha256 TARBALL_SHA256
  license "Apache-2.0"

  depends_on "node@20"

  def install
    if TARBALL_VERSION == "0.0.0" || TARBALL_SHA256 == "REPLACE_WITH_TARBALL_SHA256"
      raise "Set TARBALL_VERSION and TARBALL_SHA256 before publishing this Homebrew formula."
    end

    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/prowl-review --version")
  end
end
