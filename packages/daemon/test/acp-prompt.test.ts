import { describe, expect, test } from "bun:test";
import { checkAttachments, promptBlocks } from "../src/modules/agents/acp-prompt.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString("base64");

describe("a message as an ACP prompt", () => {
  test("the text comes first, an image is an image block and a text file a text block that names it", () => {
    expect(
      promptBlocks("What is wrong here?", [
        { kind: "image", name: "screen.png", mimeType: "image/png", data: PNG },
        { kind: "file", name: "build.log", text: "ERROR: tests failed" },
      ]),
    ).toEqual([
      { type: "text", text: "What is wrong here?" },
      { type: "image", mimeType: "image/png", data: PNG },
      { type: "text", text: '<attached-file name="build.log">\nERROR: tests failed\n</attached-file>' },
    ]);
  });

  test("a message without attachments is one text block", () => {
    expect(promptBlocks("Hello", [])).toEqual([{ type: "text", text: "Hello" }]);
  });
});

describe("the attachments the daemon lets through", () => {
  test("an image whose bytes are of its type and a text file go through", () => {
    expect(() =>
      checkAttachments(
        [
          { kind: "image", name: "a.png", mimeType: "image/png", data: PNG },
          { kind: "image", name: "b.jpg", mimeType: "image/jpeg", data: JPEG },
          { kind: "file", name: "c.txt", text: "x" },
        ],
        true,
      ),
    ).not.toThrow();
  });

  test("an image whose bytes are of another type is refused", () => {
    expect(() => checkAttachments([{ kind: "image", name: "a.png", mimeType: "image/png", data: JPEG }], true)).toThrow(
      "a.png is not an image of type image/png",
    );
  });

  test("an agent that takes no images gets none, but text files still go", () => {
    expect(() => checkAttachments([{ kind: "image", name: "a.png", mimeType: "image/png", data: PNG }], false)).toThrow(
      "the agent takes no images",
    );
    expect(() => checkAttachments([{ kind: "file", name: "c.txt", text: "x" }], false)).not.toThrow();
  });

  test("an image sent while the session starts, before the agent says whether it takes images, is refused as too early", () => {
    expect(() => checkAttachments([{ kind: "image", name: "a.png", mimeType: "image/png", data: PNG }], undefined)).toThrow(
      "the session is still starting",
    );
    expect(() => checkAttachments([{ kind: "file", name: "c.txt", text: "x" }], undefined)).not.toThrow();
  });
});
