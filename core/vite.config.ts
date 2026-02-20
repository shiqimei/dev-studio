import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5688,
    proxy: {
      "/ws": {
        target: "ws://localhost:5689",
        ws: true,
        // Suppress EPIPE errors from WebSocket proxy when clients disconnect
        // (common with React StrictMode dev double-mount)
        configure: (proxy) => {
          proxy.on("error", (err) => {
            if ((err as NodeJS.ErrnoException).code === "EPIPE") return;
            console.error("[vite proxy]", err.message);
          });
        },
      },
      "/api": {
        target: "http://localhost:5689",
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
