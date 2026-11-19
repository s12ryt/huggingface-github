import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // NodeNext 風格的 '@/x/y.js' 需映射回 TypeScript 原始檔
      { find: /^@\/(.*)\.js$/, replacement: `${src}/$1.ts` },
      { find: /^@\//, replacement: `${src}/` },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/setup/global.ts'],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
