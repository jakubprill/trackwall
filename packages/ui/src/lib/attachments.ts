import {
  ATTACHMENTS_MAX,
  ATTACHMENTS_MAX_BYTES,
  attachmentBytes,
  FILE_ATTACHMENT_MAX_CHARS,
  ImageMimeType,
  type MessageAttachment,
} from "@trackwall/protocol";

/**
 * Attachments of a message in the conversation view (ADR-107): an image the agent sees, or a text file whose text it
 * gets. What the message box can take, read from a file's bytes, and the limits the daemon checks again.
 */

/** A file as the message box gets it: from the file picker, a paste or a drop. */
export interface PickedFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** A file as an attachment, or why it cannot be one. */
export function attachmentOf(file: PickedFile): MessageAttachment | { problem: string } {
  const name = file.name.trim() === "" ? "pasted" : file.name.trim().slice(0, 200);
  const image = ImageMimeType.safeParse(file.type);
  if (image.success) return { kind: "image", name, mimeType: image.data, data: toBase64(file.bytes) };
  const text = textOf(file.bytes);
  if (text === undefined) return { problem: `${name}: only images (PNG, JPEG, GIF, WebP) and text files can be attached` };
  if (text.length > FILE_ATTACHMENT_MAX_CHARS) return { problem: `${name}: a text file can have at most 256 KiB` };
  return { kind: "file", name, text };
}

/** Why the attachments cannot go together, or `undefined` when they can. */
export function attachmentsProblem(attachments: readonly MessageAttachment[]): string | undefined {
  if (attachments.length > ATTACHMENTS_MAX) return `A message can have at most ${ATTACHMENTS_MAX} attachments`;
  const bytes = attachments.reduce((sum, a) => sum + attachmentBytes(a), 0);
  return bytes > ATTACHMENTS_MAX_BYTES ? "The attachments can have at most 10 MiB together" : undefined;
}

/** UTF-8 text without NUL characters, which a binary file has; `undefined` for anything else. */
function textOf(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
