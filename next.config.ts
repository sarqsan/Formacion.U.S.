import type { NextConfig } from "next";

/**
 * Configuración de Next.js.
 *
 * Notas deliberadas:
 * - Se desactiva `cacheComponents`: la aplicación sirve datos por usuario
 *   (progreso, intentos) y no queremos caché implícita de contenido privado.
 * - `firebase-admin` se mantiene como paquete externo del servidor: usa APIs
 *   de Node (gRPC) que no deben empaquetarse con el bundle de Next.
 */
const nextConfig: NextConfig = {
  cacheComponents: false,
  serverExternalPackages: ["firebase-admin", "read-excel-file"],
  // Tailwind 4 en Next 16 con Turbopack: sin esta regla, `@import "tailwindcss"`
  // y `@theme` no se procesan y la interfaz queda sin estilos (detectado en
  // la verificación visual de la fase 1).
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
