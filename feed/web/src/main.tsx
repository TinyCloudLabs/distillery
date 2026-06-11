import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { AuthGate } from "./SignIn.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <AuthGate>
    <App />
  </AuthGate>,
);
