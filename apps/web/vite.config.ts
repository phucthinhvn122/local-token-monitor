import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 3456,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3457",
        changeOrigin: false
      }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
