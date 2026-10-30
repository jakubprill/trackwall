import { useState } from "react";
import { Button } from "@/components/ui/button";
import { inDesktopShell } from "@/lib/app-window";
import { askForNotifications, useNotificationAccess } from "@/lib/browser-notifications";
import { readOfferDismissed, saveOfferDismissed, showsNotificationOffer } from "@/lib/notification-offer";

/** Strip above the views in a browser tab that offers browser notifications (ADR-146); the browser asks only after this click. */
export function NotificationOffer() {
  const access = useNotificationAccess();
  const [dismissed, setDismissed] = useState(() => readOfferDismissed(() => window.localStorage));
  if (!showsNotificationOffer(inDesktopShell(), access, dismissed)) return null;
  const notNow = () => {
    setDismissed(true);
    saveOfferDismissed(() => window.localStorage);
  };
  return (
    <div className="bg-primary/10 flex items-center gap-3 border-b px-4 py-2">
      <p className="min-w-0 flex-1 text-sm">Get a notification from this tab when an agent needs you while you work in another window.</p>
      <Button size="sm" onClick={() => void askForNotifications().catch(() => undefined)}>
        Turn on notifications
      </Button>
      <Button variant="ghost" size="sm" onClick={notNow}>
        Not now
      </Button>
    </div>
  );
}
