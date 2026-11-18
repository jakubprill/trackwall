import { Button } from "@/components/ui/button";

/**
 * A view with nothing to offer before a projects folder is set (Home, Sessions): what it needs the folder for, and
 * "Get started", the view's one bright button, which opens the steps that set it (ADR-262).
 */
export function ProjectsFolderNeeded({ needs, onOpenGetStarted }: { needs: string; onOpenGetStarted: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 p-6">
      <p className="text-sm">Trackwall needs your projects folder before it can {needs}.</p>
      <Button size="sm" onClick={onOpenGetStarted}>
        Get started
      </Button>
    </div>
  );
}
