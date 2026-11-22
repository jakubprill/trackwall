import { doctorApi, type ProjectsFolderTrust, type TrustedProjectsFolder } from "@trackwall/protocol";
import { useCallback, useState } from "react";
import { FoldButton } from "@/components/FoldButton";
import { TrustFolderButton } from "@/components/TrustFolderButton";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { trustProjectsFolder } from "@/lib/trust-folder";
import { useRemote } from "@/lib/use-remote";

/**
 * How to stop Copilot CLI's trust prompt, folded under the New session form (ADR-266), and only while Copilot CLI does
 * not trust the projects folder (ADR-290): once it does, the question would only take a line of every form. The read is
 * Copilot CLI's `config.json` alone, once per form.
 */
export function TrustedFolderNote({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, doctorApi.projectsFolderTrust, {}), [conn]);
  const folderTrust = useRemote(load);
  return <TrustedFolderQuestion folderTrust={folderTrust.data} trust={() => trustProjectsFolder(conn)} />;
}

/**
 * The question itself for a read of the projects folder's trust: nothing while the read is on its way or failed, since
 * the question only saves a prompt the user can answer, and nothing once Copilot CLI trusts the folder.
 */
export function TrustedFolderQuestion({
  folderTrust,
  trust,
}: {
  /** `undefined` while the read is on its way or failed. */
  folderTrust: ProjectsFolderTrust | undefined;
  trust: () => Promise<TrustedProjectsFolder>;
}) {
  const [open, setOpen] = useState(false);
  if (folderTrust?.trusted !== false) return null;
  return (
    <div className="flex flex-col gap-1">
      <FoldButton open={open} onOpen={setOpen} className="text-muted-foreground">
        Copilot CLI asks to trust the folder?
      </FoldButton>
      {open && (
        <>
          <p className="text-muted-foreground max-w-prose text-xs">
            Copilot CLI asks you to trust a folder before it works there. To skip that prompt for every repo and task, trust{" "}
            <span className="text-foreground font-mono">{folderTrust.folder}</span>: that covers its repos and their task worktrees.
          </p>
          <TrustFolderButton trust={trust} />
        </>
      )}
    </div>
  );
}
