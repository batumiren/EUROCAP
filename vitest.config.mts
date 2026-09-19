import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    environment: "node",
    env: { DATABASE_PATH: path.resolve(import.meta.dirname, "data", "test.db") },
    fileParallelism: false,
  },
});
