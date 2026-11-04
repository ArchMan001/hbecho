import { defineConfig } from "vitest/config";

// 默认套件离线：setup.ts 会拒绝任何非回环网络连接（见 tests/harness/network-deny.ts）。
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["tests/harness/setup.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
