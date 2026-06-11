import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

// PWA: offline shell + last-loaded feed. sw.js is hand-rolled (web/public/).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // registration failure is non-fatal — the app just isn't offline-capable
    });
  });
}
