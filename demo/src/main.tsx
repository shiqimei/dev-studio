import { createRoot } from "react-dom/client";
import "./style.css";
import { App } from "./App";
import { ThemeProvider } from "./context/ThemeContext";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
