# Formación U.G.–U.S.

Aplicación web **independiente** de formación del personal de la U.G.–U.S.

> **Estado: desplegada y en uso, con Firebase conectado.**
> Autenticación real, cuentas activadas por código, cursos con PDF, cuestionarios
> y examen final funcionando en `https://formacionus.vercel.app`. Sigue habiendo
> un modo de demostración con datos inventados (`DEMO_MODE=1`) para enseñar la
> aplicación sin tocar datos reales.
> **Lo que falta para terminar, y por qué orden:**
> [`docs/ESTADO-Y-PENDIENTES.md`](docs/ESTADO-Y-PENDIENTES.md).

## Aislamiento

Esta aplicación **no** comparte nada con la aplicación de Gestión de Personal y
Cuadrantes:

- repositorio propio (este);
- Firebase propio (sin configurar todavía);
- sin acceso a su base de datos, autenticación, reglas ni datos;
- sin importar código de aquel proyecto.

La futura integración será un botón que abra la URL de Formación desde la
aplicación de cuadrantes. Ese botón **no** modifica su lógica funcional.

## Qué incluye esta fase

| Área | Estado |
| --- | --- |
| Modelo de dominio (roles, apellidos, usuarios, evaluaciones, progreso, versionado) | Implementado y probado |
| Importación Excel (2 columnas, validación, duplicados, vista previa, alta con tokens) | Implementado y probado |
| Activación de cuenta con token de un solo uso y contraseña personal | Implementado y probado |
| Sesión con cookie httpOnly + Custom Claims + versión de claims | Implementado; política de sesión con 16 pruebas; sin ejecutar contra Firebase |
| Reglas de Firestore (denegar por defecto, con matrícula) | Escritas y revisadas; **sin ejecutar** (el emulador no se puede descargar en este entorno) |
| Interfaz: portada, acceso, panel de alumno, curso, lectura de pantallas, cuestionarios, examen final, panel de administración, matrículas, progreso e importación | Implementada; recorrido completo en modo demostración |
| Cursos, temas, PDF por páginas, cuestionarios, examen final, versión nueva | Implementado y probado en servidor (subida solo por API); interfaz de lectura y matrícula ya disponible sobre el almacén de demostración |
| Script de administradores iniciales (varios, idempotente) | Implementado y ejecutado: `admin1` activo en producción |
| Cambio de contraseña de una cuenta activa (`--reset-password`) | Implementado, probado y documentado |
| Cambio de la propia contraseña desde `/cuenta` | Implementado y probado (exige la actual, revoca sesiones) |

## Puesta en marcha (desarrollo)

**Para enseñar la aplicación sin Firebase** (datos inventados en memoria):

```bash
npm install
DEMO_MODE=1 npm run dev      # http://localhost:3000 → /login y elige un perfil
```

**Con Firebase** (requiere proyecto propio y credenciales):

```bash
npm install
cp .env.example .env.local   # rellenar a mano; nunca subir credenciales
npm run dev
```

Comprobaciones disponibles:

```bash
npm run typecheck   # TypeScript estricto, sin emitir
npm run lint        # ESLint (next/core-web-vitals + typescript)
npm test            # 547 pruebas con Vitest (4 omitidas sin emulador)
npm run build       # build de producción de Next.js
npm run verify      # las cuatro anteriores en orden

npm run check:env   # ¿está el entorno listo? PASSED / FAILED / BLOCKED
npm run check:firebase  # conexión con Firebase, solo lectura (0 ok / 2 falta config / 3 no responde)
npm run check:web       # solo la configuración web, sin red (0 válida / 2 falta o no cuadra)
                        # hoy: PASSED con los valores de .env.local
                        # proyecto esperado: formacionus-63555 (.firebaserc, .env.example)
npm run emulators   # emulador local de Firestore (requiere Java 17+)
npm run test:rules  # 41 pruebas de reglas (Java 17+ y el jar del emulador)
npm run test:firestore  # 4 pruebas de integración (ya no se omiten en silencio)
npm run test:emulator   # reglas + integración, con resultado PASSED/FAILED/BLOCKED
npm run seed:synthetic -- --reset   # datos inventados en el emulador
npm run rehearse:backup             # ensayo exportar → borrar → restaurar → comparar

npm run check:demo      # recorre la demostración por HTTP (con DEMO_MODE=1 arrancado)

npm run firestore:size  # mide el payload real de una subida de PDF
npm run backup:export   # copia cifrada (BACKUP_PASSPHRASE + --out)
npm run backup:restore  # restauración verificada (--dry-run primero)

npm run db:init     # simula la inicialización de la base de datos (no escribe)
npm run db:check    # audita la base de datos: esquema, cuentas, cursos, progreso
```

> **Aviso (fase 7):** existe copia de seguridad cifrada propia
> (`npm run backup:export` / `backup:restore`) porque Spark no incluye backups.
> El formato y el recorrido están probados con datos sintéticos, pero **la
> restauración contra Firestore aún no se ha ejecutado** y las 41 pruebas de
> reglas siguen bloqueadas por la red del entorno. Ver
> [`docs/INFORME-FASE-7.md`](docs/INFORME-FASE-7.md) y, para el estado
> actualizado, [`docs/ESTADO-FINAL.md`](docs/ESTADO-FINAL.md).
>
> **Aviso (fase 6):** el acceso a un curso exige ahora **matrícula activa**
> (`enrollments/{uid}_{courseId}`): estar publicado ya no da acceso. Matricular
> y revocar se hace desde `POST /api/admin/enrollments`; el panel aún no tiene
> botón. Tope de PDF: **8 MiB**. Ver
> [`docs/INFORME-FASE-6.md`](docs/INFORME-FASE-6.md).
>
> **Aviso (fase 2):** las pruebas de reglas (`tests/rules/`, 41 casos) están
> escritas pero **no se han ejecutado** en el entorno de desarrollo: la JVM ya
> está resuelta, pero el emulador no se puede descargar (falta salida a
> `storage.googleapis.com`). Mientras no se
> ejecuten, las reglas **no** están verificadas empíricamente. Ver
> [`docs/PRUEBAS.md`](docs/PRUEBAS.md) §8 y [`docs/INFORME-FASE-2.md`](docs/INFORME-FASE-2.md).
>
> **Aviso (fase 4):** el proyecto funciona en el **plan gratuito Spark**. No usa
> Firebase Storage (lo exige Blaze): los PDF se guardan fragmentados en
> Firestore y solo los sirve el servidor. Ver
> [`docs/INFORME-FASE-4.md`](docs/INFORME-FASE-4.md).
>
> **Aviso (fase 3):** la capa de persistencia (esquema, catálogo, corrección en
> servidor, índices) está escrita y probada con dobles en memoria, pero **no se
> ha ejecutado contra Firestore**: no hay proyecto ni emulador disponible. Ver
> [`docs/INFORME-FASE-3.md`](docs/INFORME-FASE-3.md).

## Estructura

```
src/
  app/                 Rutas Next.js (App Router) y endpoints /api
  domain/              Reglas de negocio PURAS (sin Firebase, sin red, sin relojes)
    auth/              Política de contraseñas, tokens, claims, autorización
    people/            Apellidos, cabeceras, nombres de usuario, análisis de importación
    assessments/       Corrección de cuestionarios y examen (servidor)
    progress/          Progreso de curso y lectura secuencial de PDF
    courses/           Versionado y validación de contenido
    storage/           Rutas privadas de Storage y URLs firmadas
  server/              Adaptadores de servidor (Firebase Admin, HTTP, servicios)
  lib/firebase/        SDK de navegador con persistencia en memoria
tests/                 Pruebas (dominio, servidor y utilidades)
docs/                  Arquitectura, modelo de datos, seguridad, pruebas, decisiones
firestore.rules        Reglas de Firestore (denegar por defecto)
storage.rules          Reglas de Storage (bucket cerrado al cliente)
scripts/               Utilidades manuales (alta de administradores iniciales)
```

La carpeta `domain/` no importa nada de Firebase ni de Next: eso es lo que
permite probarla entera sin servicios externos y reutilizarla si cambia el
proveedor.

## Documentación

- [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) — stack, capas y flujos.
- [`docs/MODELO-DATOS.md`](docs/MODELO-DATOS.md) — colecciones, campos e invariantes.
- [`docs/SEGURIDAD.md`](docs/SEGURIDAD.md) — controles, límites y riesgos.
- [`docs/PRUEBAS.md`](docs/PRUEBAS.md) — qué se ha ejecutado realmente.
- [`docs/INFORME-FASE-8.md`](docs/INFORME-FASE-8.md) — conexión con el Firebase
  real: qué está conectado, qué sigue en memoria y qué falta.
- [`docs/CONEXION-FIREBASE.md`](docs/CONEXION-FIREBASE.md) — guía paso a paso de
  Firebase Console, variables de entorno y comprobación de conexión.
- [`docs/VERCEL.md`](docs/VERCEL.md) — despliegue en Vercel: qué detecta solo,
  variables de entorno y cómo comprobar el vínculo con el repositorio (sin
  desplegar todavía).
- [`docs/AUDITORIA-PRODUCCION.md`](docs/AUDITORIA-PRODUCCION.md) — verificador
  `db:check --redact`, workflow manual de solo lectura y permisos mínimos de la
  cuenta de servicio.
- [`docs/DECISIONES.md`](docs/DECISIONES.md) — ADR y decisiones pendientes.
- [`docs/PLAN.md`](docs/PLAN.md) — siguientes bloques.
- [`docs/INFORME-FASE-1.md`](docs/INFORME-FASE-1.md) — entrega de la fase 1.
- [`docs/INFORME-FASE-2.md`](docs/INFORME-FASE-2.md) — pruebas de seguridad y bloqueo del emulador.
- [`docs/ENTORNO-PRUEBAS.md`](docs/ENTORNO-PRUEBAS.md) — requisitos (Java, CLI, emulador), datos sintéticos y lectura de PASSED/FAILED/BLOCKED.
- [`docs/ESTADO-FINAL.md`](docs/ESTADO-FINAL.md) — cierre técnico: qué está ejecutado, qué está BLOCKED y qué debe correr el entorno compatible.
- [`docs/ENTREGA-DEMO.md`](docs/ENTREGA-DEMO.md) — versión demostrable: guion, límites, qué es real y hoja de ruta.

## Licencia y datos

Repositorio privado de uso interno. No contiene datos personales reales, ni
credenciales, ni documentación confidencial.
