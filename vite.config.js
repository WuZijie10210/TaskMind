import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  base: "/",
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("./static", import.meta.url)), emptyOutDir: true },
});
