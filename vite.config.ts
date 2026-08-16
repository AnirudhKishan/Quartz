import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { quartzServiceWorker } from './plugins/serviceWorker';

// GitHub Pages serves project sites from /<repo>/. The workflow sets BASE_PATH.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [react(), quartzServiceWorker()],
  build: { target: 'es2022' },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
