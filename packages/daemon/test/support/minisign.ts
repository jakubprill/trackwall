import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/**
 * A throwaway minisign key that signs the way Tauri's signer does (prehashed "ED", a trusted comment with the file and
 * version), for tests of the container update (ADR-165). The format itself is checked against a real Tauri signature in
 * `test/fixtures/minisign/`.
 */
export function minisignKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  const pubkey = Buffer.from(
    `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`,
  ).toString("base64");
  const signFile = (data: Buffer, fields: { file: string; version: string }) => {
    const sig = sign(null, createHash("blake2b512").update(data).digest(), privateKey);
    const comment = `timestamp:1800000000\tfile:${fields.file}\tversion:${fields.version}`;
    const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
    const text = [
      "untrusted comment: signature from a test key",
      Buffer.concat([Buffer.from("ED"), id, sig]).toString("base64"),
      `trusted comment: ${comment}`,
      global.toString("base64"),
      "",
    ].join("\n");
    return Buffer.from(text).toString("base64");
  };
  return { pubkey, signFile };
}
