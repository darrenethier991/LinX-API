// LinX Billing Engine — TanStack Start app configuration
// This file configures the TanStack Start SSR framework with Vite.
// Server functions (createServerFn) are enabled by default in TanStack Start.
import { defineConfig } from '@tanstack/start/config';
import viteTsConfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  vite: {
    plugins: [
      // Resolve TypeScript path aliases (@ → /src)
      viteTsConfigPaths({
        projects: ['./tsconfig.json'],
      }),
    ],
    server: {
      port: 5173,
    },
  },
  server: {
    // Server-only env vars — never bundled into the browser build
    // These are accessed via process.env in server functions
    envPrefix: ['SUPABASE_', 'LINX_ECHO_', 'STRIPE_SECRET_', 'COST_', 'GLOBAL_'],
  },
});
