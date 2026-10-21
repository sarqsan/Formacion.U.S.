# Informe de la fase 6 — corrección integral

**Fecha:** 21 de octubre de 2026
**Rama:** `arena/89a0aca0-formacion-u-s` (base `c4ce33d`, **0 commits, 0 push, 0 despliegues**)
**Alcance:** corrección ejecutada sobre el código y las pruebas del repositorio
`sarqsan/Formacion.U.S.`. No se ha creado ninguna cuenta, no se ha tocado el
proyecto Gestor de Personal y Cuadrantes, no se han usado PDF reales ni datos
personales, no se ha habilitado ningún servicio de pago.

---

## Veredicto

> **LISTA PARA PRUEBAS CONTROLADAS** — en el servidor, con datos de prueba y sin
> usuarios reales. **NO LISTA para uso real** todavía: las reglas de Firestore
> siguen **sin ejecutarse** (0 de 41), la transacción real de subida no se ha
> probado contra Firestore y la restauración de copias no está ensayada.

Lo que cambia respecto a la Fase 5: los cuatro defectos que bloqueaban el uso
real —subida de PDF imposible por tamaño de transacción, acceso sin matrícula,
lectura sin límites, y confianza en datos del cliente— están **corregidos en
código y cubiertos por pruebas ejecutadas**. Lo que no cambia: la verificación
empírica contra Firestore real sigue pendiente por un bloqueo de red que este
entorno no puede resolver.

| Bloqueo de la Fase 5 | Estado en Fase 6 | Prueba que lo respalda |
| --- | --- | --- |
| 1. Subida de PDF > ~9 MiB fallaba siempre (27 fragmentos = 20,25 MiB > 10 MiB) | **Corregido**: tope 8 MiB = 11 fragmentos = 8,25 MiB + 512 KiB de margen | `tests/domain/pdf-chunks.test.ts`, `tests/server/document-service.test.ts` |
| 2. Alojamiento del servidor | **Sin decidir** (documentado en Fase 5; no es código) | — |
| 3. Sin exportación ni restauración probada | **Sin implementar** (sigue siendo requisito antes de uso real) | — |
| 4. Sin matriculación, sin límite de peticiones, lectura mejorable | **Implementado y probado en servidor** | `enrollment-service.test.ts`, `ratelimit.test.ts`, `document-service.test.ts` |
| 5. Corpus de PDF desconocido | **Sin datos** (no hay PDF reales; no se inventan) | — |
| 6. 36 pruebas de reglas sin ejecutar | **41 escritas, 0 ejecutadas**: la JVM ya funciona, el bloqueo es la descarga del emulador | §4 |

---

## 1. Qué se ha corregido (por requisito de la orden)

### A. PDF

| Defecto real | Corrección | Dónde |
| --- | --- | --- |
| 27 fragmentos de 768 KiB = 20,25 MiB no caben en la transacción de **10 MiB**: cualquier PDF de más de ~9 MiB fallaba | Tope **8 MiB** (`MAX_PDF_BYTES`), `MAX_CHUNKS = 11`, y `assertFitsTransaction()` calculado sobre 10 MiB con 512 KiB de margen | `src/domain/storage/pdf-chunks.ts` |
| No se comprobaba que el número de páginas fuera coherente con el tamaño | `assertPageCountFitsBytes()` y `assertPageCount()` antes de escribir | `pdf-chunks.ts`, `documents/service.ts` |
| Un fallo a mitad de la escritura podía dejar fragmentos huérfanos o contadores incorrectos | Se preparan todos los fragmentos antes de publicar; la escritura es **una transacción** (metadatos + 11 fragmentos + contador). Si algo falla, no se publica nada | `src/server/firebase/document-store.ts` |
| El presupuesto de cuota se comprobaba solo fuera de la escritura: dos subidas simultáneas podían superarlo | Doble comprobación: rápida en el servicio y **autoritativa dentro de la transacción**, con el contador leído en ella | `documents/service.ts` (línea ~180), `document-store.ts` |
| El error por tamaño era genérico | `PDF_TOO_LARGE` (413) con el máximo real en el mensaje; validación también en la entrada del formulario (`Content-Length` y tamaño del fichero) | `documents/request.ts` |

Pruebas ejecutadas (32 casos en `tests/server/document-service.test.ts` y 18 en
`tests/domain/pdf-chunks.test.ts`): archivo **vacío**, exactamente **8 MiB**
(aceptado, 11 fragmentos), **8 MiB + 1 byte** (rechazado con `PDF_TOO_LARGE`),
**fallo parcial** simulado en el fragmento 1 (sin metadatos, sin fragmentos,
sin cuota consumida), **concurrencia** de dos subidas contra el mismo
presupuesto (una pasa, la otra recibe `STORAGE_BUDGET_EXCEEDED`, el contador
queda en 700 KiB y no 1400), **documento duplicado** que no se sobrescribe,
**documento corrupto** que no devuelve bytes a medias, y **cuota** (archivar
libera espacio y deja de servir el documento).

### B. Autorización y matrícula

Modelo nuevo: `enrollments/{uid}_{courseId}` con `status: "active" | "revoked"`.

- `isEnrollmentActive()` exige literalmente `"active"`: `"revoked"`, ausente,
  `null` o un estado inventado **deniegan** (`src/domain/courses/enrollment.ts`).
- `assertCourseAccess(actor, courseId, deps)` es la única puerta de acceso al
  contenido, y `hasCourseAccess` devuelve `false` para un actor no activo
  (cinturón y tirantes sobre `requireActor`).
- **Publicar no da acceso**: un curso publicado sin matrícula devuelve 403
  `COURSE_NOT_AUTHORIZED`; el mensaje es idéntico para un curso inexistente
  (no permite enumerar).
- El **rol de administrador se comprueba en el servidor** (`assertAdmin` sobre
  el actor de la sesión). El cuerpo de la petición no puede conceder permisos;
  hay una prueba que envía `{ role: "admin", isAdmin: true }` en el cuerpo y
  recibe 403.
- Matricular es **idempotente** (conserva `enrolledAt` original); revocar **no
  borra el progreso** y reactivar lo retoma.
- Endpoints: `POST /api/admin/enrollments` (`enroll` | `revoke`) y
  `GET /api/admin/enrollments?courseId=|uid=`, ambos solo para administración.
- Reglas de Firestore: bloque `enrollments` (lectura propia o administrador,
  escritura cerrada), versiones de curso solo para matriculados, y metadatos de
  `documents` solo si hay matrícula activa en el curso del documento.

20 casos en `tests/server/enrollment-service.test.ts` y 11 en
`tests/domain/enrollment.test.ts`.

### C. Protección del PDF

`GET /api/documents/{documentId}/pages?from=&to=` sustituye a la antigua
`/window` (eliminada). Barreras, todas en servidor:

1. sesión válida y cuenta activa (`requireActor`, `assertActiveAccount`);
2. documento existente y no archivado;
3. **matrícula activa** en el curso (`assertCourseAccess`) y versión publicada
   igual a la del documento;
4. rango entero, no invertido, ≤ **20 páginas** y dentro del documento;
5. secuencia: `from` debe ser **exactamente** la página siguiente a la última
   vista (`PAGE_OUT_OF_ORDER`, 409);
6. progreso se guarda **solo después de leer** con éxito, y con `archive` si
   cambió la versión;
7. límite por usuario y global (coste = páginas pedidas);
8. errores traducidos sin contenido ni detalles internos
   (`INTERNAL_ERROR` genérico; el log del servidor conserva el detalle).

El examen final no se puede desbloquear antes: `recordFinalExamAttempt` exige
todos los temas obligatorios aprobados también en el dominio, no solo en el
servicio. El cliente **no** puede enviar página, progreso ni APTO: una prueba
manda esos campos y el servicio los ignora (`PAGE_OUT_OF_ORDER`).

Pruebas: 32 casos de servicio + 11 de contrato del endpoint
(`document-pages-endpoint.test.ts`, incluida la ausencia del fichero
`window/route.ts` y las cabeceras `no-store`/`nosniff`).

### D. Persistencia y evaluación

Sin cambios de diseño (lo de fases anteriores se ha conservado); se refuerza el
acceso y se añaden las pruebas que faltaban:

- la corrección sigue siendo **en servidor** y las soluciones no viajan al
  navegador (`answerKeys` nunca legible desde el cliente);
- **repetir cuestionarios**: permitido; los intentos se acumulan, el APTO no se
  pierde aunque después se falle, y `bestScore` conserva el mejor;
- **todos los temas obligatorios** antes del examen final; los opcionales se
  corrigen pero no cuentan;
- **cambio de versión**: archiva el progreso anterior (`progressHistory`) y
  reinicia; tras el cambio hay que volver a leer el tema;
- **aislamiento usuario/curso**: sin matrícula no se evalúa, la matrícula de
  otro curso no sirve y una revocación a mitad de curso cierra la evaluación.

5 casos nuevos en `tests/server/assessment-service.test.ts` (24 en total).

---

## 2. Límites de petición (coste cero)

`src/server/ratelimit/limiter.ts`: ventana deslizante en memoria, reloj
inyectable.

| Uso | Por usuario | Global | Ventana |
| --- | --- | --- | --- |
| Lectura de páginas (coste = páginas) | 600 | 6 000 | 1 hora |
| Subida de PDF | 20 | 120 | 1 hora |

Motivo concreto: con 50 000 lecturas/día y ~7 000 descargas de un PDF de 5 MiB
se agota la cuota y **el producto entero se apaga** hasta medianoche del
Pacífico. Un solo alumno podía provocarlo.

**Límite honesto:** es por proceso. Con varias instancias, el tope efectivo se
multiplica por el número de instancias; el día que haya más de una hay que
mover el contador a un almacén compartido. Con el despliegue previsto (un
servidor propio) es suficiente.

12 casos en `tests/server/ratelimit.test.ts`.

---

## 3. Batería ejecutada

Comandos, tal cual, y resultado obtenido hoy en este entorno:

```
npx tsc --noEmit        → 0 errores
npm run lint            → 0 errores, 0 avisos
npx vitest run          → 26 ficheros, 440 pruebas, 0 fallos
npm run build           → OK (14 rutas, incluida /api/admin/enrollments
                          y /api/documents/[documentId]/pages)
npm run verify          → exit 0
```

`npm run verify` encadena typecheck + lint + test + build.

Antes: 22 ficheros / 370 pruebas (Fase 4). Ahora: **26 ficheros / 440
pruebas**. Ficheros nuevos: `tests/domain/enrollment.test.ts`,
`tests/server/enrollment-service.test.ts`, `tests/server/ratelimit.test.ts`,
`tests/server/document-pages-endpoint.test.ts`. Reescrito:
`tests/server/document-service.test.ts` (de 21 a 32 casos).

Pruebas de reglas: **41 escritas, 0 ejecutadas**. El recuento subió de 36 a 41
con los casos de matrícula y de contenido por matrícula.

Además se corrigen tres pruebas que se habían quedado desfasadas respecto al
código (no se "ablandan": se ajustan a la nueva verdad y en un caso descubren un
defecto real):

- inventario de rutas: 8 → 9 (`pages` sustituye a `window`, aparece
  `admin/enrollments`);
- `readDocumentWindow` → `readDocumentPages`, y ahora se exige que la lectura
  llame también a `assertCourseAccess`;
- PDF máximo: 20 MiB / 27 fragmentos → 8 MiB / 11 fragmentos, con la
  comprobación aritmética de la transacción.

**Defecto encontrado por las pruebas durante esta fase:** `readPagesQuery`
aceptaba `from=` vacío como `0` (`Number("") === 0`). Corregido: un parámetro
vacío se rechaza con 400 en lugar de llegar al servicio como página 0.

---

## 4. Desbloqueo del emulador: intentado y no conseguido

Lo que **sí** se resolvió: no había JVM, y era el motivo declarado en las fases
2–5. Se descargó el wheel `jdk4py` desde PyPI (sin instalar nada en el
ordenador del usuario, sin `sudo`, sin apt), se extrajo en `/tmp` y se dio
permiso de ejecución a los binarios (vienen sin él):

```
java -version → openjdk version "25.0.2" 2025-07-15
```

Lo que **no** se resolvió: el emulador de Firestore. `firebase emulators:exec`
descarga `cloud-firestore-emulator-v1.22.0.jar` de
`storage.googleapis.com/firebase-preview-drop/emulator/…` y la descarga falla
antes del TLS:

```
curl -sSI https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.22.0.jar
curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to storage.googleapis.com:443
```

Se buscó un espejo público del jar (búsqueda de código en GitHub, npm): no
existe uno utilizable. No se ha sustituido el emulador por un evaluador de
terceros, porque un evaluador distinto **no prueba** las reglas de Firestore.

Conclusión: **el bloqueo ya no es la JVM, es la red de este entorno**. Las
reglas nuevas están escritas para que el emulador las evalúe
(`npm run test:rules`), pero aquí no se ha ejecutado ni una. No se declara
"probado" lo que no se ha ejecutado.

---

## 5. Riesgos: corregidos y restantes

### Corregidos en esta fase

| Riesgo | Cómo queda |
| --- | --- |
| Subida de PDF grande imposible | Tope coherente con la transacción, con prueba en el límite exacto |
| Alumno de un curso leyendo otro | Matrícula obligatoria, comprobada en servidor |
| Publicar = acceso | Publicar solo publica; el acceso lo da la matrícula |
| Un alumno agota la cuota y apaga la aplicación | Límites por usuario y globales (con la salvedad de "por proceso") |
| Cliente decidiendo página, progreso o APTO | El servidor solo acepta `from`/`to`; el resto lo calcula él |
| Saltarse la secuencia de lectura | `PAGE_OUT_OF_ORDER` si `from` no es exactamente la siguiente |
| Fragmentos huérfanos / contador incorrecto | Escritura todo-o-nada en una transacción y presupuesto dentro de ella |
| Errores con detalles internos al cliente | `INTERNAL_ERROR` genérico; el detalle solo en el log del servidor |

### Restantes (declarados, no maquillados)

1. **Reglas de Firestore sin ejecutar** (0 de 41). Es el riesgo más importante
   que queda: el código y las reglas podrían no coincidir y no lo sabríamos.
2. **Transacción real sin ejecutar** contra Firestore: que 8,25 MiB quepan en
   los 10 MiB es aritmética sobre un límite documentado, no una medición.
3. **Límite de peticiones por proceso**: se multiplica con varias instancias.
4. **Sin UI de matrícula**: hoy se matricula por API (`POST
   /api/admin/enrollments`). Un administrador sin consola no puede matricular
   desde el panel.
5. **Sin exportación/restauración probada**: en Spark no hay backups nativos;
   hay que hacer export con Admin SDK y **ensayar la restauración** en un
   proyecto desechable.
6. **Cuota de salida de red (10 GiB/mes)**: el límite real no son las lecturas,
   es el egreso. 100 PDF de 5 MiB lo superan y el proyecto **se apaga** hasta
   el mes siguiente. Los límites de peticiones lo hacen menos probable, no
   imposible.
7. **DRM inexistente**: un alumno con matrícula puede reconstruir el PDF
   guardando las páginas que recibe en orden.

---

## 6. Requisitos antes de uso real

Ninguno exige pagar; todos exigen trabajo o una decisión:

1. **Ejecutar `npm run test:rules`** en un equipo con salida a
   `storage.googleapis.com` (o con el jar del emulador ya en caché) y corregir
   cualquier discrepancia. Es la condición número uno.
2. **Probar la subida real** de un PDF de ~8 MiB contra un proyecto de pruebas
   y comprobar con `db:check` que el contador de cuota es correcto.
3. **Decidir el alojamiento** (Fase 5): servidor propio o plan gratuito que
   permita uso comercial. Vercel Hobby **no** vale (prohíbe uso comercial,
   incluido el del empleado que escribió el código); Netlify Free lo permite con
   300 créditos/mes y suspensión al agotarlos; Render free duerme a los 15 min.
4. **Escribir y ensayar la exportación/restauración**: export cifrado con Admin
   SDK fuera de la máquina, y una restauración cronometrada en un proyecto
   desechable, **sin datos reales**.
5. **Panel de matrícula** (una pantalla para matricular/revocar por curso) o
   procedimiento documentado para hacerlo por API.
6. **Fijar el corpus** (≤ ~512 MiB, comprimido) y vigilar el egreso mensual.

---

## 7. Coste cero: lo que se puede y no se puede afirmar

No se declara "coste cero garantizado". Lo correcto es:

- **No hace falta pagar** para desarrollar, probar ni para el diseño actual:
  plan Spark, sin Storage, sin Functions, sin tarjeta.
- **No se ha habilitado** ningún servicio de facturación, ni cuenta nueva, ni
  tarjeta.
- **El coste puede dejar de ser cero** si se superan las cuotas gratuitas: al
  agotar la cuota diaria el producto falla hasta medianoche del Pacífico; al
  agotar la mensual (o el egreso de 10 GiB) se apaga. Recuperarlo exige esperar
  o pasar a Blaze (pago).
- **Exportaciones, backups gestionados, PITR y TTL exigen Blaze**: por eso la
  copia de seguridad hay que construirla a mano.
- Las cuotas de los proveedores cambian sin avisar: cada cifra de este informe
  es de 21/10/2026 y hay que reconfirmarla antes de firmar el diseño.

---

## 8. Cambios, fichero a fichero

**Dominio y almacenamiento**

- `src/domain/storage/pdf-chunks.ts` — tope 8 MiB, 11 fragmentos,
  `MAX_TRANSACTION_BYTES` (10 MiB), `TRANSACTION_SAFETY_BYTES` (512 KiB),
  `assertFitsTransaction`, `pageRange`, `assertPageCountFitsBytes`.
- `src/domain/courses/enrollment.ts` **(nuevo)** — `enrollmentDocId`,
  `isEnrollmentActive`, `assertValidEnrollment`, `assertEnrollmentSegment`.

**Servicios**

- `src/server/documents/service.ts` — subida transaccional con presupuesto,
  `readDocumentPages` (sustituye a la lectura por ventanas), `archivePdfDocument`.
- `src/server/enrollments/{store,service}.ts` **(nuevos)** — puerto y servicios
  de matrícula, `assertCourseAccess`.
- `src/server/ratelimit/limiter.ts` **(nuevo)** — `SlidingWindowLimiter` y
  límites configurados.
- `src/server/learning/progress-loader.ts` **(nuevo)** — carga de progreso
  compartida por documentos y evaluaciones, devuelve también el archivo cuando
  cambia la versión.
- `src/server/assessments/service.ts` — exige matrícula y usa el cargador común.

**Firebase y datos**

- `src/server/firebase/enrollment-store.ts` **(nuevo)**; `document-store.ts`
  (transacción con presupuesto), `learning-store.ts` (`saveProgress(progress, archive)`).
- `src/server/db/schema.constants.ts` — `enrollments` en `COLLECTIONS`,
  `CLIENT_READABLE_COLLECTIONS` y `ROOT_COLLECTIONS`.
- `firestore.rules` — matrícula, versiones y documentos por matrícula.
- `firestore.indexes.json` — índice compuesto `enrollments (uid, courseId)`.

**HTTP**

- `src/app/api/documents/[documentId]/pages/route.ts` **(nuevo; elimina
  `window/route.ts`)**.
- `src/app/api/admin/enrollments/route.ts` **(nuevo)**.
- `src/server/documents/request.ts` — `readPagesQuery` (y rechazo de vacíos).
- `src/server/deps.ts` — `enrollmentDependencies()`, limitadores.

**Pruebas y documentación**

- `tests/helpers/enrollment-double.ts` **(nuevo)**; `document-double.ts`
  (presupuesto, `failOnChunk`, `chunkCount`).
- Los cuatro ficheros de prueba nuevos y los reescritos de §3.
- `docs/MODELO-DATOS.md`, `docs/ARQUITECTURA.md`, `docs/SEGURIDAD.md`,
  `docs/PRUEBAS.md` (§11), `docs/DECISIONES.md` (ADR-015, ADR-016), `README.md`.

**Sin tocar**: proyecto Gestor de Personal y Cuadrantes, scripts de
importación/activación (salvo el efecto de la matrícula, que es de acceso), ni
configuración de despliegue.

---

## 9. Resumen ejecutivo

La Fase 6 cierra los defectos que impedían probar el producto: la subida de PDF
ya cabe en una transacción (8 MiB, 11 fragmentos, con margen), el acceso exige
matrícula explícita y no depende de que un curso esté publicado, la lectura de
PDF está autorizada por curso, ordenada y limitada, y ninguna decisión sensible
se toma con datos del cliente. Todo eso está cubierto por pruebas que **sí se
han ejecutado**: `npm run verify` termina con **exit 0**, 26 ficheros y **440
pruebas en verde**, build de producción correcto.

Lo que no se ha conseguido: ejecutar las **41 pruebas de reglas**. La JVM ya no
es el obstáculo (se resolvió sin instalar nada), pero el emulador no se puede
descargar desde este entorno. Tampoco se ha medido la transacción real contra
Firestore ni se ha ensayado una restauración de copias.

Veredicto: **LISTA PARA PRUEBAS CONTROLADAS** con datos de prueba; **NO LISTA
para uso real** hasta que las reglas se ejecuten, la subida se pruebe contra
Firestore y exista un procedimiento de restauración probado. No se declara el
coste cero como garantizado: no hace falta pagar para lo previsto, pero superar
las cuotas gratuitas apaga el producto hasta el mes siguiente.
