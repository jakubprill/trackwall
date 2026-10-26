// First: zod's config has to be in place before any schema is built (see the file).
import "./zod-config.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { ErrorWithRetry } from "./components/ErrorWithRetry.tsx";
import "./index.css";
import { isTrayPanel } from "./lib/tray-panel.ts";
import { TrayPanel } from "./views/tray-panel/TrayPanel.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root in index.html");
// The last line of defence against a blank window: an error no inner boundary caught leaves a message and a way out.
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary
      fallback={(message) => (
        <div className="p-6">
          <ErrorWithRetry message={`Trackwall stopped with an error: ${message}`} onRetry={() => window.location.reload()} />
        </div>
      )}
    >
      {isTrayPanel(window.location.hash) ? <TrayPanel /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
);
