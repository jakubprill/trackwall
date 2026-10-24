import { describe, expect, test } from "bun:test";
import { fileManagerName } from "../src/lib/platform.ts";

describe("platform", () => {
  test("the folder app is Explorer on Windows, Finder on macOS and the file manager elsewhere", () => {
    expect(fileManagerName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0")).toBe("Explorer");
    expect(fileManagerName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("Finder");
    expect(fileManagerName("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("the file manager");
  });
});
