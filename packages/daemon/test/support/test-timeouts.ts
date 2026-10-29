/**
 * The time limit for every daemon test and hook. Most of them start real git processes (a daemon with its repos, the
 * local config store) or write thousands of files, and on a busy Windows runner, where every process start and file
 * write is slow, they take longer than bun's default 5 s. `pnpm test` passes it as `--timeout` (package.json; a test
 * keeps the two equal), because `setDefaultTimeout` in a preloaded file holds only for the first test file bun runs. A
 * test that needs more passes its own limit.
 */
export const SLOW_TEST_TIMEOUT_MS = 30_000;
