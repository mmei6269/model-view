import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const artifactTarget = String(
    env.MODELVIEW_ARTIFACT_BASE_URL || env.ARTIFACT_BASE_URL || env.VITE_ARTIFACT_BASE_URL || "http://127.0.0.1:5174",
  ).replace(/\/+$/, "");

  return {
    root: "next",
    envDir: ".",
    plugins: [react(), tailwindcss()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/__cf": {
          target: artifactTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/__cf/, ""),
        },
      },
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
    },
    build: {
      outDir: "../dist-next",
      emptyOutDir: true,
    },
  };
});
