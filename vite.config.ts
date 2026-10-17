import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

import { quartzServiceWorker } from './plugins/serviceWorker';

// GitHub Pages serves project sites from /<repo>/. The workflow sets BASE_PATH.
const base = process.env.BASE_PATH ?? '/';
const packageVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const buildSha = process.env.GITHUB_SHA?.slice(0, 7) ?? 'dev';

export default defineConfig({
  base,
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(packageVersion),
    'import.meta.env.VITE_BUILD_SHA': JSON.stringify(buildSha),
  },
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
