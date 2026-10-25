/**
 * Update manifest of a release (ADR-53): `latest.json`, which the app's updater reads from
 * `releases/latest/download/latest.json`, with the address and signature of the update package for each system.
 *
 *   bun apps/desktop/scripts/update-manifest.ts <folder with the release files> <tag> <owner/repo>
 *
 * The release workflow runs it after both builds. It refuses a signature made with another key than the one in
 * `tauri.conf.json`, which installed copies would refuse only after the release is out.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseFile, TAURI_DIR } from "./lib.ts";

/**
 * The update package of each system, under the updater's target name (`{os}-{arch}`). On Windows it is the release zip
 * itself; `scripts/package-portable.ts` makes both.
 */
export const UPDATE_PACKAGES = {
  "windows-x86_64": (version: string) => `trackwall-${version}-windows-x64.zip`,
  "darwin-aarch64": (version: string) => `trackwall-${version}-macos-arm64.app.tar.gz`,
} as const;
type Target = keyof typeof UPDATE_PACKAGES;
const TARGETS = Object.keys(UPDATE_PACKAGES) as Target[];

/** `tauri signer sign` writes the signature next to the file. */
const signatureFile = (file: string) => `${file}.sig`;
/** The name the updater's endpoint in `tauri.conf.json` asks for. */
export const MANIFEST_FILE = "latest.json";

export interface ManifestInput {
  tag: string;
  repo: string;
  pubkey: string;
  /** Contents of the `.sig` file of each update package. */
  signatures: Record<Target, string>;
  date: Date;
}

export function updateManifest({ tag, repo, pubkey, signatures, date }: ManifestInput) {
  const version = tag.replace(/^v/, "");
  const expectedKey = keyId(pubkey, "public key");
  const platforms = Object.fromEntries(
    TARGETS.map((target) => {
      const file = UPDATE_PACKAGES[target](version);
      const signature = signatures[target].trim();
      const signedWith = keyId(signature, `signature of ${file}`);
      if (signedWith !== expectedKey) {
        throw new Error(`${file} is signed with key ${signedWith}, but tauri.conf.json has key ${expectedKey} (docs/release.md)`);
      }
      return [target, { url: `https://github.com/${repo}/releases/download/${tag}/${file}`, signature }];
    }),
  );
  return { version, pub_date: date.toISOString(), platforms };
}

/**
 * Key id of a minisign public key or signature, as Tauri stores them: base64 of the minisign text file, whose second
 * line is base64 of two algorithm bytes, the 8-byte key id and the key or signature.
 */
export function keyId(base64File: string, what: string): string {
  const line = Buffer.from(base64File, "base64").toString("utf8").split("\n")[1];
  const bytes = Buffer.from(line ?? "", "base64");
  if (bytes.length < 10) throw new Error(`the ${what} is not in minisign format`);
  return bytes.subarray(2, 10).toString("hex").toUpperCase();
}

const TauriConf = z.object({ plugins: z.object({ updater: z.object({ pubkey: z.string() }) }) });

function main([dist, tag, repo]: string[]) {
  if (!dist || !tag || !repo) throw new Error("usage: bun scripts/update-manifest.ts <dist> <tag> <owner/repo>");
  const version = tag.replace(/^v/, "");
  const signatures = Object.fromEntries(
    TARGETS.map((target) => [target, readFileSync(join(dist, signatureFile(UPDATE_PACKAGES[target](version))), "utf8")]),
  ) as Record<Target, string>;
  const { pubkey } = parseFile(join(TAURI_DIR, "tauri.conf.json"), TauriConf, JSON.parse).plugins.updater;
  const manifest = updateManifest({ tag, repo, pubkey, signatures, date: new Date() });
  writeFileSync(join(dist, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}

if (import.meta.main) main(process.argv.slice(2));
