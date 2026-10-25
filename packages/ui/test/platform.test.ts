import { describe, expect, test } from "bun:test";
import { systemOf } from "../src/lib/platform.ts";

describe("platform", () => {
  test("the system comes from the user agent: Windows for WebView2, mac for WKWebView, other for the rest", () => {
    expect(systemOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0")).toBe("windows");
    expect(systemOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("mac");
    expect(systemOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("other");
  });
});
