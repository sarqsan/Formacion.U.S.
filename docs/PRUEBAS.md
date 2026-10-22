# Pruebas ejecutadas

Fecha de ejecución: **21 de octubre de 2026**.

> **Aviso de alcance.** Las secciones 1–7 son el registro histórico de la fase 1
> (208 pruebas). El estado actual, tras la fase 2, está en la **sección 8**:
> 236 pruebas ejecutadas y **44 pruebas de reglas escritas pero NO ejecutadas**
> por falta de emulador. No se afirma que las reglas estén verificadas.
Entorno: Node.js 22.22.3, npm 10.9.8, Linux (sandbox sin acceso a Firebase).

> Este documento recoge **solo lo que se ejecutó realmente**. Lo que no se
> pudo ejecutar aparece en el apartado 6 con su motivo.

## 1. Cadena completa

```bash
npm run verify   # typecheck && lint && test && build
```

Resultado: **exit 0**.

| Paso | Comando | Resultado |
| --- | --- | --- |
| Tipos | `npm run typecheck` (`tsc --noEmit`) | 0 errores |
| Linter | `npm run lint` (`eslint`) | 0 errores, 0 avisos |
| Pruebas | `npm test` (`vitest run`) | **208 pruebas, 13 ficheros, todas pasan** |
| Build | `npm run build` (`next build`) | Compila; 13 rutas generadas |

## 2. Pruebas automáticas (208)

| Fichero | Pruebas | Qué cubre |
| --- | ---: | --- |
| `tests/domain/roles.test.ts` | 21 | Normalización de `ROL 1`/`ROL 2`, rechazo de `ROL 3`, `ROL 12`, etc.; rol ≠ permiso |
| `tests/domain/surname.test.ts` | 13 | Acentos, partículas, guiones, apóstrofos; rechazo de números, símbolos, inyección (`<script>`) y longitudes |
| `tests/domain/username.test.ts` | 24 | `rol+código de apellido`, determinismo, colisiones con sufijo, nombres reservados, formato del correo sintético |
| `tests/domain/import-rows.test.ts` | 19 | Cabeceras (orden, acentos, columnas de más), vista previa, duplicados intra-fichero y contra BD, resoluciones, filas inválidas |
| `tests/domain/scoring.test.ts` | 19 | Aprobado solo con todo correcto; 80 % no aprueba; blancos; multiopción exacta; opciones/preguntas inexistentes; validación de cuestionarios; `toClientQuiz` sin respuestas |
| `tests/domain/progress.test.ts` | 15 | Intentos acumulados, aprobado persistente, examen bloqueado hasta aprobar temas, reinicio por versión, invariantes |
| `tests/domain/reading.test.ts` | 7 | Lectura secuencial, página fuera de orden, repetición idempotente, fin de documento, tema completo |
| `tests/domain/storage-and-courses.test.ts` | 18 | Rutas de Storage, *path traversal*, firma solo del tema autorizado, publicación de versiones, validación de contenido |
| `tests/server/excel.test.ts` | 10 | **XLSX real** generado en la prueba: lectura, orden de columnas, filas vacías, cabeceras erróneas, no-xlsx, vacío, >2 MB, zip ajeno |
| `tests/server/import-service.test.ts` | 18 | Solo admin; recálculo en servidor; usuario propuesto por el cliente ignorado; siempre `learner`; tokens hasheados; rollback; auditoría; conflictos |
| `tests/server/activation-service.test.ts` | 14 | Activación correcta, token inexistente/usado/caducado/revocado/de otra cuenta, contraseña débil, cuenta ya activa, sin escalada |
| `tests/server/security-helpers.test.ts` | 20 | Entropía y hash de tokens; fallo cerrado de configuración; emuladores prohibidos en producción; comprobación de `Origin` |
| `tests/server/bootstrap-plan.test.ts` | 10 | Varios administradores, idempotencia, nombres inválidos/reservados, confirmación explícita |

Las pruebas de servidor usan **dobles en memoria** de Firestore/Auth (puertos),
de modo que las propiedades de seguridad se comprueban sin infraestructura.

## 3. Comprobaciones sobre la aplicación en ejecución

Servidor `next dev` en `http://127.0.0.1:3000` (sin Firebase configurado):

| Petición | Resultado observado |
| --- | --- |
| `GET /` | `200` |
| `GET /login` | `200` (CSS servido: 13 651 bytes, incluye utilidades Tailwind) |
| `GET /api/health` | `200 {"configured":false,"mode":"unconfigured"}` |
| `GET /panel` sin cookie | `307 → /login` (proxy) |
| `GET /admin` sin cookie | `307 → /login` (proxy) |
| `POST /api/activate` (JSON válido) | `503 SERVER_NOT_CONFIGURED` (fallo cerrado) |
| `POST /api/admin/import/preview` | `503 SERVER_NOT_CONFIGURED` |

Servidor en modo emulación (`FIREBASE_*_EMULATOR_HOST`, emulador **apagado** a propósito):

| Petición | Resultado observado | Qué demuestra |
| --- | --- | --- |
| `GET /api/health` | `200 {"configured":true,"mode":"emulator"}` | Configuración detectada |
| `POST /api/activate` con `Origin: https://evil.example` | `403 ORIGIN_FORBIDDEN` | CSRF: origen ajeno |
| `POST /api/activate` sin `Origin` | `403 ORIGIN_MISSING` | CSRF: origen obligatorio |
| `POST /api/activate` con origen correcto | `503 FIREBASE_UNAVAILABLE` | Fallo de infraestructura mapeado a 503 (antes devolvía 500: corregido) |
| `POST /api/admin/import/preview` sin cookie | `401 UNAUTHENTICATED` | No hay importación sin sesión |
| `next start` con emuladores (NODE_ENV=production) | `503 SERVER_CONFIG_UNSAFE` | Emuladores prohibidos en producción |

`POST` de `activate` con el emulador apagado tarda ~45 s (reintentos de gRPC);
es esperable y no afecta a producción.

## 4. Fallos reales encontrados y corregidos durante la verificación

| # | Fallo | Cómo se detectó | Corrección |
| --- | --- | --- | --- |
| 1 | Una fila duplicada intra-fichero se clasificaba como "ya existe en BD", bloqueando la resolución "es otra persona" | Prueba `detecta duplicados…` falló | Separar `takenFromDatabase` de `taken` |
| 2 | `TOPIC_ORDER_GAP` no detectaba órdenes repetidos | Prueba de contenido | Comparar 1..n contra el número de temas |
| 3 | **La interfaz no tenía ningún estilo Tailwind** (se perdió la regla `turbopack` al reescribir `next.config.ts`) | Aviso `Unknown at rule: @theme` en el log + CSS de 1 740 bytes sin `.flex` | Regla `@tailwindcss/turbopack` restaurada; CSS pasa a 13,6 KB con utilidades |
| 4 | Firebase inaccesible devolvía `500 INTERNAL_ERROR` | `curl` contra emulador apagado | `guard()` en repositorios → `503 FIREBASE_UNAVAILABLE` |
| 5 | `middleware` deprecado en Next 16 | Aviso en el log del servidor | Migrado a `src/proxy.ts` con `export function proxy` |
| 6 | Entorno sin `NODE_ENV` no compilaba en pruebas | `tsc` | `ServerEnvInput = Record<string, string \| undefined>` |

## 5. Dependencias

`npm audit` (21/10/2026):

- Total: **9 avisos altos**.
- Solo producción (`--omit=dev`): **4 altos**, todos por `@grpc/grpc-js` a través
  de `@firebase/firestore`, dependencia transitiva del paquete `firebase`.

Análisis: el código de cliente importa **solo** `firebase/app` y
`firebase/auth`; no se usa Firestore desde el navegador (el servidor usa
`firebase-admin`). El paquete vulnerable está instalado pero no se carga en
tiempo de ejecución de la aplicación. Las versiones que propone `npm audit
fix` son *downgrades* rompedores (`firebase@9.14.0`, `eslint-config-next@14`),
así que **no se han aplicado**. Se revaluará al conectar Firebase y antes de
desplegar.

`exceljs` se descartó como dependencia (arrastraba `uuid` vulnerable y es más
pesada); se usa `read-excel-file` solo en servidor, y las pruebas generan los
`.xlsx` con `fflate` para no añadir un escritor de Excel.

## 6. Lo que NO se ha podido ejecutar (y por qué)

| No ejecutado | Motivo | Cómo se probará |
| --- | --- | --- |
| Emulador de Firebase (Auth/Firestore/Storage) | `firebase-tools` no está instalado y no se han autorizado servicios externos | `npm i -D firebase-tools` + `firebase emulators:start` cuando se autorice |
| Pruebas de reglas `firestore.rules` / `storage.rules` | Requieren `@firebase/rules-unit-testing` y el emulador | Bloque 2: batería de reglas (permitido/denegado) |
| Conexión real a Firebase (login, importación, activación) | Sin proyecto Firebase (prohibido crearlo en esta fase) | Bloque 2 en emulador, Bloque 3 con proyecto de pruebas |
| Visor de PDF página a página | No implementado en esta fase | Bloque 3 (PDF.js + endpoint de firma) |
| Envío real de evaluaciones por HTTP | Endpoints de evaluación no implementados | Bloque 3 |
| Pruebas E2E de navegador | Sin Playwright/Chromium en el entorno | Bloque 4 |
| Carga, rendimiento y accesibilidad | Fuera del alcance de la fase 1 | Bloque 5 |
| Ejecución de `scripts/bootstrap-admins.mjs` | Requiere credenciales reales | Solo `node --check` (sintaxis) y comprobación de fallo cerrado sin credenciales: **exit 1 con mensaje claro** |
| Despliegue | Prohibido en esta fase | Bloque 6, con autorización |

## 7. Reproducir

```bash
npm ci
npm run verify
npm run dev
```

Para probar el comportamiento con emulador (cuando exista):

```bash
cp .env.example .env.local   # añadir FIREBASE_*_EMULATOR_HOST
npm run dev
```


---

## 8. Fase 2 — pruebas de seguridad (21/10/2026)

### 8.1 Resumen

| Conjunto | Escrito | Ejecutado | Resultado |
| --- | ---: | ---: | --- |
| Pruebas automáticas (`npm test`) | 236 | 236 | **todas pasan** |
| Pruebas de reglas de Firestore (`tests/rules/firestore.rules.test.ts`) | 34 | **0** | **no ejecutadas: bloqueo por falta de JVM** |
| Pruebas de reglas de Storage (`tests/rules/storage.rules.test.ts`) | 10 | **0** | **no ejecutadas: bloqueo por falta de JVM** |

### 8.2 Bloqueo del emulador (con evidencia)

El emulador de Firestore/Storage de Firebase es una aplicación Java. En este
entorno:

```
$ java -version
bash: java: command not found

$ npx firebase emulators:exec --only firestore --project demo-formacion "echo OK"
Error: Could not spawn `java -version`. Please make sure Java is installed and on your system PATH.

$ npm run test:rules
Error: Could not spawn `java -version`. Please make sure Java is installed and on your system PATH.
EXIT=1

$ apt-get install -y default-jre-headless
E: Could not open lock file /var/lib/dpkg/lock-frontend (... are you root?)

$ python3 -c "import jdk; jdk.install('17', jre=True)"
JdkError <urlopen error TLS/SSL connection has been closed (EOF)>

$ curl -o /dev/null https://storage.googleapis.com/...   → 000 (bloqueado)
$ curl -o /dev/null https://dl.google.com/                → 000 (bloqueado)
```

Cuatro vías independientes, las cuatro cerradas:

1. No hay JVM instalada ni en `/usr/lib/jvm`.
2. No se puede instalar por `apt` (sin privilegios y sin caché local).
3. No se puede descargar un JRE por `pip`/Adoptium (TLS bloqueado).
4. Aunque hubiera JVM, `firebase emulators:exec` debe descargar el `.jar` del
   emulador desde `storage.googleapis.com`, que también está bloqueado.

**No se ha sustituido por una prueba ficticia.** No existe un evaluador de
reglas de Firestore independiente y fiable en JS; usar uno de terceros habría
producido resultados que no reflejan el motor real, así que se ha descartado.

### 8.3 Qué sí se ha verificado en fase 2

| Comprobación | Método | Resultado |
| --- | --- | --- |
| Política de sesión: cuenta deshabilitada con token válido pierde acceso | 16 pruebas unitarias de `resolveSession` | **pasan** |
| Claims desfasadas, rol degradado, cuenta pendiente, ficha inexistente | idem | **pasan** |
| Todos los endpoints que escriben exigen origen de confianza | auditoría estática del código (`endpoint-authorization.test.ts`) | **pasa** |
| Todos los endpoints que escriben exigen sesión salvo 3 públicos justificados | idem | **pasa** |
| Los servicios de importación comprueban rol en cada función | idem | **pasa** |
| El código de navegador no escribe en Firestore | idem | **pasa** |
| `/api/admin/import/*` sin sesión → 401 | HTTP real | **401 UNAUTHENTICATED** |
| `/api/auth/session` con token inválido → 401 | HTTP real | **401 ID_TOKEN_INVALID** |
| `/api/me` sin sesión no devuelve datos | HTTP real | **200 `{"authenticated":false}`** |
| `/api/activate` con backend inalcanzable → 503 | HTTP real | **503 FIREBASE_UNAVAILABLE** |
| Páginas `/panel`, `/admin`, `/admin/importar`, `/cursos` sin cookie | HTTP real | **307 → /login** |
| Sin configuración, la app falla cerrada | HTTP real | **503 SERVER_NOT_CONFIGURED** en todo endpoint |
| Las pruebas de reglas compilan contra la API real de `@firebase/rules-unit-testing` | `tsc --noEmit` | **0 errores** (compilación ≠ ejecución) |

### 8.4 Qué NO se ha verificado (y no se puede afirmar)

- Que `firestore.rules` y `storage.rules` tengan sintaxis válida: **el compilador
  de reglas solo existe dentro del emulador**. Las reglas se han revisado a mano.
- Que las reglas permitan/denieguen lo esperado: **0 de 44 pruebas ejecutadas**.
- Que una sesión de alumno autenticado reciba 403 al llamar a un endpoint de
  administración **por HTTP**: requiere acuñar una cookie de sesión real, que
  necesita Firebase Auth (emulador o proyecto). La comprobación equivalente
  existe a nivel de servicio (18 pruebas de `import-service.test.ts`).
- Verificación criptográfica de tokens de Firebase (firma/emisor/caducidad):
  la hace el Admin SDK; aquí no se ha ejecutado.

### 8.5 Cómo cerrarlo en cuanto haya entorno

```bash
npm run test:rules   # arranca emuladores y ejecuta las 44 pruebas
```

Si el entorno no tiene Java, en una máquina con JDK 11+ y salida a
`storage.googleapis.com` funciona sin cambios de código.

## 9. Fase 3 — capa de persistencia (21/10/2026)

### 9.1 Resumen

| Comprobación | Método | Resultado |
| --- | --- | --- |
| TypeScript estricto | `tsc --noEmit` | **0 errores** |
| ESLint | `npm run lint` | **0 errores, 0 avisos** |
| Pruebas automáticas | `vitest run` | **332 pasan / 20 ficheros** |
| Build de producción | `next build` | **OK** |
| Cadena completa | `npm run verify` | **exit 0** |
| Esquema: identificadores y validación de documentos | `tests/server/schema.test.ts` (18) | **pasan** |
| Deriva código ↔ reglas ↔ índices ↔ documentación | `tests/server/schema-drift.test.ts` (13) | **pasan** |
| Publicación de versiones y separación de claves | `tests/server/catalog-service.test.ts` (17) | **pasan** |
| Corrección en servidor y no-fuga de respuestas | `tests/server/assessment-service.test.ts` (19) | **pasan** |
| Auditoría de base de datos (`db:check`) | `tests/server/db-checks.test.ts` (27) | **pasan** |
| `npm run db:init` sin configuración | ejecución real | **exit 1, "Falta FIREBASE_PROJECT_ID"** |
| `npm run db:check` sin configuración | ejecución real | **exit 1, se niega a apuntar a producción** |
| `npm run db:init` con emulador inalcanzable | ejecución real | **exit 1, «14 UNAVAILABLE: No connection established»** (~45 s por reintentos) |

Total desde el inicio del proyecto: **236 → 332 pruebas** (+96 en fase 3).

### 9.2 Qué cubren las pruebas nuevas

- **Esquema** (`schema.test.ts`): construcción de ids compuestos
  (`progress/{uid}_{courseId}`, `progressHistory/{uid}_{courseId}_v{n}`,
  `answerKeys/{courseId}_v{n}_{assessmentId}`), rechazo de segmentos con `/`,
  `..`, espacios o longitud excesiva, y validación de documentos de cuenta,
  progreso e intento (roles, estados, `claimsVersion` entero, coherencia de
  `correctCount ≤ totalQuestions`).
- **Deriva** (`schema-drift.test.ts`): toda colección del esquema tiene su
  `match /colección/` en `firestore.rules`; no hay reglas para colecciones
  inexistentes; `answerKeys`, `usernames`, `activationTokens` y `meta` están
  cerradas a `read, write`; existe el comodín final que deniega; los índices
  solo apuntan a colecciones reales y cubren las consultas de `progress`,
  `attempts` y `documents`; `docs/MODELO-DATOS.md` documenta todas las
  colecciones y no menciona ninguna que no exista; los scripts `db:*` están
  expuestos en `package.json`.
- **Catálogo** (`catalog-service.test.ts`): el documento público no contiene
  `correctOptionIds`; las claves viven aparte; solo administradores activos
  guardan y publican; no se sobrescribe una versión existente; la publicación
  exige la versión siguiente y las claves; un documento con respuestas dentro
  se rechaza (`CONTENT_LEAK`); publicar la v2 archiva la v1 sin borrarla.
- **Evaluaciones** (`assessment-service.test.ts`): la respuesta del servicio no
  incluye las respuestas correctas **ni siquiera al suspender** (se comprueba
  el conjunto exacto de campos devueltos); hay que leer el tema completo antes
  del cuestionario; el examen final está bloqueado hasta aprobar los temas
  obligatorios; los temas opcionales se corrigen pero no desbloquean; aprobar
  el final fija `completedAt`; al publicarse una versión nueva el progreso se
  archiva y hay que volver a leer.
- **Auditoría** (`db-checks.test.ts`): cada hallazgo de `db:check` tiene su
  caso (sin administrador, admin creado fuera del arranque, usuarios
  duplicados, `claimsVersion` inválido, curso apuntando a versión inexistente o
  no publicada, claves ausentes u huérfanas, progreso en versión futura,
  intento no corregido en servidor, aprobado imposible).

### 9.3 Qué NO se ha verificado

- **Nada contra Firestore real**: no hay proyecto ni emulador (sin JVM). Los
  adaptadores `FirestoreCourseCatalogStore` y `FirestoreLearningStore`
  compilan, pero sus transacciones **no se han ejecutado**. Por tanto no está
  probado que las transacciones sean atómicas en la práctica ni que los
  índices de `firestore.indexes.json` sean suficientes.
- **Reglas**: siguen 0 de 44 pruebas ejecutadas (se añadió la regla de `meta`,
  también sin compilar).
- **Scripts `db:init` / `db:check`**: se ha verificado su comportamiento de
  fallo cerrado (sin configuración no escriben); su camino feliz requiere
  credenciales.

## 10. Fase 4 — coste cero, sin Firebase Storage (21/10/2026)

> **Nota (Fase 6)**: esta sección es el registro de lo que se ejecutó en la
> Fase 4. Desde entonces cambiaron el tope de PDF (20 MiB → **8 MiB**), el
> endpoint de lectura (`/window` → `/pages`) y el modelo de acceso (matrícula
> obligatoria). Las cifras vigentes están en §11; las de esta sección se
> conservan para no reescribir el histórico.

### 10.1 Resumen

| Comprobación | Método | Resultado |
| --- | --- | --- |
| TypeScript estricto | `tsc --noEmit` | **0 errores** |
| ESLint | `npm run lint` | **0 errores, 0 avisos** |
| Pruebas automáticas | `vitest run` | **370 pasan / 22 ficheros** |
| Build de producción | `next build` | **OK** |
| Cadena completa | `npm run verify` | **exit 0** |
| Troceado, límites y presupuesto | `tests/domain/pdf-chunks.test.ts` (18) | **pasan** |
| Subida, lectura y cuota | `tests/server/document-service.test.ts` (21) | **pasan** |
| Sin rastro de Storage | `tests/server/schema-drift.test.ts` (15) | **pasan** |
| Endpoints nuevos con sesión/origen | HTTP real | **401 / 403** |

**Cambio de recuento de reglas: de 44 a 36 pruebas escritas y 0 ejecutadas.**
Las 10 de Storage se han eliminado porque ya no existe bucket; se han añadido 2
sobre `pdfChunks`. La cifra que importa sigue siendo la misma: **0 ejecutadas**,
porque el emulador sigue sin poder arrancar (falta JVM).

### 10.2 Qué se ha probado de verdad (ejecutado)

- **Troceado**: la suma de fragmentos reconstruye el fichero exacto para varios
  tamaños; el último fragmento puede ser más corto; un rango a caballo entre dos
  fragmentos pide exactamente dos.
- **Límites**: 20 MiB → 27 fragmentos; 27 + 2 escrituras de la transacción < 500;
  un fragmento en base64 ocuparía exactamente 1 MiB (por eso se guarda `Bytes`).
- **Validación del fichero**: se acepta `%PDF-` con basura previa (permitido por
  la especificación) y se rechaza HTML, ZIP o fichero vacío.
- **Subida**: solo admin activo; exige versión y tema existentes; no sobrescribe;
  no escribe nada si no cabe en el presupuesto; calcula SHA-256.
- **Lectura**: devuelve exactamente los bytes pedidos; reconstruye ventanas que
  cruzan fragmentos; lee solo los fragmentos necesarios; rechaza ventanas
  grandes, rangos fuera del fichero y documentos de versiones no publicadas;
  detecta un fragmento que falta (`DOCUMENT_CORRUPTED`) en vez de devolver basura.
- **Cuota**: informa de usado/libre/porcentaje; archivar libera cuota y deja de
  servir el documento; tras archivar cabe uno nuevo.
- **HTTP real** (servidor de desarrollo con emuladores *configurados*, sin
  emulador levantado): `GET /api/documents/.../window` y
  `GET/POST /api/admin/documents` → **401 UNAUTHENTICATED** sin sesión;
  `POST` con `Origin` ajeno → **403 ORIGIN_FORBIDDEN**; sin configuración →
  **503 SERVER_NOT_CONFIGURED** (falla cerrado).
- **Sin rastro de Storage**: `firebase.json` no tiene sección `storage` ni
  emulador de Storage; `admin.ts` no importa `firebase-admin/storage`;
  `.env.example` no declara bucket ni host de emulador de Storage.

### 10.3 Qué sigue sin ejecutarse (y por qué)

| Prueba | Casos | Ejecutadas | Motivo |
| --- | --- | --- | --- |
| `tests/rules/firestore.rules.test.ts` | 36 | **0** | sin JVM: el emulador no arranca |

- **Nada contra Firestore real**: la transacción que escribe 27 fragmentos +
  metadatos + contador **no se ha ejecutado**. Está verificada por tipos y por
  el doble en memoria, que reproduce sus invariantes, pero no su atomicidad.
- **Escritura real de `Bytes`**: que Firestore acepte 768 KiB por documento y
  que el tamaño contado sea el binario (no el base64) se deduce de la
  documentación del límite de 1 MiB; **no se ha medido aquí**.
- **403 para un alumno autenticado** en los endpoints de administración: no se
  puede acuñar una cookie de sesión real sin Auth (misma limitación que en fase
  2). El equivalente existe a nivel de servicio (permisos por rol, 4 casos).

## 11. Fase 6 — corrección integral (21/10/2026)

### 11.1 Resultado de la batería

| Comprobación | Método | Resultado |
| --- | --- | --- |
| TypeScript estricto | `npx tsc --noEmit` | **0 errores** |
| ESLint | `npm run lint` | **0 errores, 0 avisos** |
| Pruebas automáticas | `npx vitest run` | **440 pasan / 26 ficheros** |
| Build de producción | `next build` | **OK** (14 rutas) |
| Cadena completa | `npm run verify` | **exit 0** |
| Reglas de Firestore | `npm run test:rules` | **0 de 41 ejecutadas** (emulador no descargable, ver §11.4) |

### 11.2 Ficheros de prueba nuevos o reescritos

| Fichero | Casos | Qué cubre |
| --- | --- | --- |
| `tests/server/document-service.test.ts` | 32 | vacío, máximo exacto, exceso, presupuesto, concurrencia, matrícula, secuencia, rate limit, cuota, fragmento perdido |
| `tests/server/enrollment-service.test.ts` | 20 | matrícula y acceso, denegar por defecto, idempotencia, revocación, rol de administrador |
| `tests/server/ratelimit.test.ts` | 12 | ventana deslizante, coste por página, tope global, `retryAfterSeconds`, singletons |
| `tests/server/document-pages-endpoint.test.ts` | 11 | query `from`/`to`, cabeceras `no-store`, errores sin filtrar detalles, ausencia de `/window` |
| `tests/domain/enrollment.test.ts` | 11 | id determinista, validación del documento, estados permitidos |
| `tests/server/assessment-service.test.ts` | 24 | +5 casos: sin matrícula, otro curso, matrícula revocada, repetir cuestionario, no perder el APTO |
| `tests/rules/firestore.rules.test.ts` | **41** | +5 casos nuevos de matrícula y contenido (escritos, **0 ejecutados**) |
| `tests/server/endpoint-authorization.test.ts` | 13 | inventario de 9 rutas, `assertCourseAccess` en la lectura |
| `tests/domain/pdf-chunks.test.ts` | 18 | 8 MiB / 11 fragmentos / una transacción de 10 MiB |

### 11.3 Qué se ha ejecutado de verdad

- Corrección en servidor, desbloqueo por temas y examen final, cambio de
  versión que archiva el progreso: **con dobles en memoria**, no contra
  Firestore.
- Límites de tamaño (8 MiB justos, 8 MiB + 1 byte rechazado), presupuesto de
  cuota, concurrencia de subidas con el mismo estado inicial.
- Matrícula: denegar por defecto, revocación, ids mal formados, rol tomado
  solo del token de servidor.
- Limitador de peticiones con reloj inyectable (sin esperas reales).
- Contrato de la ruta: solo `GET`, `no-store`, sin campos del cliente.

### 11.4 Qué NO se ha ejecutado

| Prueba | Casos | Ejecutadas | Motivo |
| --- | --- | --- | --- |
| `tests/rules/firestore.rules.test.ts` | 41 | **0** | `storage.googleapis.com` no es accesible desde este entorno: la descarga del jar del emulador falla antes del TLS (`curl` → `SSL_ERROR_SYSCALL`). La JVM ya está resuelta (`jdk4py`), el bloqueo es de red. |

Consecuencias que se declaran explícitamente:

- Las reglas nuevas de `enrollments` **no están verificadas**: están escritas
  para que el emulador las evalúe en cuanto haya red, pero aquí no se ha
  ejecutado ni una.
- La transacción real (11 fragmentos + metadatos + contador, ~8,25 MiB) **no se
  ha ejecutado** contra Firestore. Que quepa en los 10 MiB es aritmética sobre
  el límite documentado, no una medición.
- La escritura real de `Bytes` de 768 KiB tampoco se ha medido.
- No se ha arrancado un servidor con sesión real: los 401/403 de HTTP real de
  la Fase 4 siguen siendo el último contacto con la aplicación en ejecución
  (la ruta de lectura cambió de nombre; su contrato se prueba por código).

### 11.5 Cómo cerrar las reglas en cuanto haya red

```
npm run test:rules
```

Fallará hoy en la descarga del emulador. En un equipo con acceso a
`storage.googleapis.com` (o con el emulador ya en caché en `~/.cache/firebase`)
no hace falta cambiar ninguna prueba.

## 12. Fase 7 — validación real y copias de seguridad (21/10/2026)

### 12.1 Batería ejecutada

| Comprobación | Método | Resultado |
| --- | --- | --- |
| TypeScript estricto | `npx tsc --noEmit` | **0 errores** |
| ESLint | `npm run lint` | **0 errores, 0 avisos** |
| Pruebas automáticas | `npx vitest run` | **476 pasan / 29 ficheros**, 4 omitidas |
| Build | `next build` | **OK** |
| Cadena completa | `npm run verify` | **exit 0** |
| Reglas de Firestore | `npm run test:rules` | **0 de 41** — `RESULTADO: BLOCKED` (exit 2): falta Java y el jar |
| Integración Firestore | `npm run test:firestore` | **0 de 4** — `RESULTADO: BLOCKED`; ya no se omiten en silencio |
| Entorno | `npm run check:env` | **BLOCKED** (exit 2) sin Java; **FAILED** (exit 1) sin Java en el `PATH` |
| Payload de subida | `npm run firestore:size` | medido: **8,00 MiB** por commit, 768,2 KiB por documento |

### 12.2 Ficheros nuevos de prueba

| Fichero | Casos | Estado |
| --- | --- | --- |
| `tests/server/backup.test.ts` | 19 | **ejecutados** |
| `tests/server/firestore-wire-size.test.ts` | 6 | **ejecutados** |
| `tests/integration/firestore-emulator.test.ts` | 4 | escritos, **omitidos** (sin emulador) |
| `tests/server/document-service.test.ts` | +4 (36) | **ejecutados** |
| `tests/server/document-pages-endpoint.test.ts` | +1 (12) | **ejecutados** |
| `tests/server/synthetic-data.test.ts` | 6 | **ejecutados** |

### 12.3 Qué es real y qué no

**Real (ejecutado aquí):**

- La medida del payload con el serializador y los protos oficiales de
  `@google-cloud/firestore`: 8,00 MiB de commit, 2,00 MiB de margen, 768,2 KiB
  por documento; el diseño anterior medía 20,01 MiB y **no cabía**.
- El recorrido completo de la copia de seguridad con datos sintéticos:
  exportar, cifrar, comprobar que no hay nada legible en el archivo, descifrar,
  restaurar y comparar documento a documento (incluidos los `Buffer`).
- Detección de contraseña incorrecta, byte alterado y manifiesto falsificado.
- Troceado en lotes, negativa a sobrescribir sin `--force`, `--dry-run`.
- Cuota por usuario de sesión, coste no manipulable por el cliente y
  revocación que corta el acceso sin dejar avanzar el progreso.

**No ejecutado (y por qué):**

| Prueba | Motivo |
| --- | --- |
| 41 pruebas de reglas | filtro de salida corta el TLS a `storage.googleapis.com` (ver §12.4) |
| 4 de integración (transacción real, concurrencia, contador, lectura con Firestore) | el emulador no está disponible |
| Exportación/restauración contra Firestore | igual |

### 12.4 Evidencia del bloqueo (actualizada)

```
TLSv1.3 (OUT), TLS handshake, Client hello (1)
OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to storage.googleapis.com:443
```

TCP abre; el corte ocurre en el saludo TLS. `registry.npmjs.org`, `pypi.org` y
`github.com` responden 200; el resto de hosts probados (`dl.google.com`,
`repo1.maven.org`, `registry-1.docker.io`, `raw.githubusercontent.com`) se
cortan igual. La JVM funciona (OpenJDK 25.0.2 vía `jdk4py`). No se ha desactivado
ni eludido la validación TLS.

### 12.5 Cómo cerrarlo

En un equipo con salida a Google (o con el jar del emulador en caché en
`~/.cache/firebase/emulators`):

```
npm run check:env        # debe pasar a PASSED
npm run test:rules       # 41 pruebas de reglas
npm run test:firestore   # 4 de integración
npm run test:emulator    # ambas, con resultado clasificado
npm run seed:synthetic -- --reset && npm run rehearse:backup
```

Requisitos exactos, versiones y cómo distinguir PASSED / FAILED / BLOCKED:
[`ENTORNO-PRUEBAS.md`](./ENTORNO-PRUEBAS.md).



## 13. Versión demostrable (21/10/2026)

| Comprobación | Método | Resultado |
| --- | --- | --- |
| Recorrido de servicios | `npx vitest run tests/demo` | **14 pasan** (11 de flujo + 3 de importación) |
| Recorrido real por HTTP | `npm run check:demo` (con `DEMO_MODE=1 npm run dev`) | **PASSED** (19 comprobaciones): reinicio, lectura de 3 pantallas, matrícula, publicación y control de acceso |
| Rutas de la interfaz | `curl` a 10 rutas sin sesión, 6 como alumno y 6 como administración | 7 públicas en 200 y 3 protegidas en 307 a `/login`; 5 de alumno en 200 y `/admin` en 307; las 6 de administración en 200 |
| Cadena completa | `npm run verify` | tipado, lint, pruebas y build en verde |

Qué cubren las pruebas nuevas:

- lectura rechazada fuera de orden (pantalla 2 antes que la 1);
- cuestionario cerrado hasta terminar la lectura y repetible hasta acertar;
- examen final bloqueado con temas pendientes y desbloqueado después;
- matrícula, revocación (el progreso se conserva) y reactivación;
- edición de un borrador y publicación de una versión nueva que reinicia el
  progreso sin borrar el histórico;
- un alumno no puede publicar ni matricular;
- el Excel de ejemplo se lee con el lector real y la vista previa marca el rol
  inválido y las cuentas ya existentes.

Sigue **sin ejecutarse** lo de la fase 7 (41 pruebas de reglas y 4 de
integración): el modo demostración no las sustituye.

## 14. Fase 8 — conexión con Firebase real (21/10/2026)

| Comprobación | Comando | Resultado |
| --- | --- | --- |
| Portal y comprobaciones de seguridad | `npm test` | **547 pasan**, 4 omitidas (integración con emulador) |
| Diagnóstico de conexión sin credenciales | `npm run check:firebase` | **FAILED (exit 2)**, sin tocar la red ni escribir nada |
| Diagnóstico con configuración y servicio inalcanzable | idem con `FIRESTORE_EMULATOR_HOST` apuntando a un puerto cerrado | **BLOCKED (exit 3)** en ~10 s (cada lectura lleva su propio plazo) |
| Emisión de sesión | `tests/server/actor-resolution.test.ts` | 7 casos nuevos: cuenta pendiente, deshabilitada, sin ficha, claims obsoletas y token con rol elevado |
| Origen (CSRF) | `tests/server/security-helpers.test.ts` | `X-Forwarded-Host` ya **no** se acepta; producción exige `APP_ORIGIN` https y cookie `__Host-` |
| Configuración web de Firebase | `tests/server/firebase-check.test.ts` | 8 casos: valor ausente, `apiKey` mal formada, `authDomain` con `https://` o barra, `appId` mal formado, cliente y servidor en proyectos distintos, dominio de correo desalineado |
| El diagnóstico no escribe | idem | 6 casos: el script no contiene `.set/.add/.update/.delete/.create`, lotes, transacciones ni altas de usuario; usa solo `listCollections`, `count()`, `get()` y `listUsers(1)` |
| Lectura de `.env.local` | `tests/server/env-file.test.ts` | 11 casos: comentarios y líneas vacías, `export`, comillas dobles con `\n` (clave privada), comillas simples, comentario al final, `#` entre comillas, prioridad de `.env.local`, el proceso manda y ningún fichero inventa valores |
| Identificador del proyecto | idem | 4 casos: `EXPECTED_PROJECT` coincide con `.firebaserc` y con `.env.example`, el ID tiene forma válida y **no queda ninguna referencia al identificador antiguo** |

Sigue **sin ejecutarse** contra el proyecto `formacionus-63555`: no hay credenciales en
este entorno y no se escribe en el proyecto real sin autorización. El ID del
proyecto está confirmado por el usuario; `apiKey` y `appId` no, porque dependen
de la app web registrada.

## 15. Bloque 03 — cimientos del ciclo de vida de los cursos (21/10/2026)

Alcance ejecutado: esquema v2 (retirada de `documents` de las colecciones
legibles por el cliente), índice compuesto de matrículas, módulo de plantillas,
servicio de creación de cursos y página `/admin/cursos/nuevo`.

| Comprobación | Comando | Resultado |
| --- | --- | --- |
| Cadena completa | `npm run verify` | **exit 0**: tipado 0 errores, lint 0 avisos, **579 pruebas en verde**, build con `/admin/cursos/nuevo` entre las rutas |
| Pruebas totales | `npm test` | **579 pasan**, 4 omitidas (integración con emulador), 38 ficheros |
| Recorrido de la demostración | `DEMO_MODE=1 npx next start -p 3100` + `node scripts/demo-smoke.mjs http://127.0.0.1:3100` | **PASSED** (19 comprobaciones), igual que antes del bloque |
| Alta de curso por HTTP | guion propio contra el servidor anterior: formulario real, acciones de servidor sin JavaScript | **18 comprobaciones, PASSED** (detalle abajo) |
| Reglas de Firestore | `npm run test:rules` | **BLOQUEADO**: sin JVM el emulador no arranca. 41 pruebas escritas, **0 ejecutadas** |
| Integración con emulador | `npm run test:firestore` | **BLOQUEADO** por el mismo motivo (4 pruebas omitidas) |
| Conexión real | `npm run check:firebase` | **BLOQUEADO**: TLS hacia Google se corta desde el sandbox. Sin credenciales usadas |

Pruebas nuevas:

| Fichero | Pruebas | Qué fijan |
| --- | ---: | --- |
| `tests/domain/course-template.test.ts` | 15 | La definición vacía no es publicable (y se guarda igual); clonación profunda con independencia en los dos sentidos; metadatos nuevos sin publicación |
| `tests/server/course-editor.test.ts` | 12 | Curso nuevo con `publishedVersion` y `lastDraftVersion` a null; no sobrescribe; permisos; paridad demo/real |
| `tests/server/schema.test.ts` (ampliado) | +5 | `documents` ya no es legible por el cliente; validación de la ficha del curso |
| `tests/server/schema-drift.test.ts` (ampliado) | +2 | Reglas cierran `documents`; el índice `enrollments(courseId,status)` está declarado y no falta ninguno previo |

Comprobaciones por HTTP de la página nueva (18, todas en verde): el alumno es
redirigido a `/panel` y sin sesión a `/login`; el administrador ve el formulario;
crear devuelve 303 a `/admin/cursos/{id}?ok=creado`; la ficha confirma el alta y
dice «Este curso no tiene versiones»; el curso aparece en el listado marcado
como sin versiones; no aparece en el panel del alumno; un identificador repetido
se rechaza **sin sobrescribir** el curso existente; un identificador inválido se
rechaza en el servidor aunque el navegador no lo hubiera validado.

Lo que estas pruebas **no** demuestran: que Firestore escriba la ficha (los
dobles son en memoria), que `create()` traduzca ALREADY_EXISTS en el servicio
real, ni que las reglas se comporten así al desplegarlas. Eso sigue pendiente de
un entorno con JDK y credenciales.

## 16. Bloque 04 — editor de estructura y borradores (21/10/2026)

Alcance ejecutado: apertura del primer borrador (creado o reanudado), guardado y
recuperación de la estructura (título, descripción, temas), validación en tres
niveles, concurrencia optimista y errores reales en la interfaz. **Nada de este
bloque publica, sube PDF ni edita cuestionarios.**

| Comprobación | Comando | Resultado |
| --- | --- | --- |
| Cadena completa | `npm run verify` | **exit 0**: tipado 0 errores, lint 0 avisos, **638 pruebas en verde**, build con `/admin/cursos/[courseId]/editar` |
| Pruebas totales | `npm test` | **638 pasan**, 4 omitidas (integración con emulador), 40 ficheros + 1 omitido |
| Recorrido de la demostración | `DEMO_MODE=1 npx next start -p 3000` + `npm run check:demo` | **PASSED**, **46 comprobaciones** (antes 19) |
| Reglas de Firestore | `npm run test:rules` | **BLOQUEADO**: sin JVM el emulador no arranca. 0 ejecutadas |
| Integración con emulador | `npm run test:firestore` | **BLOQUEADO** por el mismo motivo |
| Conexión real | `npm run check:firebase` | **BLOQUEADO**: TLS hacia Google se corta desde el sandbox. Sin credenciales usadas |

Pruebas nuevas (59):

| Fichero | Pruebas | Qué fijan |
| --- | ---: | --- |
| `tests/domain/courses-draft.test.ts` | 17 | El borrador vacío **no** genera errores de estructura; límites de título/descripción/temas; ids únicos y válidos; órdenes enteros sin repetir; `mandatory` booleano; avisos sin bloquear; orden normalizado y determinista; tamaño UTF-8 real |
| `tests/server/draft-editor.test.ts` | 29 | Primer borrador v1 de un curso sin versiones; reanudar sin duplicar; guardar vacío e incompleto y recuperarlo; crear/editar/reordenar conservando ids, documentos y cuestionarios; obligatorio/opcional en ambos sentidos; la publicada queda idéntica campo a campo; `DRAFT_STALE`, `DRAFT_CONFLICT` y `VERSION_CONFLICT`; carrera de dos aperturas; fallo de persistencia sin escritura ni éxito falso; paridad demo ↔ dobles; el alumnado sigue viendo la versión publicada |
| `tests/server/draft-form.test.ts` | 13 | Lectura del `FormData` real: reordenar por número, eliminar por casilla o por ausencia, añadir tema, rechazar duplicados, recortar espacios; de formulario a almacén y vuelta; rutas de las acciones con `error` frente a `ok` |

Recorrido HTTP añadido a `scripts/demo-smoke.mjs` (27 comprobaciones nuevas,
todas en verde):

- el botón «Nueva versión en borrador» crea la v2 y lleva al editor;
- el editor carga, guarda y **al reabrir aparece lo guardado** (título y tema nuevo);
- guardar con la revisión vieja devuelve **error** y no toca el contenido bueno;
- la versión publicada sigue publicada y no lleva el título del borrador;
- el alumnado no ve el borrador ni en su panel ni en el catálogo;
- un curso recién creado ofrece «Preparar el primer borrador», la v1 nace sin
  temas, se guarda vacía y el curso no aparece al alumnado.

Lo que estas pruebas **no** demuestran (y por eso no se afirma):

- que la transacción de Firestore (`createDraftVersion`, `replaceDraftContent`)
  se comporte así contra un proyecto real: los dobles y la demo son memoria y el
  emulador no arranca sin JVM;
- que las reglas permitan o denieguen nada: no se han ejecutado ni desplegado;
- que el editor funcione con Firebase real (TLS cortado desde este entorno).

Cómo cerrarlo cuando haya entorno:

```bash
npm run test:rules        # requiere JDK
npm run test:firestore    # requiere JDK
npm run check:firebase    # requiere red hacia Google y credenciales
```

## 17. Bloque 05 — cuestionarios y examen final con claves separadas (22/10/2026)

Alcance ejecutado: crear, editar y eliminar preguntas en el cuestionario de cada
tema y en el examen final de un **borrador**, con las respuestas correctas en su
documento solo-servidor y guardado conjunto de contenido y claves. **No** se ha
tocado la publicación, el visor ni la subida de PDF.

| Comprobación | Comando | Resultado |
| --- | --- | --- |
| Cadena completa | `npm run verify` | **exit 0**: tipado 0 errores, lint 0 avisos, **689 pruebas en verde**, build OK |
| Pruebas totales | `npm test` | **689 pasan**, 4 omitidas (emulador), 43 ficheros + 1 omitido (44) |
| Recorrido de la demostración | `DEMO_MODE=1 npx next start -p 3000` + `npm run check:demo` | **PASSED**, **56 comprobaciones** (antes 46) |
| Reglas de Firestore | `npm run test:rules` | **BLOQUEADO**: sin JVM |
| Integración con emulador | `npm run test:firestore` | **BLOQUEADO**: sin JVM |
| Conexión real | `npm run check:firebase` | **BLOQUEADO**: TLS hacia Google cortado; sin credenciales |

Pruebas nuevas (51):

| Fichero | Pruebas | Qué fijan |
| --- | ---: | --- |
| `tests/domain/courses-quiz.test.ts` | 19 | Estructura de una pregunta (enunciado, 2–8 opciones, identificadores válidos y únicos, una correcta que exista, tipo coherente); cuestionario vacío permitido; límites; aviso —no error— de opción sin texto; `validateCourseVersion` y `validateQuizDefinition` siguen igual de estrictas |
| `tests/server/draft-quiz.test.ts` | 19 | Guardar contenido y claves fuera de la versión; editar conservando identificadores; eliminaciones sin claves huérfanas; una sola operación del almacén; fallo del almacén sin escritura parcial; cuestionario vacío guardado con avisos; una opción sin texto se guarda con aviso (no bloquea); `COURSE_QUIZ_INVALID`, `TOPIC_NOT_FOUND`, `DRAFT_STALE`, `VERSION_NOT_EDITABLE`; publicada y sus claves intactas; alumnado sin respuestas; paridad demo ↔ dobles |
| `tests/server/draft-editor.test.ts` | +1 (30) | Eliminar un tema del borrador arrastra sus claves: no quedan respuestas correctas huérfanas y la versión publicada conserva las suyas |
| `tests/server/quiz-form.test.ts` | 12 | Lectura del `FormData` real: editar enunciado/tipo/etiquetas, cambiar la correcta (única y múltiple), quitar y añadir opciones, eliminar y añadir preguntas, ámbitos separados (tema vs examen final), bloques a medias rechazados, ida y vuelta por el almacén |

Recorrido HTTP añadido a `scripts/demo-smoke.mjs` (10 comprobaciones nuevas):

- el editor incluye el formulario de cuestionarios y examen final;
- guardar devuelve `ok=cuestionarios` y, al reabrir, la pregunta del tema y la del
  examen final están ahí y el contador las suma;
- un guardado con la revisión vieja devuelve **error** y no pisa el cuestionario;
- el alumnado no ve ninguna de las preguntas del borrador.

Corrección del propio guion (no del producto): `forms()` ahora imita lo que hace
un navegador con casillas y desplegables (una casilla sin marcar no se envía; un
`select` envía su opción seleccionada). Antes, un guardado «real» desde el guion
habría borrado las respuestas correctas de las preguntas existentes.

Lo que **no** demuestran estas pruebas: que la transacción de Firestore escriba
los dos documentos de forma atómica en un proyecto real, ni que las reglas
permitan o denieguen nada. Dobles y demo son memoria; el emulador no arranca sin
JVM y la conexión real está cortada.

## 18. Bloque 06 — subida privada de PDF y control de cuota (22/10/2026)

Alcance ejecutado: abrir una subida pendiente con reserva de cuota, enviar el
PDF por partes, finalizar verificando tamaño y SHA-256, cancelar liberando la
reserva, y asociar el documento **activo** al tema de un borrador. **No** se ha
tocado la publicación, el visor por páginas ni ningún bloque posterior.

| Comprobación | Comando | Resultado |
| --- | --- | --- |
| Cadena completa | `npm run verify` | **exit 0**: tipado 0 errores, lint 0 avisos, **725 pruebas en verde**, build OK |
| Pruebas totales | `npm test` | **725 pasan**, 4 omitidas (emulador), 45 ficheros + 1 omitido (46) |
| Recorrido de la demostración | `DEMO_MODE=1 npx next start -p 3000` + `npm run check:demo` | **PASSED**, **79 comprobaciones** (antes 56) |
| Reglas de Firestore | `npm run test:rules` | **BLOQUEADO**: sin JVM |
| Integración con emulador | `npm run test:firestore` | **BLOQUEADO**: sin JVM |
| Conexión real | `npm run check:firebase` | **BLOQUEADO**: TLS hacia Google cortado; sin credenciales |

Pruebas nuevas (36):

| Fichero | Pruebas | Qué fijan |
| --- | ---: | --- |
| `tests/domain/pdf-upload.test.ts` | 12 | Tamaño declarado (0, exacto 8 MiB, exceso), forma del SHA-256, páginas declaradas y su relación con los bytes, identificador `doc_` + 32 hex, material de identidad, tamaño de cada parte (la última puede ser corta), orden (`write`/`retry`/fuera de orden), progreso sin pasarse de 100 %, partes ausentes, cabecera `%PDF-` (incluida tras relleno) y rechazo de HTML/vacío |
| `tests/server/document-upload.test.ts` | 24 | Ciclo completo y activación solo tras verificar; 8 MiB exactos en 11 partes; parte 0 que no es PDF; versión publicada; tema inexistente y páginas imposibles; autor ajeno y alumno; parte adelantada, corta o fuera de rango; reenvío idempotente y conflicto con contenido distinto; finalización incompleta con números; SHA-256 incorrecto y fragmento corrompido en el almacén; interrupción y reanudación sin reescribir; creación y finalización idempotentes; cancelación que libera y borra una sola vez; archivo de un activo; volver a subir tras cancelar; reserva antes de recibir bytes; dos aperturas simultáneas que no caben; reserva convertida en uso; asociación idempotente, rechazo de pendientes y de versiones publicadas, revisión obsoleta; inmutabilidad del activo; paridad demo ↔ dobles |
| `tests/server/document-service.test.ts` | reescrito (36) | La batería anterior de lectura, límites y cuota, ahora sobre el ciclo nuevo: incluye presupuesto agotado sin reserva, fallo a mitad con reintento y concurrencia de dos ficheros distintos |

Recorrido HTTP añadido a `scripts/demo-smoke.mjs` (23 comprobaciones nuevas):

- el editor incluye la sección de PDF, avisa de que el número de páginas **no se
  verifica** y pide confirmarlo, y muestra la cuota;
- abrir la subida devuelve **201** y un `documentId` que asigna el servidor; un
  cuerpo con `documentId` propio se rechaza con **400**;
- una parte que no es PDF se rechaza con **400** y finalizar antes de tiempo con
  **409**;
- la subida pendiente aparece en el editor y **no** se lista como documento
  asociado;
- finalizar verifica la huella (**200**), el documento queda activo y cuenta en
  la cuota; asociarlo lo deja en el tema y reasociarlo no lo duplica;
- una segunda subida reserva cuota antes de recibir bytes y, al cancelarla,
  libera exactamente lo reservado (la reserva vuelve a cero);
- el alumnado no recibe el documento del borrador.

Corrección encontrada al ejecutar el recorrido: las rutas nuevas llamaban a
`getServerConfig()` para comprobar el origen y en la demostración devolvían
**503** por falta de `FIREBASE_PROJECT_ID`. Ahora usan `configuredAppOrigin()`
(solo lee `APP_ORIGIN`) y `requirePortalActor()` (sesión de Firebase en modo
real, cookie de la demo en la demostración). El endurecimiento de producción no
se relaja: el camino real sigue exigiendo la configuración completa.

Lo que **no** demuestran estas pruebas: que la transacción de Firestore reserve
de verdad sin carreras en un proyecto real (dobles y demo son memoria, sin
concurrencia real) ni que la lectura de fragmentos fuera de la transacción no
pueda dejar un estado intermedio visible. El emulador sigue sin arrancar por
falta de JVM, así que la subida se declara **verificada en dominio, servicio y
demostración**, y **no verificada** contra Firestore real.

## 19. Bloque 07 — visor PDF privado (22/10/2026)

Alcance ejecutado: el alumnado con matrícula activa abre el **PDF completo** de un
documento **publicado** por la puerta del portal, servido con autorización en
servidor, integridad comprobada y cabeceras privadas; en pantalla lo abre el
visor nativo del navegador (con enlace a pestaña nueva para Android). **No** se
ha tocado el progreso por páginas, ni la publicación, ni la subida del bloque 06,
ni las reglas de seguridad.

| Comprobación | Comando | Resultado |
| --- | --- | --- |
| Cadena completa | `npm run verify` | **exit 0**: tipado 0 errores, lint 0 avisos, **757 pruebas en verde**, build OK |
| Pruebas totales | `npm test` | **757 pasan**, 4 omitidas (emulador), 47 ficheros + 1 omitido (48) |
| Recorrido de la demostración | `DEMO_MODE=1 npx next start -p 3000` + `npm run check:demo` | **PASSED**, **104 comprobaciones** (antes 79) |
| Reglas de Firestore | `npm run test:rules` | **BLOQUEADO**: sin JVM |
| Integración con emulador | `npm run test:firestore` | **BLOQUEADO**: sin JVM |
| Conexión real | `npm run check:firebase` | **BLOQUEADO**: TLS hacia Google cortado; sin credenciales |

Pruebas nuevas (32):

| Fichero | Pruebas | Qué fijan |
| --- | ---: | --- |
| `tests/server/document-file.test.ts` | 25 | Acceso correcto con matrícula activa; sin matrícula; autenticado sin matrícula en ese curso; documento que solo está en un borrador; versión antigua no referenciada por la publicada vigente; pendiente, abortado, archivado e incompleto; curso sin versión publicada; cruce entre cursos distintos; identificadores manipulados (mayúsculas, `..`, barra, id inventado); fragmento ausente, fragmento alterado y firma `%PDF-` rota; SHA-256 global incorrecto; tamaño declarado distinto del real; fallo del almacén sin filtrar datos; coste por fragmento con el límite agotado; paridad demo ↔ dobles; administración sin matrícula tampoco recibe el fichero |
| `tests/demo/demo-pdf.test.ts` | 7 | El PDF de ejemplo es un PDF 1.4 **estructuralmente válido** (cabecera, `xref` con desplazamientos reales, `startxref`, `%%EOF`); número de páginas; escapado de paréntesis y acentos ASCII; la siembra deja todos los documentos `active`, con sus fragmentos y su huella correcta; el alumno matriculado recibe el PDF completo; al revocar la matrícula deja de recibirlo; un documento que solo está en el borrador no se entrega aunque el PDF siga en el almacén |

Recorrido HTTP añadido a `scripts/demo-smoke.mjs` (25 comprobaciones nuevas):

- la página del documento ofrece la ruta del visor; el alumno matriculado recibe
  **200** con `application/pdf`, cabecera `%PDF-`, `no-store` + `private`,
  `inline` y sin rutas internas;
- sin sesión **401**; cuenta pendiente **401**; sin matrícula en ese curso
  **403**; id inventado y ruta manipulada **404**;
- en el editor del borrador se sube un PDF real por la API del bloque 06 y se
  comprueba que **antes de finalizar** devuelve **404**, que finalizado pero sin
  asociar sigue devolviendo **404** y que **mientras la versión no se publica**
  el alumnado tampoco lo recibe;
- tras publicar, el alumno recibe **200** y los bytes entregados son
  **exactamente** los subidos; la página del curso muestra el enlace al visor.

Defecto corregido durante el bloque: la comprobación de «documento referenciado»
recorría todos los temas de todas las versiones y aceptaba un documento de una
versión antigua; ahora se limita a la versión **publicada vigente** del curso, y
la prueba de la versión antigua lo fija.

Lo que **no** demuestran estas pruebas: que Firestore real entregue los
fragmentos con la misma latencia y atomicidad, ni que las reglas impidan leer
`pdfChunks` desde un cliente. Dobles y demostración son memoria. Tampoco se ha
abierto un PDF real en un dispositivo Android: la alternativa (enlace a pestaña
nueva) está en la interfaz, pero **no se ha medido** en un teléfono.
