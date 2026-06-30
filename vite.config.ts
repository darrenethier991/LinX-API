import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// LinX Admin v2 — Vite + React + Tailwind setup
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        open: true,
    },
    resolve: {
        alias: {
            "@": "/src",
        },
    },
});
