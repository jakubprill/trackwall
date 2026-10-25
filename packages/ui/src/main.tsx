import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";
import { isTrayPanel } from "./lib/tray-panel.ts";
import { TrayPanel } from "./views/tray-panel/TrayPanel.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root in index.html");
createRoot(root).render(<StrictMode>{isTrayPanel(window.location.hash) ? <TrayPanel /> : <App />}</StrictMode>);
