import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.join(rootDir, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 3847,
    proxy: {
      "/api": "http://127.0.0.1:3848",
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
