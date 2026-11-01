import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * Checks a minisign signature as Tauri's signer writes it (ADR-53, ADR-165): the public key and the `.sig` file are each
 * base64 of a minisign text file. The signature is Ed25519 over the BLAKE2b-512 hash of the file ("ED") or over the file
 * itself ("Ed"), and a second, global signature covers the signature and its trusted comment, so the comment (the file
 * name and version Tauri writes there) cannot be swapped either. Any doubt is an exception: the caller installs nothing.
 */

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TRUSTED_PREFIX = "trusted comment: ";

function decodeLines(base64File: string, what: string): string[] {
  const text = Buffer.from(base64File.trim(), "base64").toString("utf8");
  const lines = text.split("\n");
  if (!lines[0]?.startsWith("untrusted comment:")) throw new Error(`the ${what} is not in minisign format`);
  return lines;
}

function decodeKey(pubkey: string): { id: Buffer; key: ReturnType<typeof createPublicKey> } {
  const bytes = Buffer.from(decodeLines(pubkey, "public key")[1] ?? "", "base64");
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString("latin1") !== "Ed")
    throw new Error("the public key is not an Ed25519 minisign key");
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes.subarray(10)]), format: "der", type: "spki" });
  return { id: bytes.subarray(2, 10), key };
}

/** Verifies `data` against `signature` with `pubkey` and returns the signature's trusted comment. */
export function verifyMinisign(o: { pubkey: string; signature: string; data: Buffer }): string {
  const { id, key } = decodeKey(o.pubkey);
  const lines = decodeLines(o.signature, "signature");
  const sig = Buffer.from(lines[1] ?? "", "base64");
  const trusted = lines[2] ?? "";
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (sig.length !== 74 || !trusted.startsWith(TRUSTED_PREFIX) || global.length !== 64) {
    throw new Error("the signature is not in minisign format");
  }
  if (!sig.subarray(2, 10).equals(id)) throw new Error("the signature was made with another key");
  const algorithm = sig.subarray(0, 2).toString("latin1");
  if (algorithm !== "ED" && algorithm !== "Ed") throw new Error(`unknown signature algorithm ${JSON.stringify(algorithm)}`);
  const signed = algorithm === "ED" ? createHash("blake2b512").update(o.data).digest() : o.data;
  if (!verify(null, signed, key, sig.subarray(10))) throw new Error("the signature does not match the file");
  const comment = trusted.slice(TRUSTED_PREFIX.length);
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(comment, "utf8")]), key, global)) {
    throw new Error("the trusted comment does not match the signature");
  }
  return comment;
}

/** The `key:value` fields Tauri's signer writes into the trusted comment, separated by tabs (`file`, `version`, `timestamp`). */
export function trustedFields(comment: string): Record<string, string> {
  return Object.fromEntries(
    comment.split("\t").flatMap((field) => {
      const colon = field.indexOf(":");
      return colon > 0 ? [[field.slice(0, colon), field.slice(colon + 1)]] : [];
    }),
  );
}
