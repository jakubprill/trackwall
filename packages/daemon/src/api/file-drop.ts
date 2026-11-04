import type { IncomingMessage } from "node:http";
import { DROP_NAME_HEADER, dropTooLarge, MAX_DROP_BYTES } from "@trackwall/protocol";
import { DomainError } from "../infra/errors.ts";

/**
 * `POST /api/terminals/drop` (ADR-201, §5.2): a file dropped on a terminal from another computer, as its bytes, with its
 * name percent-encoded in `DROP_NAME_HEADER`. The name and the declared length are checked before any of the body is
 * read; the body itself streams to `droppedFiles`, which stops at the limit too.
 */

/** The dropped file's name from its header, as sent; `droppedFiles` makes it safe. `bad_request` for none or a bad encoding. */
export function droppedName(req: Pick<IncomingMessage, "headers">): string {
  const raw = req.headers[DROP_NAME_HEADER];
  if (typeof raw !== "string" || raw === "")
    throw new DomainError("bad_request", `the dropped file's name is missing (${DROP_NAME_HEADER})`);
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new DomainError("bad_request", `${DROP_NAME_HEADER} is not percent-encoded UTF-8`);
  }
}

/** Refuses a body that says it is over the limit before any of it is read; one that does not say is cut off while saved. */
export function refuseOversized(req: Pick<IncomingMessage, "headers">, name: string): void {
  if (Number(req.headers["content-length"]) > MAX_DROP_BYTES) throw new DomainError("bad_request", dropTooLarge(name));
}

/**
 * The body as it comes, so that a refusal or a failure leaves `req` open for the answer (a `pipeline` would destroy it);
 * a client that went away mid-upload is the client's doing, not a daemon error.
 */
export async function* droppedBody(req: IncomingMessage): AsyncGenerator<Buffer> {
  try {
    for await (const chunk of req) yield chunk;
  } catch (err) {
    if (!req.complete) throw new DomainError("bad_request", "the upload was cut off before the whole file came");
    throw err;
  }
  if (!req.complete) throw new DomainError("bad_request", "the upload was cut off before the whole file came");
}
