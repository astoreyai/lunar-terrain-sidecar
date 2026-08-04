import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.join(root, 'packages', name, 'src/index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@lts/shared-types': pkg('shared-types'),
      '@lts/terrain-core': pkg('terrain-core'),
      '@lts/terrain-pipeline': pkg('terrain-pipeline'),
      '@lts/lunar-solar': pkg('lunar-solar'),
      '@lts/lunar-terramech': pkg('lunar-terramech'),
      '@lts/lunar-dem': pkg('lunar-dem'),
      '@lts/lunar-features': pkg('lunar-features'),
      '@lts/terrain-export': pkg('terrain-export'),
      '@lts/terrain-validation': pkg('terrain-validation'),
      '@lts/terrain-protocol': pkg('terrain-protocol'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
