import { join } from "node:path";

/** The built UI the E2E tests serve (ADR-71); `pnpm test:e2e` in the repo root builds it first. */
export const UI_DIR = join(import.meta.dir, "..", "..", "..", "ui", "dist");
