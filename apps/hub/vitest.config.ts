import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  plugins: [react(), glsl()],
  test: {
    environment: "node",
  },
});
