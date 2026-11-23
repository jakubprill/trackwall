import { doctorApi, type TrustedProjectsFolder } from "@trackwall/protocol";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";

/**
 * "Trust folder" (ADR-270): the button that has Trackwall add the projects folder to the folders Copilot CLI trusts
 * without asking, where the user would otherwise edit Copilot CLI's `config.json` by hand.
 */

/** What the button does, said next to it before the click: the click is the user's consent to exactly this. */
export const TRUST_FOLDER_EFFECT =
  "Trackwall adds the projects folder to Copilot CLI's trusted folders, so Copilot CLI works in every repo and task in it without asking, and keeps a copy of the file as it was.";

/** What happened, shown in place of the button after the click. */
export function trustedFolderMessage({ folder, added, backup }: Pick<TrustedProjectsFolder, "folder" | "added" | "backup">): string {
  if (!added) return `Copilot CLI already trusts ${folder}.`;
  const copy = backup === null ? "" : ` The file as it was: ${backup}`;
  return `Copilot CLI now trusts ${folder}; sessions you start from now on are not asked.${copy}`;
}

/** The request behind the button; the daemon takes the folder from its settings, so the request names none. */
export function trustProjectsFolder(conn: Connection): Promise<TrustedProjectsFolder> {
  return post(conn, doctorApi.trustProjectsFolder, {});
}
