import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Tailwind v4 needs no tailwind.config.js and no postcss config — the vite plugin
// plus `@import "tailwindcss"` in src/index.css is the whole setup.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
});
