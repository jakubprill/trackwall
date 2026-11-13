import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { EXTENSION_NAME, extensionManifest, vsixManifest } from "../scripts/vsix.ts";
import { zip } from "../scripts/zip.ts";

const source: unknown = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
const release = readFileSync(join(import.meta.dir, "..", "..", "..", ".github", "workflows", "release.yml"), "utf8");

describe("the .vsix", () => {
  test("carries the extension's manifest under the name VS Code takes, without what only the repo needs", () => {
    const manifest = extensionManifest(source);
    expect(manifest.name).toBe(EXTENSION_NAME);
    expect(manifest).not.toHaveProperty("scripts");
    expect(manifest).not.toHaveProperty("devDependencies");
    expect(manifest).not.toHaveProperty("private");
    expect(manifest).toMatchObject({ publisher: "trackwall", main: "./dist/extension.js", extensionKind: ["workspace"] });
  });

  test("names the extension, its version, engine and kind in the package manifest", () => {
    const xml = vsixManifest({ ...extensionManifest(source), version: "1.2.3" });
    expect(xml).toContain(`<Identity Language="en-US" Id="trackwall" Version="1.2.3" Publisher="trackwall" />`);
    expect(xml).toContain(`<Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.100.0" />`);
    expect(xml).toContain(`<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />`);
    expect(xml).toContain("<Categories>Other</Categories>");
  });

  test("is a zip whose entries hold the files as given, with UTF-8 names", () => {
    const archive = zip([
      { name: "extension/package.json", data: Buffer.from('{"name":"trackwall"}') },
      { name: "extension/zażółć.md", data: Buffer.from("") },
    ]);
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    const nameLength = archive.readUInt16LE(26);
    const packedLength = archive.readUInt32LE(18);
    expect(archive.subarray(30, 30 + nameLength).toString("utf8")).toBe("extension/package.json");
    expect(inflateRawSync(archive.subarray(30 + nameLength, 30 + nameLength + packedLength)).toString("utf8")).toBe('{"name":"trackwall"}');
    const end = archive.subarray(archive.length - 22);
    expect(end.readUInt32LE(0)).toBe(0x06054b50);
    expect(end.readUInt16LE(10)).toBe(2);
    expect(archive.includes(Buffer.from("extension/zażółć.md", "utf8"))).toBe(true);
  });

  test("release.yml packs it with the tag's version, checks its name and publishes it with its checksum", () => {
    expect(release).toContain("pnpm --filter @trackwall/vscode package");
    expect(release).toContain('vsix="trackwall-$version.vsix"');
    expect(release).toContain('expected=("$win" "$mac" "$mac_update" "$linux_x64" "$linux_arm64" "$vsix"');
    expect(release).toMatch(/sha256sum [^\n]*"\$vsix"/);
  });
});
