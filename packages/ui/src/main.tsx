import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";
import { applyWindowEffect, resolveWindowEffect } from "./lib/window-effect.ts";

// Bez czekania na wynik: do tego czasu UI ma nieprzezroczyste tło, a błąd zostawia je na stałe.
resolveWindowEffect().then(
  (effect) => applyWindowEffect(effect, document.documentElement),
  (err: unknown) => console.warn("efekt tła okna niedostępny", err),
);

const root = document.getElementById("root");
if (!root) throw new Error("brak #root w index.html");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
