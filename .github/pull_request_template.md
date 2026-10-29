## What changes

<!-- For a Trackwall user: how it was, how it is. For an internal change: what and where. -->

## Why

## How

<!-- The key decisions in the code. A new architectural decision: the ADR number in docs/architecture.md §12. -->

## How it was checked

<!-- Commands from the Definition of done (AGENTS.md), tests added in this PR, what was run on Windows and macOS outside CI. -->

To check manually:

## Pre-PR review

<!-- Thermo-nuclear review (a second round only if the fixes changed logic), /security-review if the change touches a sensitive place. What was fixed, what was rejected and why. -->

## Definition of done

<!-- Full wording of the points: AGENTS.md, section "Definition of done". -->

- [ ] 1. Tests at every layer the change touches, named under "How it was checked" (bug fix: a test that fails without it): logic, daemon flow, a contract test for what the daemon relies on from Copilot CLI (`pnpm test:contract`), a case in the tests with real Java builds for what it reads from them (`pnpm test:jvm`), the E2E test of a key UI path (`pnpm test:e2e`)
- [ ] 2. System-dependent code has a test that CI runs on Windows and macOS (every night, or a linked manual run with that system ticked for Windows- or macOS-specific code, AGENTS.md); the rest listed above as "to check manually"
- [ ] 3. The commands from AGENTS.md pass locally
- [ ] 4. Documentation updated in this PR
- [ ] 5. Nothing company-specific
- [ ] 6. Pre-PR review done (AGENTS.md, section "Pre-PR review"), findings fixed or rejected above
