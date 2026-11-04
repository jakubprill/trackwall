import { expect, test } from "bun:test";
import { DroppedFileName } from "../src/terminals.ts";

test("a dropped file's name is one name every system can keep", () => {
  for (const name of ["screenshot 2026-11-04.png", "dump.sql.gz", "Zażółć.txt", ".env.local"])
    expect({ name, ok: DroppedFileName.safeParse(name).success }).toEqual({ name, ok: true });
  for (const name of [
    "",
    ".",
    "..",
    "../etc/passwd",
    "a/b",
    "a\\b",
    "C:x",
    "a\u0000b",
    "line\nbreak",
    "trailing.",
    "trailing ",
    "x".repeat(256),
    "what?",
  ])
    expect({ name, ok: DroppedFileName.safeParse(name).success }).toEqual({ name, ok: false });
});
