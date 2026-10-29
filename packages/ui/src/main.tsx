// First: zod's config has to be in place before any schema is built (see the file).
import "./lib/zod-config.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { ErrorWithRetry } from "./components/ErrorWithRetry.tsx";
import "./index.css";
import { LastScreens, LastScreensContext } from "./lib/last-screens.ts";
import { isTrayPanel } from "./lib/tray-panel.ts";
import { reportUiErrors } from "./lib/ui-error-report.ts";
import { TrayPanel } from "./views/tray-panel/TrayPanel.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root in index.html");
const trayPanel = isTrayPanel(window.location.hash);
// For the whole life of the window, across views and reconnects to the daemon (ADR-117).
const lastScreens = new LastScreens();
// The last line of defence against a blank window: an error no inner boundary caught leaves a message and a way out.
createRoot(root, reportUiErrors(trayPanel ? "tray-panel" : "window")).render(
  <StrictMode>
    <ErrorBoundary
      fallback={(message) => (
        <div className="p-6">
          <ErrorWithRetry message={`Trackwall stopped with an error: ${message}`} onRetry={() => window.location.reload()} />
        </div>
      )}
    >
      {trayPanel ? (
        <TrayPanel />
      ) : (
        <LastScreensContext.Provider value={lastScreens}>
          <App />
        </LastScreensContext.Provider>
      )}
    </ErrorBoundary>
  </StrictMode>,
);
