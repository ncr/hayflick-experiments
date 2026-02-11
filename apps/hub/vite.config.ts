import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import glsl from "vite-plugin-glsl";

const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.NODE_ENV === "production" && repoName ? `/${repoName}/` : "/";

export default defineConfig({
  base,
  plugins: [react(), glsl()],
  server: {
    allowedHosts: ["exp.trixtech.net"],
  },
});
