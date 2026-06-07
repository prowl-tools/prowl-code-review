/**
 * prowl-review — programmatic (library) surface.
 *
 * The review engine (providers, github integration, review pipeline) will be
 * exported here as those modules land, so the same core can back the CLI, the
 * GitHub Action, and a future hosted app. For now this is an intentional
 * placeholder kept self-contained (no `package.json` import) so the type
 * declarations stay clean.
 */
export const PACKAGE_NAME = "prowl-review";
