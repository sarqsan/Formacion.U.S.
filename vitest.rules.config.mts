import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Configuración EXCLUSIVA de las pruebas de reglas.
 *
 * Se separa del `npm test` normal porque necesita el emulador de Firebase
 * (Java). Se ejecuta con:
 *
 *     npm run test:rules
 *
 * que arranca `firebase emulators:exec` y lanza este fichero dentro de él.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/rules/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    // El emulador es un recurso compartido: sin paralelismo entre ficheros.
    fileParallelism: false,
    reporters: ["default"],
  },
});
