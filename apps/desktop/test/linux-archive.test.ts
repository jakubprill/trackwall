import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LINUX_ARCHIVES, LINUX_ARCHS, linuxArchiveName, linuxReadme, strayLinuxArchiveEntries } from "../scripts/linux-archive.ts";

const release = readFileSync(join(import.meta.dir, "..", "..", "..", ".github", "workflows", "release.yml"), "utf8");

describe("the Linux release archive (ADR-163)", () => {
  test("is named by version and architecture, for both architectures Docker runs", () => {
    expect(LINUX_ARCHS.map((arch) => linuxArchiveName("1.2.3", arch))).toEqual([
      "trackwall-1.2.3-linux-x64.tar.gz",
      "trackwall-1.2.3-linux-arm64.tar.gz",
    ]);
  });

  test("release.yml builds each architecture for its daemon target and checks its file and signature", () => {
    for (const arch of LINUX_ARCHS) {
      expect(release).toContain(`- arch: ${arch}\n`);
      expect(release).toContain(`triple: ${LINUX_ARCHIVES[arch]}\n`);
      expect(release).toContain(`linux_${arch}="trackwall-$version-linux-${arch}.tar.gz"`);
      expect(release).toContain(`"$linux_${arch}.sig"`);
    }
  });

  test("an entry outside the trackwall folder is stray, so the installer never unpacks beside it", () => {
    expect(
      strayLinuxArchiveEntries(["trackwall/", "trackwall/trackwall-daemon", "trackwall/ui/index.html", "../etc/x", "other/file"]),
    ).toEqual(["../etc/x", "other/file"]);
  });

  test("its README names the version and how to start the daemon on the forwarded port", () => {
    const readme = linuxReadme("1.2.3");
    expect(readme).toStartWith("Trackwall 1.2.3 for Linux");
    expect(readme).toContain("./trackwall-daemon --port 7700");
  });
});
