# Distribution dependency policy

[Direct dependency inventory](dependencies.json) records each package's purpose, declared license options, the reason for reusing it and the module boundary that contains it. Keep pre-1.0 or rapidly changing libraries behind the recorded module boundary. The build also checks the separation of engine, rendering, native shell, and AI interfaces. Lockfiles pin the resolved versions, including transitive dependencies.

## Check a distribution candidate

From `radiant/`, run `bun run deps:audit --report /tmp/radiant-dependencies.json`. The report includes the resolved versions, licenses, application or build purpose, source, license decisions, lockfile hashes, native target and timestamp, and advisory matches. The audit covers the whole Bun lock, including development tools and platform artifacts, and the native dependency graph resolved for the Cargo target. It checks locked npm package identities and integrity strings against the published manifests. [Cargo metadata](https://doc.rust-lang.org/stable/cargo/commands/cargo-metadata.html) and the [OSV batch query](https://google.github.io/osv.dev/post-v1-querybatch/) provide the native dependency resolution and current advisory data.

The license policy accepts at least one permitted option in an SPDX `OR` expression and requires every term of an `AND` expression to be permitted. An undeclared, unapproved or newly declared direct license stops the check for review. The tracked allowlist covers the license families present in the build, including MPL-2.0. Distribution review tracks the notices and source obligations associated with the selected licenses. Cargo's older slash-delimited alternatives and the explicitly offered MIT alternative in `rgbcolor` 1.0.1 have documented normalization rules in the checker.

Use `bun run release` for an updater-enabled distribution build. It audits first, installs from the frozen Bun lock, then passes `--locked` to the native runner. Set `RADIANT_DEPENDENCY_REPORT` to retain the audit JSON. Advisory matches, service failures and invalid licensing metadata stop packaging. Normal development and local frontend builds make no registry or advisory request from this check.

## Verified locally

The original live audit reported 13 advisory matches. The dependency updates moved the frontend to SvelteKit 3.1.1 with its matching static adapter and Vitest 4.1.12. SvelteKit now resolves Cookie 2, and Vitest no longer pulls the affected Tinypool release. [SvelteKit advisory](https://github.com/sveltejs/kit/security/advisories/GHSA-3r8g-jcqq-3p5j) · [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8)

The current Apple Silicon distribution graph passed license review for all 259 npm and 352 Cargo releases. OSV reported one remaining match for Picomatch 4.0.7, required by Vite and Tinyglobby. The advisory lists no patched upstream version. The distribution gate still blocks packaging on that match. [Picomatch advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
