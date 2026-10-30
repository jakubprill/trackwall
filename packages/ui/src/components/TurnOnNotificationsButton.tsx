import { Button } from "@/components/ui/button";
import { askForNotifications } from "@/lib/browser-notifications";

/** The one click after which the browser asks whether Trackwall may show notifications (ADR-146). */
export function TurnOnNotificationsButton() {
  return (
    <Button size="sm" onClick={askForNotifications}>
      Turn on notifications
    </Button>
  );
}
