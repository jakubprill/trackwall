import type { FolderEntry } from "@trackwall/protocol";

/**
 * The "Files on disk" panel of the Shell tab (ADR-187) without React: paths under a place as the daemon takes them (names joined
 * with `/`, `""` for the folder itself), and saving a downloaded file from the page.
 */

/** The path of an entry of the folder at `folder`. */
export function entryPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

/** What a click on an entry does: a folder opens, a file downloads, a link or anything else does nothing. */
export function entryAction(entry: FolderEntry): "open" | "download" | null {
  if (entry.kind === "folder") return "open";
  return entry.kind === "file" ? "download" : null;
}

/** Hands the bytes to the browser as a download named `name`: the page cannot write a file itself. */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // The browser starts the download from the link's click; the address can go once that has happened.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
