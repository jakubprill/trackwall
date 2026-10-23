import { describe, expect, test } from "bun:test";
import { DaemonFile, HealthResult } from "../src/index.ts";

describe("protocol", () => {
  test("DaemonFile odrzuca krótki token", () => {
    const r = DaemonFile.safeParse({ pid: 1, port: 4000, token: "abc", startedAt: "x", version: "0.1.0" });
    expect(r.success).toBe(false);
  });

  test("HealthResult rozróżnia sukces i błąd po polu ok", () => {
    expect(HealthResult.parse({ ok: true, data: { status: "ok", version: "0.1.0" } }).ok).toBe(true);
    const err = HealthResult.parse({ ok: false, error: { code: "internal", message: "x" } });
    expect(err.ok).toBe(false);
  });
});
