import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    host: true,
    port: 8284,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "http://localhost:8283",
        changeOrigin: true,
      },
    },
  },
});
