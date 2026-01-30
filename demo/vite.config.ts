import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: __dirname,
  plugins: [tailwindcss()],
  server: {
    port: 5688,
    proxy: {
      "/ws": {
        target: "ws://localhost:5689",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
