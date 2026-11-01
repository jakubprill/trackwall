/**
 * Files of a GitHub release of Trackwall that something outside the release workflow downloads: the Linux archive of the
 * daemon and its page (ADR-163), which the Dev Container Feature installs and `trackwall-container update` replaces
 * (ADR-164, ADR-165). One place for the names, so the release, the Feature and the update cannot drift apart.
 */

/** Where every release's files are, by tag: `<this>/download/v<version>/<file>`. The updater's endpoint is under it too. */
export const TRACKWALL_RELEASES_URL = "https://github.com/jakubprill/trackwall/releases";

/** The architectures of the Linux archive, named as Docker names them (`uname -m` gives x86_64 and aarch64). */
export const LINUX_ARCHS = ["x64", "arm64"] as const;
export type LinuxArch = (typeof LINUX_ARCHS)[number];

export function isLinuxArch(value: string): value is LinuxArch {
  return (LINUX_ARCHS as readonly string[]).includes(value);
}

export function linuxArchiveName(version: string, arch: LinuxArch): string {
  return `trackwall-${version}-linux-${arch}.tar.gz`;
}

/** The folder at the top of the Linux archive. */
export const LINUX_ARCHIVE_FOLDER = "trackwall";

/** A release version as tags carry it without the `v`: what may go into a file name and a download address. */
export const RELEASE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

export function releaseFileUrl(version: string, file: string): string {
  return `${TRACKWALL_RELEASES_URL}/download/v${version}/${file}`;
}
