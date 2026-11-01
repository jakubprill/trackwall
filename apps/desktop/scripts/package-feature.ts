/**
 * Packs the Trackwall Dev Container Feature (ADR-164) for one release: `devcontainer-feature.json` and `install.sh` from
 * `apps/desktop/devcontainer-feature/`, with the version, the release's download address and the SHA-256 of each Linux
 * archive (ADR-163) written in, so that the Feature installs exactly the archives released with it. A dev container
 * names the result by its release address, which the Dev Containers specification takes as a Feature when the file is
 * called `devcontainer-feature-<id>.tgz`.
 *
 *   bun apps/desktop/scripts/package-feature.ts <folder with the Linux archives> <owner/repo>
 *
 * The release passes both archives; CI passes only the x64 one, and the Feature then refuses arm64.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TRACKWALL_DOCS_URL } from "@trackwall/protocol";
import { FEATURE_ARCHIVE, featureFiles } from "./feature.ts";
import { assertVersionsMatch, DESKTOP, REPO, run } from "./lib.ts";
import { LINUX_ARCHS, linuxArchiveName } from "./linux-archive.ts";

const [given, repo] = Bun.argv.slice(2);
if (!given || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  throw new Error("usage: bun apps/desktop/scripts/package-feature.ts <folder with the Linux archives> <owner/repo>");
}
const dir = resolve(given);
const version = assertVersionsMatch();

const sha256 = Object.fromEntries(
  LINUX_ARCHS.map((arch) => {
    const archive = join(dir, linuxArchiveName(version, arch));
    return [arch, existsSync(archive) ? createHash("sha256").update(readFileSync(archive)).digest("hex") : ""];
  }),
) as Record<(typeof LINUX_ARCHS)[number], string>;
if (Object.values(sha256).every((sum) => sum === "")) throw new Error(`no Linux archive of ${version} in ${dir}`);

const source = join(DESKTOP, "devcontainer-feature");
const files = featureFiles(
  {
    json: readFileSync(join(source, "devcontainer-feature.json"), "utf8"),
    install: readFileSync(join(source, "install.sh"), "utf8"),
  },
  {
    version,
    releaseUrl: `https://github.com/${repo}/releases/download/v${version}`,
    docsUrl: `${TRACKWALL_DOCS_URL}guide/dev-container`,
    sha256,
  },
);

const stage = join(REPO, "out", "stage-feature");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
writeFileSync(join(stage, "devcontainer-feature.json"), files.json);
writeFileSync(join(stage, "install.sh"), files.install, { mode: 0o755 });
const archive = join(dir, FEATURE_ARCHIVE);
run(["tar", "-czf", archive, "-C", stage, "devcontainer-feature.json", "install.sh"], REPO);
rmSync(stage, { recursive: true, force: true });
console.log(archive);
