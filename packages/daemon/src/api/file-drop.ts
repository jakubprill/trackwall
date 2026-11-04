import type { IncomingMessage } from "node:http";
import { DROP_NAME_HEADER, DroppedFileName, MAX_DROP_BYTES } from "@trackwall/protocol";
import { z } from "zod";
import { DomainError } from "../infra/errors.ts";

/**
 * `POST /api/terminals/drop` (ADR-196, §5.2): a file dropped on a terminal from another computer, as its bytes, with its
 * name percent-encoded in `DROP_NAME_HEADER`. The name is checked and a declared length over the limit refused before
 * any of the body is read; the body itself streams to `droppedFiles`, which stops at the limit too.
 */

/** The dropped file's name from its header, or `bad_request` for none, a bad encoding, or a name that is no single name. */
export function droppedName(req: Pick<IncomingMessage, "headers">): string {
  const raw = req.headers[DROP_NAME_HEADER];
  if (typeof raw !== "string") throw new DomainError("bad_request", `the dropped file's name is missing (${DROP_NAME_HEADER})`);
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    throw new DomainError("bad_request", `${DROP_NAME_HEADER} is not percent-encoded UTF-8`);
  }
  const parsed = DroppedFileName.safeParse(name);
  if (!parsed.success) throw new DomainError("bad_request", z.prettifyError(parsed.error));
  const length = Number(req.headers["content-length"] ?? 0);
  if (length > MAX_DROP_BYTES)
    throw new DomainError(
      "bad_request",
      `the file is larger than ${MAX_DROP_BYTES / 1024 ** 2} MB; copy it into the container with docker cp instead`,
    );
  return parsed.data;
}
