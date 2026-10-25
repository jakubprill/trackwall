import { describe, expect, test } from "bun:test";
import { pastedPaths } from "../src/lib/pasted-paths.ts";

describe("pasted paths", () => {
  test("dropped paths are pasted separated by spaces with one after them, quoted when they have a space or a quote", () => {
    expect(pastedPaths(["/Users/me/Projects/shop/README.md"])).toBe("/Users/me/Projects/shop/README.md ");
    expect(pastedPaths(["C:\\Users\\me\\My Projects\\a.txt", "C:\\b.txt"])).toBe('"C:\\Users\\me\\My Projects\\a.txt" C:\\b.txt ');
    expect(pastedPaths(['/tmp/say "hi".txt', "/tmp/it's.txt"])).toBe('"/tmp/say \\"hi\\".txt" "/tmp/it\'s.txt" ');
  });
});
