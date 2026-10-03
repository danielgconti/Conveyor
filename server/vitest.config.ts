import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Database tests share tables, so test files run one at a time.
    fileParallelism: false,
    // Docker integration tests pull/run containers; give them room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
