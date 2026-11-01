/**
 * The Linux release archive (ADR-163): Trackwall for a Linux container, the daemon and its page without the desktop
 * shell. A Dev Container Feature installs it from the release (ADR-164), and it is signed with the update key, so that
 * an update inside the container can check it as the app's updater checks its packages (ADR-165).
 *
 *   trackwall-<version>-linux-<arch>.tar.gz
 *     trackwall/trackwall-daemon   the daemon, built for the architecture
 *     trackwall/ui/                its page, which it serves from `ui/` next to the binary
 *     trackwall/README.txt
 */

/** The daemon's build target of each archive, named by the architecture Docker reports (`uname -m` gives the other spelling). */
export const LINUX_ARCHIVES = {
  x64: "x86_64-unknown-linux-gnu",
  arm64: "aarch64-unknown-linux-gnu",
} as const;
export type LinuxArch = keyof typeof LINUX_ARCHIVES;
export const LINUX_ARCHS = Object.keys(LINUX_ARCHIVES) as LinuxArch[];

export function isLinuxArch(value: string): value is LinuxArch {
  return Object.hasOwn(LINUX_ARCHIVES, value);
}

export function linuxArchiveName(version: string, arch: LinuxArch): string {
  return `trackwall-${version}-linux-${arch}.tar.gz`;
}

/** The folder at the top of the archive, and the entries in it. */
export const LINUX_ARCHIVE_FOLDER = "trackwall";
export const LINUX_ARCHIVE_ENTRIES = ["README.txt", "trackwall-daemon", "ui"] as const;

/** Every entry of the archive must lie in its folder: the installer unpacks it as it is. */
export function strayLinuxArchiveEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => entry !== `${LINUX_ARCHIVE_FOLDER}/` && !entry.startsWith(`${LINUX_ARCHIVE_FOLDER}/`));
}

export function linuxReadme(version: string): string {
  return [
    `Trackwall ${version} for Linux (a dev container)`,
    "",
    "The daemon and its page, without the desktop app. Run in a container next to your repos:",
    "",
    "  ./trackwall-daemon --port 7700",
    "",
    "and open the address that `./trackwall-daemon address` prints, in a browser on your computer or in the desktop app",
    "(Settings > App > Daemon in a container). The port must be forwarded with the same number.",
    "",
    "State goes to ~/.trackwall, or to TRACKWALL_HOME when it is set.",
    "",
  ].join("\n");
}
