import type { AttachmentLabel, ImageMimeType, MessageAttachment } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";

/**
 * A message as the prompt of `session/prompt` (ADR-107): its text, then each attachment. An image goes as ACP's image
 * block, which Copilot CLI gives the model as an image (`contract/acp-session.contract.ts`); a text file goes as a text
 * block with its name, since Copilot CLI saves an ACP resource block to a temporary file and gives the model only that
 * file's path, which the agent would have to read and may need an approval for. The file's text sits between a line
 * that names it and a closing line, so the model can tell where it ends; that is framing, not a guard, since the text could hold such a line
 * itself, and the user chose the file.
 */

export type PromptBlock = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

export function promptBlocks(text: string, attachments: readonly MessageAttachment[]): PromptBlock[] {
  return [{ type: "text", text }, ...attachments.map(attachmentBlock)];
}

/** An attachment as the conversation shows it. */
export function attachmentLabel({ kind, name }: MessageAttachment): AttachmentLabel {
  return { kind, name };
}

function attachmentBlock(attachment: MessageAttachment): PromptBlock {
  if (attachment.kind === "image") return { type: "image", mimeType: attachment.mimeType, data: attachment.data };
  const name = JSON.stringify(attachment.name);
  return { type: "text", text: `<attached-file name=${name}>\n${attachment.text}\n</attached-file>` };
}

/** The first bytes of each image type, so an image is what its type says before it reaches the model. */
const IMAGE_SIGNATURES: Record<ImageMimeType, (bytes: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  "image/gif": (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

/**
 * Refuses an image whose bytes are not of its type, and images when the agent takes none or has not said yet (`undefined`,
 * while the session starts).
 */
export function checkAttachments(attachments: readonly MessageAttachment[], agentTakesImages: boolean | undefined): void {
  for (const attachment of attachments) {
    if (attachment.kind !== "image") continue;
    if (agentTakesImages === undefined)
      throw new DomainError("bad_request", "the session is still starting; attach the image once it is ready");
    if (!agentTakesImages) throw new DomainError("bad_request", "the agent takes no images");
    const head = Buffer.from(attachment.data.slice(0, 16), "base64");
    if (!IMAGE_SIGNATURES[attachment.mimeType](head)) {
      throw new DomainError("bad_request", `${attachment.name} is not an image of type ${attachment.mimeType}`);
    }
  }
}
