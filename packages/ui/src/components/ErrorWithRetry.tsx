import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Błąd pobrania danych z przyciskiem ponowienia; `children` to dodatkowe akcje obok niego. */
export function ErrorWithRetry({ message, onRetry, children }: { message: string; onRetry: () => void; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-destructive text-sm whitespace-pre-wrap break-words">{message}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onRetry}>
          Spróbuj ponownie
        </Button>
        {children}
      </div>
    </div>
  );
}
