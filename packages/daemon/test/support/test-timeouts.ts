/**
 * The time limit for a test that starts dozens of real git processes or writes thousands of files: on a busy Windows
 * runner, where every process start and file write is slow, such a test takes longer than bun's default 5 s.
 */
export const SLOW_TEST_TIMEOUT_MS = 30_000;
