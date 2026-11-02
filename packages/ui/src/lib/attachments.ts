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

const MIB = 1024 * 1024;

/**
 * Why a file is too large to read, from its size alone, or `undefined`: so a huge file is refused before its bytes are
 * read into the page. A UTF-8 character has at most 4 bytes.
 */
export function sizeProblem(file: { name: string; type: string; size: number }): string | undefined {
  const name = attachmentName(file.name);
  if (ImageMimeType.safeParse(file.type).success)
    return file.size > ATTACHMENTS_MAX_BYTES ? `${name}: an image can have at most ${ATTACHMENTS_MAX_BYTES / MIB} MiB` : undefined;
  return file.size > FILE_ATTACHMENT_MAX_CHARS * 4 ? textTooLong(name) : undefined;
}

/** A file as an attachment, or why it cannot be one. */
export function attachmentOf(file: PickedFile): MessageAttachment | { problem: string } {
  const name = attachmentName(file.name);
  const image = ImageMimeType.safeParse(file.type);
  if (image.success) return { kind: "image", name, mimeType: image.data, data: toBase64(file.bytes) };
  const text = textOf(file.bytes);
  if (text === undefined) return { problem: `${name}: only images (PNG, JPEG, GIF, WebP) and text files can be attached` };
  if (text.length > FILE_ATTACHMENT_MAX_CHARS) return { problem: textTooLong(name) };
  return { kind: "file", name, text };
}

/** Why the attachments cannot go together, or `undefined` when they can. */
export function attachmentsProblem(attachments: readonly MessageAttachment[]): string | undefined {
  if (attachments.length > ATTACHMENTS_MAX) return `A message can have at most ${ATTACHMENTS_MAX} attachments`;
  const bytes = attachments.reduce((sum, a) => sum + attachmentBytes(a), 0);
  return bytes > ATTACHMENTS_MAX_BYTES ? `The attachments can have at most ${ATTACHMENTS_MAX_BYTES / MIB} MiB together` : undefined;
}

/**
 * A file's name as the daemon takes it: one line without a folder, so that a name Linux allows (with `\` or a new line)
 * does not get the whole message refused.
 */
export function attachmentName(name: string): string {
  const clean = name
    .replace(/[/\\\p{Cc}]/gu, "_")
    .trim()
    .slice(0, 200);
  return clean === "" ? "pasted" : clean;
}

function textTooLong(name: string): string {
  return `${name}: a text file can have at most ${FILE_ATTACHMENT_MAX_CHARS / 1024}K characters`;
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
