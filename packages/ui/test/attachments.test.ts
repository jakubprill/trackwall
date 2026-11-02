import { describe, expect, test } from "bun:test";
import { attachmentName, attachmentOf, attachmentsProblem, sizeProblem } from "../src/lib/attachments.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("a file as an attachment", () => {
  test("an image is its bytes in base64 with its type, a pasted one without a name is named pasted", () => {
    expect(attachmentOf({ name: "", type: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })).toEqual({
      kind: "image",
      name: "pasted",
      mimeType: "image/png",
      data: "iVBORw==",
    });
  });

  test("a text file is its text, whatever its type says", () => {
    expect(attachmentOf({ name: "build.log", type: "", bytes: bytes("ERROR: tests failed\n") })).toEqual({
      kind: "file",
      name: "build.log",
      text: "ERROR: tests failed\n",
    });
  });

  test("a binary file and a text file over 256K characters are refused with the reason", () => {
    expect(attachmentOf({ name: "app.exe", type: "application/octet-stream", bytes: new Uint8Array([0x4d, 0x5a, 0, 0xff]) })).toEqual({
      problem: "app.exe: only images (PNG, JPEG, GIF, WebP) and text files can be attached",
    });
    expect(attachmentOf({ name: "big.txt", type: "text/plain", bytes: bytes("x".repeat(256 * 1024 + 1)) })).toEqual({
      problem: "big.txt: a text file can have at most 256K characters",
    });
  });

  test("more than five attachments, or more than 10 MiB of them, cannot go together", () => {
    const file = { kind: "file" as const, name: "a.txt", text: "x" };
    expect(attachmentsProblem(Array.from({ length: 5 }, () => file))).toBeUndefined();
    expect(attachmentsProblem(Array.from({ length: 6 }, () => file))).toBe("A message can have at most 5 attachments");
    const image = { kind: "image" as const, name: "a.png", mimeType: "image/png" as const, data: "A".repeat(14 * 1024 * 1024) };
    expect(attachmentsProblem([image])).toBe("The attachments can have at most 10 MiB together");
  });

  test("a name with a folder or a control character is one line without a folder, as the daemon takes it", () => {
    expect(attachmentName("a\\b/c\nd.txt")).toBe("a_b_c_d.txt");
    expect(attachmentName("  ")).toBe("pasted");
  });

  test("a file too large to attach is refused by its size, before its bytes are read", () => {
    expect(sizeProblem({ name: "huge.png", type: "image/png", size: 11 * 1024 * 1024 })).toBe("huge.png: an image can have at most 10 MiB");
    expect(sizeProblem({ name: "small.png", type: "image/png", size: 1024 })).toBeUndefined();
    expect(sizeProblem({ name: "huge.iso", type: "", size: 2 * 1024 * 1024 * 1024 })).toBe(
      "huge.iso: a text file can have at most 256K characters",
    );
    expect(sizeProblem({ name: "notes.txt", type: "text/plain", size: 1024 * 1024 })).toBeUndefined();
  });
});
