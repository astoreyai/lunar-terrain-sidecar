import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  server: { port: 5173, strictPort: true },
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true },
  resolve: {
    alias: {
      '@lts/shared-types': path.join(here, '../../packages/shared-types/src/index.ts'),
    },
  },
});
