import { describe, expect, test } from "bun:test";
import { agentsApi } from "../src/agents.ts";
import {
  ATTACHMENTS_MAX,
  ATTACHMENTS_MAX_BYTES,
  FILE_ATTACHMENT_MAX_CHARS,
  MessageAttachments,
  SESSION_MESSAGE_BODY_MAX_BYTES,
  SESSION_MESSAGE_MAX,
} from "../src/conversation.ts";

describe("a message's attachments", () => {
  test("an image is base64 of an image type, and a file has a name without a folder", () => {
    expect(MessageAttachments.safeParse([{ kind: "image", name: "a.png", mimeType: "image/png", data: "iVBORw0K" }]).success).toBe(true);
    expect(MessageAttachments.safeParse([{ kind: "image", name: "a.svg", mimeType: "image/svg+xml", data: "PHN2Zz4=" }]).success).toBe(
      false,
    );
    expect(MessageAttachments.safeParse([{ kind: "image", name: "a.png", mimeType: "image/png", data: "not base64!" }]).success).toBe(
      false,
    );
    expect(MessageAttachments.safeParse([{ kind: "file", name: "../secrets.txt", text: "x" }]).success).toBe(false);
    expect(MessageAttachments.safeParse([{ kind: "file", name: "a\nb.txt", text: "x" }]).success).toBe(false);
  });

  test("at most five attachments of at most 10 MiB together", () => {
    const file = (text: string) => ({ kind: "file", name: "a.txt", text });
    expect(MessageAttachments.safeParse(Array.from({ length: 6 }, () => file("x"))).success).toBe(false);
    expect(MessageAttachments.safeParse(Array.from({ length: 5 }, () => file("x".repeat(200_000)))).success).toBe(true);
    const image = { kind: "image", name: "big.png", mimeType: "image/png", data: "A".repeat(8 * 1024 * 1024) };
    expect(MessageAttachments.safeParse([image, image]).success).toBe(false);
  });

  test("the largest message the schema takes, with control characters JSON writes in six bytes, fits the body limit", () => {
    const control = "\u0001";
    const files = Array.from({ length: ATTACHMENTS_MAX - 1 }, (_, i) => ({
      kind: "file",
      name: `${i}.log`,
      text: control.repeat(FILE_ATTACHMENT_MAX_CHARS),
    }));
    const imageBytes = ATTACHMENTS_MAX_BYTES - (ATTACHMENTS_MAX - 1) * FILE_ATTACHMENT_MAX_CHARS;
    const image = { kind: "image", name: "a.png", mimeType: "image/png", data: "A".repeat(Math.floor(imageBytes / 3) * 4) };
    const body = { session: crypto.randomUUID(), text: control.repeat(SESSION_MESSAGE_MAX), attachments: [image, ...files] };
    expect(agentsApi.say.request.safeParse(body).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(SESSION_MESSAGE_BODY_MAX_BYTES);
  });
});
