/**
 * The Trackwall Dev Container Feature (ADR-164): its file name in a release and how the release's values go into its
 * two files (`package-feature.ts` packs them).
 */
import type { LinuxArch } from "./linux-archive.ts";

/** The Dev Containers specification takes a release file as a Feature only under this name. */
export const FEATURE_ARCHIVE = "devcontainer-feature-trackwall.tgz";

export interface FeatureValues {
  version: string;
  releaseUrl: string;
  docsUrl: string;
  /** Empty for an architecture the Feature is packed without. */
  sha256: Record<LinuxArch, string>;
}

/** The two files with every `@NAME@` filled in; a placeholder left over or a value outside its form throws. */
export function featureFiles(files: { json: string; install: string }, v: FeatureValues): { json: string; install: string } {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v.version)) throw new Error(`unexpected version "${v.version}"`);
  if (!/^https:\/\/[\w./-]+$/.test(v.releaseUrl) || !/^https:\/\/[\w./-]+$/.test(v.docsUrl)) {
    throw new Error("the addresses must be plain https addresses");
  }
  for (const sum of Object.values(v.sha256)) {
    if (sum !== "" && !/^[0-9a-f]{64}$/.test(sum)) throw new Error(`unexpected SHA-256 "${sum}"`);
  }
  const values: Record<string, string> = {
    VERSION: v.version,
    RELEASE_URL: v.releaseUrl,
    DOCS_URL: v.docsUrl,
    SHA256_X64: v.sha256.x64,
    SHA256_ARM64: v.sha256.arm64,
  };
  const fill = (text: string) => {
    const filled = text.replace(/@([A-Z0-9_]+)@/g, (all, name: string) => values[name] ?? all);
    const left = filled.match(/@[A-Z0-9_]+@/);
    if (left) throw new Error(`no value for ${left[0]}`);
    return filled;
  };
  return { json: fill(files.json), install: fill(files.install) };
}
