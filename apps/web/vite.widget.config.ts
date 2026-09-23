import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-widget', copyPublicDir: false,
    lib: { entry: 'src/widget.ts', name: 'EktAssistant', formats: ['iife'], fileName: () => 'ekt-assistant.js' },
  },
});
