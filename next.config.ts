import type { NextConfig } from "next";

/**
 * Configuración de Next.js.
 *
 * Notas deliberadas:
 * - Se desactiva `cacheComponents`: la aplicación sirve datos por usuario
 *   (progreso, intentos) y no queremos caché implícita de contenido privado.
 * - `firebase-admin` se mantiene como paquete externo del servidor: usa APIs
 *   de Node (gRPC) que no deben empaquetarse con el bundle de Next.
 * - `unpdf` (lectura de PDF página a página, para los proveedores de IA que no
 *   leen documentos) también queda fuera del bundle: incluye su propia copia de
 *   pdf.js y empaquetarla rompe el worker.
 */
const nextConfig: NextConfig = {
  cacheComponents: false,
  serverExternalPackages: ["firebase-admin", "read-excel-file", "unpdf"],
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
  experimental: {
    // El asistente «Crear con IA» manda el PDF del temario en **una** petición
    // (server action). Next corta por defecto esos cuerpos en 1 MB, antes de
    // que se ejecute nuestro código, así que un PDF de 1–4 MB fallaba con un
    // 413 de la plataforma en lugar del aviso que da la aplicación. Se sube a
    // 5 MB: el límite real lo pone la aplicación (4 MiB, `MAX_AI_UPLOAD_BYTES`)
    // y Vercel (4,5 MB por petición a una función), y ninguno de los dos se
    // relaja con esto.
    serverActions: { bodySizeLimit: "5mb" },
  },
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
