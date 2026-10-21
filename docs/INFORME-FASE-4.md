# Informe de la fase 4 — coste cero (plan Spark, sin Firebase Storage)

**Fecha:** 21 de octubre de 2026
**Rama:** `arena/89a0aca0-formacion-u-s` (base `c4ce33d`, sin commits nuevos)
**Estado:** completado en lo que se puede ejecutar aquí. **Dos bloqueos
externos** siguen abiertos: no hay proyecto Firebase y el emulador no arranca
(falta JVM). Nada de esta fase se ha ejecutado contra Firestore real.

---

## Resumen ejecutivo

| Requisito de la orden | ¿Hecho? |
| --- | --- |
| Inspeccionar antes de tocar; no rehacer lo que funciona | **Sí** — se reutiliza todo el dominio y los servicios de fase 3 |
| Eliminar la dependencia obligatoria de Storage | **Sí** — no queda bucket, ni reglas, ni variables, ni SDK |
| PDF privados fragmentados en Firestore, solo desde el servidor | **Sí** — implementado y probado con dobles en memoria |
| No exponer PDF, claves ni credenciales por enlaces públicos | **Sí** — sin rutas en el contenido público, sin URLs firmadas |
| Mantener corrección en servidor, progreso y permisos por rol | **Sí** — intactos; sin cambios de comportamiento |
| No habilitar Blaze, no desplegar, no importar datos | **Sí** — no se ha creado ni tocado ningún recurso |
| Ejecutar `npm run verify` y distinguir pruebas bloqueadas | **Sí** — `exit 0`, 370 pruebas; reglas: 0 de 36 |

**Respuesta corta a la pregunta de viabilidad:** sí es viable, con dos
condiciones que hay que aceptar por escrito: (1) el corpus completo de PDF debe
caber en ~512 MiB y (2) el uso diario debe quedarse dentro de 50 000 lecturas y
10 GiB de salida al mes. Si el corpus real supera eso, la alternativa **no** es
subir de plan: es archivar, comprimir o mover los PDF a un almacenamiento
externo gratuito, lo que añade otra cuenta y otro proveedor (ver §6).

---

## 1. Qué había y qué se ha hecho

### 1.1 Inspección previa

Antes de tocar nada se comprobó qué dependía realmente de Storage:

| Punto | Situación encontrada |
| --- | --- |
| `src/server/firebase/admin.ts` | `getStorage()` y `storageBucket` en `initializeApp` |
| `src/server/config.ts` | `FIREBASE_STORAGE_BUCKET` (opcional) y host de emulador |
| `src/domain/storage/paths.ts` | rutas `courses/.../vN/topics/.../{doc}.pdf`, TTL de URL firmada |
| `src/server/courses/catalog.ts` | el **contenido público** incluía `storagePath` |
| `storage.rules`, `firebase.json` | reglas de bucket, emulador de Storage (puerto 9199) |
| `package.json` | `test:rules` y `emulators` arrancaban Storage |
| `.env.example` | `FIREBASE_STORAGE_BUCKET`, `FIREBASE_STORAGE_EMULATOR_HOST` |
| Endpoints | **ninguno** subía ni servía PDF: la dependencia era de diseño y configuración, no de código en producción |

Ese último punto es la clave de que la migración sea barata: no había que
reescribir pantallas ni endpoints, porque todavía no existen.

**No se ha tocado**: dominio de evaluación (`grading`, todo o nada), progreso
(`course-progress`, `reading`), versionado, roles, sesión, importación de
Excel, activación, auditoría ni ninguna pantalla.

### 1.2 Cambios

**Nuevo — almacenamiento fragmentado**

| Fichero | Qué hace |
| --- | --- |
| `src/domain/storage/pdf-chunks.ts` | troceado, límites, validación `%PDF-`, presupuesto |
| `src/server/documents/store.ts` | puerto `PdfDocumentStore` |
| `src/server/documents/service.ts` | subida, lectura por ventanas, cuota, archivado |
| `src/server/documents/request.ts` | lectura del formulario multipart y de la query |
| `src/server/firebase/document-store.ts` | adaptador Firestore con transacción y contador |
| `src/app/api/admin/documents/route.ts` | `POST` sube (admin), `GET` informa de cuota (admin) |
| `src/app/api/documents/[documentId]/window/route.ts` | `GET` ventana de bytes (cuenta activa) |

**Eliminado**

- `src/domain/storage/paths.ts` (rutas de Storage y firma).
- `storage.rules` y el bloque `storage` de `firebase.json`; emulador de Storage
  fuera de `package.json`.
- `getStorage()` y `storageBucket` de `admin.ts`.
- `FIREBASE_STORAGE_BUCKET` y `FIREBASE_STORAGE_EMULATOR_HOST` de
  `.env.example`.
- `storagePath` del contenido público: un curso publicado ya no contiene
  ninguna ubicación de fichero (ni ruta, ni `gs://`, ni URL).

**Modificado**

- `src/server/db/schema.constants.ts`: nueva colección `pdfChunks`, marcada
  como solo-servidor.
- `firestore.rules`: `pdfChunks` cerrado a todo cliente; comentarios de
  `documents` y `meta` actualizados. **No se ha podido compilar** (sin JVM).
- `src/server/db/checks.ts` + `scripts/db-check.ts`: auditoría del contador de
  cuota frente a la suma real; índice nuevo en la prueba de consultas.
- `scripts/db-init.ts`: crea `meta/storage` con `usedBytes: 0` solo si no existe
  (sobrescribirlo haría que la siguiente subida ignorase lo ya guardado).
- `src/server/config.ts` + `.env.example`: `PDF_STORAGE_BUDGET_MB` (512 por
  defecto, acotado a 896 MiB como máximo).
- `src/server/deps.ts`: cableado de `documentDependencies()`.
- Tests, documentación y `README`.

### 1.3 Cómo funciona ahora un PDF

```
ADMINISTRADOR                                    ALUMNO
POST /api/admin/documents (multipart)            GET /api/documents/{id}/window?from=&to=
  · origen de confianza + sesión + rol admin        · sesión + cuenta activa
  · firma %PDF- en los primeros 1 KiB               · documento existente y no archivado
  · tamaño ≤ 20 MiB, páginas 1..5000                · versión publicada (o admin)
  · cuota: usedBytes + size ≤ presupuesto           · ventana ≤ 768 KiB
  · SHA-256 del fichero                            · lee solo los fragmentos necesarios
  · 27 fragmentos como Bytes en UNA transacción     · responde bytes con no-store
```

Decisiones que importan:

- **`Bytes`, no base64.** Un fragmento de 768 KiB en base64 ocuparía exactamente
  1 MiB y no cabría el envoltorio del documento. Hay una prueba que fija esa
  relación para que nadie la "mejore" a base64.
- **Contador dentro de la transacción.** Dos subidas simultáneas no pueden pasar
  ambas la comprobación de cuota. `db:check` detecta si el contador se separa de
  la realidad (±1 KiB de tolerancia).
- **Una transacción de 29 escrituras** (27 fragmentos + metadatos + contador),
  muy por debajo del límite de 500 por transacción.
- **El cliente nunca ve el fichero entero** en una respuesta: solo ventanas.
- **Archivar libera cuota** sin borrar el documento de metadatos, y deja de
  servirse de inmediato.

---

## 2. Límites de almacenamiento aplicados

| Concepto | Valor | Por qué |
| --- | --- | --- |
| Máximo por documento de Firestore | 1 MiB (1 048 576 B) | límite de la plataforma |
| Fragmento | **768 KiB** | deja ~256 KiB de margen |
| Fragmentos por PDF | 1 a **27** | 20 MiB / 768 KiB |
| Máximo por PDF | **20 MiB** | evita un único fichero que consuma toda la cuota |
| Ventana máxima por petición | 768 KiB | una petición = 1 fragmento |
| Escrituras por transacción | 29 | límite: 500 |
| Presupuesto por defecto | **512 MiB** | ~50 % de la cuota |
| Reserva intocable | 128 MiB | cuentas, progreso, intentos, cursos |
| Presupuesto máximo configurable | 896 MiB | 1 GiB − reserva |
| Documentos que caben | 25 de 20 MiB, ~100 de 5 MiB, ~500 de 1 MiB | con 512 MiB |

Si una subida no cabe: **507 `STORAGE_BUDGET_EXCEEDED`**, sin escribir nada. No
hay recorte silencioso ni subida parcial.

---

## 3. Cuotas gratuitas relevantes (plan Spark)

Cifras publicadas por Google para Firestore en Spark. **Pueden cambiar**: son
una condición externa, no una garantía del código. Conviene comprobarlas en la
consola antes de dar el diseño por definitivo.

| Recurso | Cuota gratuita | Qué supone aquí |
| --- | --- | --- |
| Almacenamiento | **1 GiB** (compartido con cuentas, progreso, intentos, cursos) | presupuesto de 512 MiB para PDF |
| Lecturas de documento | **50 000 / día** | un PDF de 5 MiB = 7 fragmentos = 7 lecturas |
| Escrituras | **20 000 / día** | subir 5 MiB = 7 fragmentos + 2 documentos = 9 escrituras |
| Borrados | 20 000 / día | archivar documentos antiguos |
| Salida de red | **10 GiB / mes** | un PDF de 5 MiB leído entero = 5 MiB de salida |
| Cloud Storage | **no incluido** (requiere Blaze) | motivo de esta fase |
| Cloud Functions | **no incluido** | el servidor Next debe ejecutarse fuera de Firebase |
| Copias de seguridad gestionadas | requieren bucket (Blaze) | **bloqueo abierto**, ver §7 |

Traducido a uso real:

- **Lecturas:** 50 000/día ÷ 7 ≈ **7 100 lecturas completas de un PDF de 5 MiB
  al día**. Con un visor que pide ventanas de una página en lugar del fichero
  entero, el consumo baja bastante.
- **Escrituras:** 20 000/día ÷ 9 ≈ **2 200 subidas de 5 MiB al día**.
- **Salida:** 10 GiB/mes ÷ 5 MiB ≈ **2 000 descargas completas al mes**. Es la
  cuota más ajustada si hay muchos alumnos leyendo lo mismo; el visor por
  ventanas la reparte, no la reduce.
- **Almacenamiento:** es la cuota que de verdad manda. 512 MiB de PDF es el
  techo práctico del proyecto en Spark.

**Aviso de honestidad sobre el "coste cero":** Firebase Spark cubre
Firestore y Auth, pero **no** el alojamiento del servidor Next.js. Dónde se
despliegue esa parte (y si es gratuito) sigue sin decidirse; no lo he asumido en
ningún punto de este informe.

---

## 4. Seguridad: qué se garantiza y qué no

**Garantizado por el diseño (y probado con dobles en memoria):**

- No hay bucket, luego no hay URL firmada, ni enlace permanente, ni permiso de
  portador que compartir. El riesgo R4 de la fase 2 queda cerrado.
- `pdfChunks` está cerrado a todo cliente, también al administrador. Conocer
  `documento_3` no sirve de nada sin pasar por el servidor.
- El contenido público de un curso no contiene rutas ni identificadores de
  almacenamiento (hay prueba que revisa las claves exactas del objeto).
- La subida exige administrador **activo**; la lectura exige cuenta **activa** y
  versión **publicada** (un alumno no lee borradores; un administrador sí).
- Ni credenciales ni PDF en el repositorio: `.env*` sigue ignorado y el binario
  no está en git (los tests generan PDF sintéticos en memoria).
- `Cache-Control: no-store`, `nosniff` y `Content-Disposition: inline` en la
  respuesta del PDF.
- Corrección en servidor, progreso persistente y permisos por rol: **sin
  cambios**, y sus pruebas siguen en verde (19 de evaluación, 17 de catálogo).

**No garantizado (y no se afirma):**

- **No es DRM.** Un alumno activo con el curso publicado puede descargar las
  ventanas que va pidiendo y reconstruir el PDF. Esto ya era cierto con las
  URLs firmadas; la diferencia es que ahora no hay enlace que compartir.
- Las reglas nuevas **no se han compilado**: 0 de 36 pruebas ejecutadas.
- La transacción de escritura **no se ha ejecutado** contra Firestore. La
  atomicidad real está argumentada, no demostrada.
- Que Firestore acepte 768 KiB de `Bytes` por documento se deduce del límite
  documentado de 1 MiB; **no se ha medido aquí**.

---

## 5. Verificación

`npm run verify` → **exit 0**: TypeScript 0 errores, ESLint 0 avisos,
**370 pruebas / 22 ficheros**, build de producción correcto.

Pruebas nuevas y modificadas:

| Fichero | Casos | Cambio |
| --- | --- | --- |
| `tests/domain/pdf-chunks.test.ts` | 18 | **nuevo**: troceado, límites, firma, presupuesto |
| `tests/server/document-service.test.ts` | 21 | **nuevo**: subida, lectura, cuota, archivado, roles |
| `tests/helpers/document-double.ts` | — | **nuevo**: almacén en memoria con las invariantes reales |
| `tests/server/schema-drift.test.ts` | 15 | +3: sin Storage, `pdfChunks` cerrado, docs al día |
| `tests/server/endpoint-authorization.test.ts` | 13 | +1 ruta auditada, +1 servicio con `assertAdmin` |
| `tests/domain/storage-and-courses.test.ts` | 14 | −4: rutas de Storage eliminadas |
| `tests/rules/firestore.rules.test.ts` | 36 | +2 (`pdfChunks`), −10 (Storage eliminado) |
| `tests/rules/storage.rules.test.ts` | — | **eliminado** (no hay bucket) |

**Pruebas ejecutadas de verdad contra el servidor HTTP** (modo desarrollo con
los emuladores *configurados*, sin emulador levantado):

| Petición | Resultado |
| --- | --- |
| `GET /api/documents/doc-1/window?from=0&to=10` sin sesión | **401 UNAUTHENTICATED** |
| `GET /api/admin/documents` sin sesión | **401 UNAUTHENTICATED** |
| `POST /api/admin/documents` sin sesión, origen correcto | **401 UNAUTHENTICATED** |
| `POST /api/admin/documents` con `Origin: https://evil.example` | **403 ORIGIN_FORBIDDEN** |
| Todo lo anterior sin configuración | **503 SERVER_NOT_CONFIGURED** (falla cerrado) |

**Bloqueado:** `tests/rules/**` → 36 escritas, **0 ejecutadas** (sin JVM). Sin
proyecto Firebase, tampoco hay despliegue ni comprobación de índices.

---

## 6. Alternativas evaluadas (instrucción 4 de la orden)

| Alternativa | Coste | Veredicto |
| --- | --- | --- |
| **Firebase Storage** (diseño original) | **Blaze + tarjeta** | **Descartada**: exige facturación, contra la orden |
| **PDF fragmentados en Firestore** | dentro de Spark | **Elegida**: única opción que no añade proveedores |
| Almacenamiento externo con capa gratuita (Cloudflare R2, Backblaze B2, Supabase Storage) | 10 GB / 10 GB / 1 GB gratis | **No implementada**: exige **otra cuenta y otro proveedor**, claves nuevas, CORS y, en R2, tarjeta. Añade una dependencia externa y una fuga de datos personales a un tercero. Queda como plan B si el corpus no cabe |
| Repositorio Git como almacén | gratis | **Descartada**: el PDF queda en el historial para siempre y es público o compartido; imposible de borrar de verdad |
| Solo enlaces a un servicio de terceros (Drive, Dropbox) | gratis | **Descartada**: enlaces públicos o cuentas personales; rompe el requisito de no exponer PDF |
| PDF cifrados por usuario | gratis | **No viable hoy**: multiplicaría el almacenamiento por alumno |
| Recortar el corpus / comprimir PDF | gratis | **Recomendado como medida operativa**, no como arquitectura |
| Convertir PDF a texto/HTML | gratis, ocupa poco | **No viable**: se pierde el documento original y el control de páginas |

Por qué **no** se ha migrado nada ni improvisado un almacén externo: la orden lo
prohíbe expresamente y, además, habría que decidir antes con datos reales
(cuántos cursos, cuántas páginas, qué tamaño medio).

---

## 7. Bloqueos y decisiones pendientes

1. **Sin proyecto Firebase** (`formacionus-63555` no está conectado): no se ha
   desplegado nada, ni reglas, ni índices. El plan Spark no se ha activado ni
   comprobado.
2. **Emulador no ejecutable**: falta JVM. Las 36 pruebas de reglas siguen sin
   ejecutarse; la regla de `pdfChunks` **no está compilada**.
3. **Copias de seguridad**: la exportación gestionada de Firestore escribe en un
   bucket de Storage (Blaze). En Spark habría que implementar una exportación
   propia (Admin SDK → JSON) o aceptar no tener copias. **No implementado**;
   decisión pendiente antes de cargar contenido real.
4. **Alojamiento del servidor Next**: el plan gratuito de Firebase no lo cubre.
   Sin decidir.
5. **Tamaño real del corpus**: sin los PDF reales no se puede confirmar que quepa
   en 512 MiB. Es el dato que decide si esta arquitectura es suficiente.
6. **Visor y lectura secuencial**: el endpoint de ventanas existe, pero el visor
   (PDF.js), el registro de página vista (`recordPageViewed`) y su endpoint son
   del siguiente bloque. Hoy un alumno puede pedir cualquier ventana de un PDF
   de un curso publicado; el control **secuencial** todavía no está aplicado en
   el servidor para PDF (sí está modelado en el dominio).
7. **Matriculación por curso**: no existe. Cualquier cuenta activa puede leer
   metadatos y ventanas de cualquier curso publicado (riesgo 5.7c, ya conocido).
8. **Cuotas de Google**: las cifras de §3 son las publicadas hoy y pueden
   cambiar. El diseño tiene un techo duro (1 GiB) que no depende de nosotros.

---

## 8. Siguiente bloque propuesto

1. Endpoint y servicio de **lectura de páginas** con `recordPageViewed`, para que
   la secuencialidad se aplique de verdad al PDF (hoy solo al progreso).
2. **Visor PDF.js** con peticiones por ventana y `no-store`.
3. Panel de administración: crear curso, subir PDF (con barra de cuota),
   publicar versión.
4. Endpoint `/api/assessments/submit` sobre `submitAssessment` (ya probado).
5. Con JVM y proyecto: `npm run test:rules`, `firebase deploy` y `db:check`
   reales; y decidir el plan de copias (§7.3).

---

## 9. Archivos tocados en esta fase

```
Nuevos
  src/domain/storage/pdf-chunks.ts
  src/server/documents/store.ts
  src/server/documents/service.ts
  src/server/documents/request.ts
  src/server/firebase/document-store.ts
  src/app/api/admin/documents/route.ts
  src/app/api/documents/[documentId]/window/route.ts
  tests/helpers/document-double.ts
  tests/domain/pdf-chunks.test.ts
  tests/server/document-service.test.ts
  docs/INFORME-FASE-4.md

Eliminados
  src/domain/storage/paths.ts
  storage.rules
  tests/rules/storage.rules.test.ts

Modificados
  src/server/firebase/admin.ts        (sin getStorage ni storageBucket)
  src/server/config.ts               (fuera bucket; PDF_STORAGE_BUDGET_MB)
  src/server/deps.ts                 (documentDependencies)
  src/server/courses/catalog.ts      (sin storagePath en lo público)
  src/server/firebase/catalog-store.ts
  src/server/db/schema.constants.ts  (pdfChunks)
  src/server/db/checks.ts            (auditoría de cuota)
  src/server/firebase/repositories.ts (guard exportado)
  scripts/db-init.ts                 (meta/storage)
  scripts/db-check.ts                (contador + consulta de índices)
  firestore.rules                    (pdfChunks cerrado)
  firebase.json                      (sin storage)
  package.json                       (emuladores solo Firestore)
  .env.example                       (sin bucket; presupuesto)
  docs/{MODELO-DATOS,ARQUITECTURA,DECISIONES,SEGURIDAD,PRUEBAS,PLAN,INFORME-FASE-3}.md
  README.md
  tests/{server,domain}/…             (ver §5)
```

Sin commits, sin push, sin PR, sin despliegue y sin tocar la aplicación antigua:
todo está en el árbol de trabajo de `arena/89a0aca0-formacion-u-s`.
