/**
 * Packs the built extension (`scripts/build.ts`) into `out/trackwall-<version>.vsix`, which VS Code installs with
 * "Extensions: Install from VSIX…" or `code --install-extension <file>`.
 *
 *   bun apps/vscode/scripts/package.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTENT_TYPES, EXTENSION_NAME, extensionManifest, vsixManifest } from "./vsix.ts";
import { zip } from "./zip.ts";

const root = join(import.meta.dir, "..");
const bundle = join(root, "dist", "extension.js");
if (!existsSync(bundle)) throw new Error(`no ${bundle}: run "bun apps/vscode/scripts/build.ts" first`);

const manifest = extensionManifest(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
const file = (path: string) => readFileSync(join(root, path));
const vsix = zip([
  { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES) },
  { name: "extension.vsixmanifest", data: Buffer.from(vsixManifest(manifest)) },
  { name: "extension/package.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
  { name: "extension/README.md", data: file("README.md") },
  { name: "extension/LICENSE.txt", data: readFileSync(join(root, "..", "..", "LICENSE")) },
  { name: "extension/media/trackwall.svg", data: file("media/trackwall.svg") },
  { name: "extension/dist/extension.js", data: file("dist/extension.js") },
]);
const out = join(root, "out");
mkdirSync(out, { recursive: true });
const target = join(out, `${EXTENSION_NAME}-${String(manifest.version)}.vsix`);
writeFileSync(target, vsix);
console.log(target);
