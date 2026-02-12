import { createRoot } from "react-dom/client";
import "./style.css";
import { App } from "./App";
import { ThemeProvider } from "./context/ThemeContext";
import { FontProvider } from "./context/FontContext";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <FontProvider>
      <App />
    </FontProvider>
  </ThemeProvider>,
);
