## What changes

<!-- For a Trackwall user: how it was, how it is. For an internal change: what and where. -->

## Why

## How

<!-- The key decisions in the code. A new architectural decision: the ADR number in docs/architecture.md §12. -->

## How it was checked

<!-- Commands from the Definition of done (AGENTS.md), tests added in this PR, what was run on Windows and macOS outside CI. -->

To check manually:

## Pre-PR review

<!-- Rounds: thermo-nuclear, /code-review, mattpocock-skills:code-review. What was fixed, what was rejected and why. -->

## Definition of done

<!-- Full wording of the points: AGENTS.md, section "Definition of done". -->

- [ ] 1. A test at the cheapest level (bug fix: a test that fails without it); what the daemon relies on from Copilot CLI has a contract test (`pnpm test:contract`)
- [ ] 2. System-dependent code has a test in the Windows + macOS matrix (CI on the PR, `CI ok` check); the rest listed above as "to check manually"
- [ ] 3. The commands from AGENTS.md pass locally
- [ ] 4. Documentation updated in this PR
- [ ] 5. Nothing company-specific
- [ ] 6. Pre-PR review until a clean round or three rounds, with what is left described above
