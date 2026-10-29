import { Code } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDesktop, useEditorLink } from "@/lib/desktop";

/**
 * A button that opens a folder or file in VS Code wherever the daemon runs: the daemon opens it on its desktop, the page
 * links to VS Code attached to the daemon's container (ADR-121), and without either there is no button (ADR-120).
 */
export function EditorButton({
  path,
  label,
  onOpen,
  disabled = false,
}: {
  path: string;
  label: string;
  onOpen: () => void;
  disabled?: boolean;
}) {
  const desktop = useDesktop();
  const editorLink = useEditorLink(path);
  if (editorLink) {
    return (
      <Button variant="outline" size="sm" asChild>
        <a href={editorLink}>
          <Code /> {label}
        </a>
      </Button>
    );
  }
  if (!desktop) return null;
  return (
    <Button variant="outline" size="sm" onClick={onOpen} disabled={disabled}>
      <Code /> {label}
    </Button>
  );
}
