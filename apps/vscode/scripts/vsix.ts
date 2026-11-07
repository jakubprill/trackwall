import { z } from "zod";

/**
 * What goes into the extension's `.vsix` besides its files: the manifest VS Code installs from (`package.json` without
 * what only the repo needs), the package manifest and the content types of the OPC package VS Code reads. The
 * extension's id is `trackwall.trackwall`; inside the repo the package is `@trackwall/vscode`, a name VS Code would refuse.
 */

export const EXTENSION_NAME = "trackwall";

const SourceManifest = z
  .object({
    displayName: z.string(),
    description: z.string(),
    version: z.string(),
    publisher: z.string(),
    engines: z.object({ vscode: z.string() }),
    extensionKind: z.array(z.string()),
  })
  .loose();

/** The extension's `package.json` as VS Code reads it: its own name, and no scripts or development dependencies. */
export function extensionManifest(source: unknown): Record<string, unknown> {
  const manifest = SourceManifest.parse(source);
  const { scripts: _scripts, devDependencies: _dev, private: _private, ...rest } = manifest;
  return { ...rest, name: EXTENSION_NAME };
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function vsixManifest(manifest: Record<string, unknown>): string {
  const m = SourceManifest.parse(manifest);
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${EXTENSION_NAME}" Version="${xml(m.version)}" Publisher="${xml(m.publisher)}" />
    <DisplayName>${xml(m.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(m.description)}</Description>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(m.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${xml(m.extensionKind.join(","))}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

export const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".txt" ContentType="text/plain" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
`;
