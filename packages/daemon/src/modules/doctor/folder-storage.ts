/**
 * Where on Linux the projects folder's files live (ADR-101): a folder of the user's computer mounted into a container or
 * WSL (Docker Desktop's bind mounts, WSL's `/mnt/c`) passes every file through the virtual machine, so git and builds
 * there are slower than on either side's own disk. The doctor names it, since everything else works.
 */

/**
 * File systems that carry a folder of the host into Linux: 9p and drvfs (WSL), virtiofs, fakeowner, gRPC FUSE and osxfs
 * (Docker Desktop), sshfs (Lima, Colima), and the shared folders of VirtualBox, Parallels and VMware.
 */
const HOST_SHARED_FS = new Set([
  "9p",
  "drvfs",
  "virtiofs",
  "fakeowner",
  "fuse.grpcfuse",
  "osxfs",
  "fuse.osxfs",
  "fuse.sshfs",
  "vboxsf",
  "prl_fs",
  "fuse.vmhgfs-fuse",
]);

export interface FolderStorage {
  mountPoint: string;
  fsType: string;
  /** The files come from the user's computer through the virtual machine. */
  sharedFromHost: boolean;
}

/** The mount that holds `dir`, from `/proc/self/mountinfo`: the longest mount point that `dir` is in; `null` when none is. */
export function folderStorage(mountinfo: string, dir: string): FolderStorage | null {
  let best: { mountPoint: string; fsType: string } | null = null;
  for (const line of mountinfo.split("\n")) {
    const [fields, after] = line.split(" - ");
    const mountPoint = fields?.split(" ")[4];
    const fsType = after?.split(" ")[0];
    if (mountPoint === undefined || fsType === undefined) continue;
    const decoded = unescapeMountField(mountPoint);
    if (!isWithin(dir, decoded)) continue;
    if (best === null || decoded.length >= best.mountPoint.length) best = { mountPoint: decoded, fsType };
  }
  return best && { ...best, sharedFromHost: HOST_SHARED_FS.has(best.fsType) };
}

function isWithin(dir: string, mountPoint: string): boolean {
  if (mountPoint === "/") return dir.startsWith("/");
  return dir === mountPoint || dir.startsWith(`${mountPoint}/`);
}

/** The kernel writes a space, tab, newline and backslash in a path as an octal escape (`\040`). */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}
