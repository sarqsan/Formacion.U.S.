import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Las pruebas de reglas necesitan el emulador de Firebase y se ejecutan
    // aparte con `npm run test:rules` (ver vitest.rules.config.mts).
    exclude: ["node_modules/**", "tests/rules/**"],
    reporters: ["default"],
  },
});
