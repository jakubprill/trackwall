/**
 * The time limit for a test or a `beforeAll` hook that starts dozens of real git processes (a daemon with its repos)
 * or writes thousands of files: on a busy Windows runner, where every process start and file write is slow, it takes
 * longer than bun's default 5 s.
 */
export const SLOW_TEST_TIMEOUT_MS = 30_000;
