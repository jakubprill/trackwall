// Preloaded by the daemon's `pnpm test` (package.json), so that a new test on real git gets the long limit without
// asking for it and cannot time out on a busy Windows runner.
import { setDefaultTimeout } from "bun:test";
import { SLOW_TEST_TIMEOUT_MS } from "./test-timeouts.ts";

setDefaultTimeout(SLOW_TEST_TIMEOUT_MS);
