# Modelo de datos

Firestore en **modo producción** (reglas explícitas, no modo prueba).
Todo lo escribe el servidor; el cliente solo lee lo que le corresponde.

## 1. Colecciones

### `accounts/{uid}` — cuenta de usuario

| Campo | Tipo | Notas |
| --- | --- | --- |
| `uid` | string | Igual al UID de Firebase Auth |
| `username` | string | `rol1.garcia`; único mediante `usernames/{username}` |
| `authEmail` | string | Sintético: `username@formacion.invalid` (TLD reservado) |
| `apellido` | string \| null | Tal cual se muestra; normalizado |
| `personRol` | `"ROL 1"` \| `"ROL 2"` \| null | Dato descriptivo, **no** permiso |
| `role` | `"admin"` \| `"learner"` | Permiso real. Nunca lo fija la importación |
| `status` | `pending_activation` \| `active` \| `disabled` | Fuente de verdad de la sesión |
| `claimsVersion` | number | Se incrementa al cambiar rol/estado → invalida tokens |
| `createdAt`, `createdBy` | string | Trazabilidad de la importación |
| `activatedAt`, `disabledAt` | string \| null | Ciclo de vida |

**Invariante:** `role`/`status`/`claimsVersion` solo cambian con Admin SDK.

### `usernames/{username}` — reserva de unicidad

`{ uid, reservedAt, reservedBy }`. Se crea en transacción antes de la cuenta de
Auth; si la creación falla, se elimina. Evita que dos importaciones simultáneas
generen el mismo usuario.

### `activationTokens/{sha256(token)}` — activación

| Campo | Tipo |
| --- | --- |
| `uid` | string |
| `createdAt`, `expiresAt` | ISO string (72 h) |
| `usedAt`, `revokedAt` | ISO string \| null |

El token en claro **no se almacena** (256 bits, base64url). El id del documento
es su hash.

### `courses/{courseId}` — curso

`{ courseId, title, description?, publishedVersion: number | null, lastDraftVersion: number | null, createdAt, createdBy, updatedAt }`

Los dos punteros se leen juntos y significan cosas distintas:

- `publishedVersion`: la versión visible para el alumnado. `null` ⇒ el curso no
  aparece en el catálogo y nadie puede matricularse en él.
- `lastDraftVersion`: la última versión guardada como borrador (aunque nunca se
  publique). Sirve para reanudar la edición. Al publicar se pone a `null`:
  publicar **consume** el borrador, y el puntero nunca apunta a una versión que
  ya no es editable.

**Un curso recién creado tiene los dos a `null`**: existe la ficha y no existe
ninguna versión. Es un estado válido y deliberado: crear no exige contenido ni
publicación, y no se inventa una versión vacía para «poder empezar».

Crear es **una sola escritura** (`create()`, no `set()`): atómica por sí misma y
sin posibilidad de sobrescribir un curso existente, que perdería su historial.
La segunda petición con el mismo identificador recibe `COURSE_ALREADY_EXISTS`
(409).

### `courses/{courseId}/versions/{n}` — versión inmutable

```
{
  courseId, version: number,
  status: "draft" | "published" | "archived",
  revision?: number,                 // solo la usan los borradores
  title, description: string | null,
  topics: [
    { id, title, order, mandatory,
      documents: [{ id, title, pageCount }],
      quiz: [{ id, type, optionIds, prompt }]   // SIN respuestas
    }
  ],
  finalExam: [{ id, type, optionIds, prompt }],
  createdAt, createdBy, publishedAt: string | null, publishedBy: string | null
}
```

**Invariante:** una versión publicada no se edita. Cambiar contenido = nueva
versión (y repetir curso).

`revision` es la **concurrencia optimista del borrador**: empieza en 1, se
incrementa en cada guardado y el editor exige la que tenía abierta. Guardar con
una revisión vieja devuelve `DRAFT_STALE` (409) en lugar de pisar el trabajo de
otra pestaña. Una versión publicada o archivada no se puede modificar de ninguna
forma (`VERSION_NOT_EDITABLE`, 409), y su `revision` deja de tener sentido.

`topics[].documents` solo guarda la **referencia** (identificador, título y
páginas): el PDF vive en `documents/{documentId}`, fuera de la versión.

**Coherencia con la ficha (transacción).** `courses.lastDraftVersion` y la
propia versión se escriben en la **misma** transacción al abrir un borrador:

- si la ficha cambió desde que se leyó ⇒ `DRAFT_CONFLICT` (409) y no se escribe
  nada, de modo que dos administradores no crean dos borradores;
- si la versión ya existía y es un borrador ⇒ se **adopta** fijando solo el
  puntero (datos anteriores al campo `lastDraftVersion`);
- si existía y no es un borrador ⇒ `VERSION_ALREADY_EXISTS` (409).

Nunca queda una versión huérfana ni un puntero a una versión inexistente, y un
reintento tras un fallo de red no duplica nada: la segunda pasada ve la ficha ya
actualizada y **reanuda** el borrador.

### `answerKeys/{courseId}_{version}_{assessmentId}` — claves de corrección

```
{ courseId, version, createdAt,
  quizByTopic: { [topicId]: [{ id, correctOptionIds }] },
  finalExam: [{ id, correctOptionIds }] }
```

Reglas: `allow read, write: if false`. Ni siquiera el administrador las lee
desde el cliente: las usa el servidor para corregir.

Un borrador puede **no tener** documento de claves: una versión nueva sin
preguntas no tiene nada que corregir. El servidor lo trata como «sin claves»
(`null`), no como error, y la definición se reconstruye igual; publicar seguirá
exigiendo las claves que correspondan al contenido.

**Editar cuestionarios escribe aquí, no en la versión.** Al guardar, el
contenido (`versions/{n}`) se reconstruye con `toPublicVersion` —sin
`correctOptionIds`— y las claves con `toAnswerKeys`, **en la misma operación**.
Las claves se sustituyen enteras: si se elimina una pregunta, su respuesta
correcta desaparece con ella. `optionLabels` es opcional en el modelo (el
contenido anterior al editor no lo tiene); cuando falta, la interfaz muestra el
identificador de la opción y el editor lo señala como aviso, nunca como error de
guardado.

### `progress/{uid}_{courseId}` — progreso por curso

```
{
  uid, courseId, version,
  mandatoryTopicIds: string[],
  topics: { [topicId]: { passed, attempts, passedAt, lastAttemptAt, bestScore } },
  documents: { [documentId]: { totalPages, lastPageViewed, completedAt } },
  finalExam: { passed, attempts, bestScore, passedAt, lastAttemptAt },
  completedAt: string | null,
  updatedAt
}
```

Al publicar una versión nueva, el progreso anterior se archiva en
`progressHistory/{uid}_{courseId}_{version}` y se inicia uno nuevo con la
versión publicada.

### `attempts/{autoId}` — intentos (auditoría)

```
{ uid, courseId, version, assessmentType: "topic" | "final", topicId?,
  answers: [{ questionId, selectedOptionIds }],
  passed, correctCount, totalQuestions, at }
```

Sirve para responder "¿por qué se le dio por aprobado?" sin depender del cliente.

### `enrollments/{uid}_{courseId}` — matrícula (Fase 6)

```
{ uid, courseId, status: "active" | "revoked", version: number | null,
  enrolledAt, enrolledBy, updatedAt }
```

Es la relación explícita usuario–curso y **la única fuente de acceso al
contenido**. Reglas:

- Publicar un curso **no** matricula: `publishedVersion != null` solo indica que
  el curso es visible en el catálogo.
- Matricula y revoca únicamente el servidor (`/api/admin/enrollments`, con rol
  de administrador comprobado contra la base de datos, no contra el cliente).
- Revocar (`status: "revoked"`) quita el acceso y **no borra el progreso**: al
  volver a matricular se retoma donde estaba.
- `isEnrollmentActive()` exige literalmente `status === "active"`; cualquier
  otro valor, o la ausencia de documento, deniega.
- El id es determinista, así que hay una sola matrícula por usuario y curso.
- Índice compuesto `uid`, `courseId`: permite listar las matrículas de un
  alumno y los alumnos de un curso sin recorrer la colección.

### `documents/{documentId}` — metadatos de PDF (sin binario, solo servidor)

```
{ courseId, version, originVersion, topicId, title, pageCount, bytes, sha256,
  chunkLengths: number[], partsReceived: number,
  state: "pending" | "active" | "aborted" | "archived",
  uploadedBy, uploadedAt, finalizedAt: string | null, abortedAt: string | null,
  archived: boolean }        // campo heredado; state es la fuente de verdad
```

No hay ruta de Storage ni URL: **el binario no tiene ubicación pública**.

**Ciclo de vida (`state`).** Un documento nace `pending`, con la cuota ya
reservada y sin fragmentos; pasa a `active` cuando el servidor ha comprobado el
número de fragmentos, el tamaño total y el **SHA-256** del fichero entero. Una
subida que se cancela queda `aborted` (sin fragmentos y sin reserva). Solo un
`active` puede asociarse a un tema y solo un `active` se sirve al alumnado: un
`pending` es invisible incluso con su identificador en la mano. `aborted` y
`archived` no se sirven nunca.

`documentId` **lo calcula el servidor**: `doc_` + 32 hex de
`sha256("courseId|version|topicId|bytes|sha256")`. El cliente no elige ids, así
que no puede ocupar el identificador de otro documento ni «reservar» uno vacío.
Consecuencia práctica: subir dos veces el mismo fichero al mismo tema es la
misma operación (idempotente), y subir un fichero distinto crea otro activo
(sustituir un PDF = activo nuevo, nunca sobrescribir).

**Desde el esquema v2 esta colección es solo-servidor** (`allow read, write: if
false`). Antes la leía cualquier cuenta con matrícula activa en el curso, y eso
incluía los metadatos de documentos de **borradores**: un alumno que conociera
un identificador podía leer títulos y números de páginas no publicados. Los
metadatos los necesita el servidor, no el navegador: la API de documentos los
lee con el Admin SDK y comprueba sesión, matrícula y publicación.

`originVersion` es la versión en la que se subió el documento. Se escribe junto
a `version` (que se conserva para que una versión anterior del código siga
leyendo lo mismo) y en lectura se usa `originVersion ?? version`: **los
documentos antiguos no se migran**, se interpretan igual. La autorización de
lectura no depende de la versión grabada en el documento (ver ADR de la
estrategia de PDF, pendiente de implementación en un bloque posterior).

### `pdfChunks/{documentId}_{n}` — fragmentos del PDF (solo servidor)

`{ documentId, index, data: Bytes, sha256OfDocument }`

Los PDF se guardan en Firestore troceados porque **el plan Spark no incluye
Storage** (requiere Blaze). Detalles que importan:

- `data` es de tipo **Bytes**, nunca texto base64: base64 infla un 33 % y un
  fragmento de 768 KiB ocuparía exactamente 1 MiB, el límite por documento.
- Firestore limita cada documento a 1 MiB y cada **petición/transacción a
  10 MiB**. Con fragmentos de 768 KiB y un tope de PDF de **8 MiB** salen 11
  fragmentos (8,25 MiB) más 512 KiB de margen de seguridad: caben en una sola
  transacción. El tope anterior de 20 MiB daba 27 fragmentos = 20,25 MiB y la
  subida fallaba siempre (defecto corregido en la Fase 6). Límite aritmético
  absoluto con este tamaño de fragmento: 12 fragmentos (9 MiB).
- El límite de 500 escrituras por transacción se retiró; el que manda es el
  de 10 MiB por petición.
- Cada fragmento lleva también `index` y `sha256OfDocument`, y el servicio
  comprueba **en la parte 0** que el contenido empieza por `%PDF-`: el nombre y
  el `Content-Type` no cuentan como validación.
- Las partes se aceptan **en orden** (`index === partsReceived`): reenviar una ya
  guardada es idempotente si su huella coincide y un conflicto (`PDF_CHUNK_CONFLICT`)
  si no. Eso permite reanudar una subida interrumpida sin repetir escrituras y
  sin aceptar un fichero a medias de dos versiones distintas.
- La verificación del SHA-256 global se hace **fuera** de la transacción de
  finalización (leer once fragmentos dentro de una transacción se acercaría al
  límite de 10 MiB con el propio PDF): primero se leen y se comprueban los
  fragmentos, y solo si la huella coincide se mueve la reserva a uso y se activa
  el documento en una transacción corta.
- Solo los lee y escribe el servidor con el Admin SDK. Las reglas los cierran
  (`allow read, write: if false`), así que conocer el id no sirve de nada.
- El cliente pide páginas a `/api/documents/{id}/pages?from=&to=` (máximo 20
  páginas y 768 KiB por petición) para el progreso de lectura; la lectura exige
  matrícula activa y respetar el orden de páginas.
- Desde el bloque 07 también puede pedir el **fichero completo** a
  `GET /api/documents/{id}/file` para abrirlo con el visor del navegador. No es
  una ruta alternativa de almacenamiento: usa el mismo `PdfDocumentStore`, los
  mismos fragmentos y el mismo `sha256` del registro `documents/{id}`. Para
  servirla se reconstruyen las partes y se recalculan tamaño y huella; si algo
  no cuadra, no se devuelve el fichero. La autorización no mira el `courseId` de
  la URL: busca en qué curso y versión publicada está referenciado el documento y
  exige matrícula activa en **ese** curso. La versión del documento no se guarda
  aparte: se deduce del `documentId` de las versiones publicadas, así que no hay
  dos fuentes de verdad que puedan contradecirse.

### `audits/{autoId}` — auditoría administrativa

`{ type: "people_import" | "bootstrap_admins" | "account_rollback", actorUid, at, ... }`
Sin tokens, sin contraseñas, sin PDF.

### `progressHistory/{uid}_{courseId}_v{n}` — progreso archivado

`{ uid, courseId, version, archivedAt, completedAt, quiz: {...}, final: {...} }`

Se escribe **en la misma transacción** que reinicia el progreso al publicar una
versión nueva. Es un histórico inmutable: permite responder qué había
completado alguien en la v1 cuando ya va por la v3. Sin regla de lectura para
el cliente, salvo la propia del usuario (ver §3).

### `meta/storage` — contadores de cuota de PDF

`{ usedBytes, reservedBytes, updatedAt }`

- `usedBytes`: bytes de documentos `active`. Es lo que ocupa de verdad.
- `reservedBytes`: bytes de documentos `pending`. Es cuota **comprometida** que
  todavía no está en el almacén. Al crear la subida se reserva, al finalizar se
  convierte en uso y al cancelar se libera.

Los dos se actualizan en la **misma transacción** que el documento, de modo que
dos subidas simultáneas no pueden pasar ambas la comprobación de presupuesto (la
comprobación y la reserva ocurren en la misma transacción, no en dos pasos). Un
reintento de la misma subida no reserva dos veces porque el `documentId` es
determinista y la segunda llamada ve el registro existente. `recomputeUsage`
recalcula `usedBytes` a partir de los documentos `active` (herramienta de
reparación: un fallo de red a mitad de una transacción no puede dejar el
contador desviado, pero conviene poder demostrarlo). `db:check` compara este
contador con la suma real de `documents.bytes` y avisa si se separan.

### `meta/schema` — control de esquema

`{ schemaVersion, app: "formacion-us", collections: [...], initializedAt, updatedAt }`

Solo servidor (`allow read, write: if false`). Lo escriben `npm run db:init` y
lo leen `npm run db:check` con el Admin SDK. Sirve para detectar bases de datos
sin inicializar o con un esquema más nuevo que el código desplegado.

## 2. Índices

`firestore.indexes.json` define **solo índices compuestos**, y solo los que el
código usa de verdad (Firestore crea los de un campo automáticamente):

| Colección | Campos | Para qué |
| --- | --- | --- |
| `accounts` | `role`, `status` | administradores activos |
| `progress` | `uid`, `updatedAt desc` | «mis cursos» |
| `progress` | `courseId`, `version`, `completedAt desc` | progreso de una versión |
| `attempts` | `uid`, `at desc` | historial de intentos |
| `attempts` | `courseId`, `version`, `at desc` | revisión por curso |
| `documents` | `courseId`, `version`, `topicId` | documentos de un tema |
| `enrollments` | `uid`, `courseId` | matrículas de un alumno / alumnos de un curso |
| `enrollments` | `courseId`, `status` | matrículas **activas** de un curso (recuento de impacto al publicar) |

Mantener los índices al día es un problema de deriva: `tests/server/schema-drift.test.ts`
falla si un índice apunta a una colección que no existe en
`src/server/db/schema.constants.ts`, y `npm run db:check` ejecuta cada consulta
real contra la base de datos para detectar el índice que falte.

## 3. Relación con las reglas

| Colección | Lectura cliente | Escritura cliente |
| --- | --- | --- |
| `accounts` | propia, o todas si admin | ✗ |
| `usernames`, `activationTokens` | ✗ | ✗ |
| `audits` | admin | ✗ |
| `courses` (metadatos) | activo, si hay versión publicada | ✗ |
| `courses/{id}/versions` | matriculado en ese curso + versión publicada | ✗ |
| `enrollments` | propia, o todas si admin | ✗ |
| `answerKeys` | ✗ | ✗ |
| `progress` | propia, o todas si admin | ✗ |
| `progressHistory` | propia, o todas si admin | ✗ |
| `attempts` | admin | ✗ |
| `meta` | ✗ | ✗ |
| `documents` | ✗ (solo servidor desde el esquema v2) | ✗ |
| `pdfChunks` | ✗ | ✗ |
| cualquier otra ruta (incl. `versions`) | vía `courses` publicada | ✗ |

Consecuencia: aunque alguien ejecute JavaScript propio en el navegador, no
puede marcar un intento como aprobado, ni escribir progreso, ni cambiar su rol,
ni leer las respuestas correctas.

## 3 bis. Versión del esquema

`meta/schema.schemaVersion` = **2**. Los cambios de la v2 son aditivos y no
exigen migración:

| Cambio | Compatibilidad |
| --- | --- |
| `documents` deja de ser legible por el cliente | no rompe nada: la aplicación nunca leyó Firestore desde el navegador |
| `documents.originVersion` | los documentos v1 no lo tienen; se lee `originVersion ?? version` |
| `courses.lastDraftVersion` | ausente en cursos v1; se interpreta `null` |

`db:init` se niega a degradar un esquema más nuevo, y `db:check` avisa si la
base sigue en una versión anterior.

## 4. Versionado: semántica exacta

- `requiresNewCompletion(últimaCompletada, publicada)`: `true` si nunca
  completó o si la publicada es mayor.
- Solo se puede publicar `actual + 1` (`assertPublishable`).
- `restartForVersion` exige versión estrictamente mayor.
- El progreso de v1 se conserva como histórico; no se borra.

## 5. Inicialización y verificación

| Comando | Qué hace | Escribe |
| --- | --- | --- |
| `npm run db:init` | simulación: conectividad + estado de colecciones | no |
| `npm run db:init -- --apply` | escribe `meta/schema` (exige `DB_INIT_CONFIRM=yes`) | sí |
| `npm run db:check` | auditoría completa; ejecuta las consultas para detectar índices ausentes | no |

Ambos se niegan a tocar un proyecto real sin `DB_ALLOW_PROD=yes` (o sin
`FIRESTORE_EMULATOR_HOST`). La lógica de auditoría vive en
`src/server/db/checks.ts` (pura, con pruebas unitarias); los scripts solo leen
Firestore y pintan los hallazgos. `db:check` sale con código 1 si hay errores.

Comprobaciones: esquema inicializado y en versión; al menos un administrador y
todos creados por el procedimiento de arranque (la importación nunca concede
admin); roles/estados/`claimsVersion` válidos; usuarios duplicados; curso
publicado que apunta a versión existente, publicada y con claves; claves
huérfanas; progreso de cursos sin publicar o de versiones futuras; intentos no
corregidos en servidor; aprobados con menos de todas las respuestas correctas.

## 6. Almacenamiento de PDF y cuota gratuita

| Concepto | Valor | Origen |
| --- | --- | --- |
| Límite por documento | 1 MiB (1 048 576 B) | Firestore |
| Tamaño de fragmento | 768 KiB | elección propia (margen ~256 KiB) |
| Fragmentos por PDF | 1–11 | 8 MiB / 768 KiB |
| Tamaño máximo por PDF | 8 MiB | tope duro del servicio (Fase 6) |
| Petición/transacción en Firestore | 8,25 MiB + 512 KiB de margen ≤ 10 MiB | límite de Firestore: 10 MiB |
| Escrituras por transacción | 13 (11 + 2) | el límite de 500 se retiró; manda el de 10 MiB |
| Cuota total Firestore (Spark) | 1 GiB | plan gratuito |
| Reserva para el resto de datos | 128 MiB | elección propia |
| Presupuesto máximo configurable | 896 MiB | 1 GiB − reserva |
| Presupuesto por defecto | 512 MiB | `PDF_STORAGE_BUDGET_MB=512` |
| Máximo por petición de lectura | 20 páginas y 768 KiB | una lectura = 1 fragmento |

Con el presupuesto por defecto caben 64 PDF de 8 MiB o ~100 de 5 MiB. Las
cifras de consumo diario (50 000 lecturas/día, 20 000 escrituras/día, 1 GiB de
salida al mes) están en `docs/INFORME-FASE-4.md`, con el cálculo de qué supone
leer un PDF.

## 6 bis. Copia de seguridad y restauración (Fase 7)

Archivo `.fbak` con formato propio:

```
"FORMACION-BACKUP-1\n" | uint32 desplazamiento del manifiesto | bloques cifrados | manifiesto JSON
```

- **Una entrada por colección**, incluidas las subcolecciones
  (`courses/{id}/versions`): 14 en el conjunto de prueba.
- Cada bloque es NDJSON (`{path, data}` por línea) cifrado con AES-256-GCM. Los
  valores se codifican con etiquetas: `{"$bytes": base64}` y
  `{"$timestamp": {seconds, nanoseconds}}`, para que los fragmentos de PDF y las
  fechas vuelvan idénticos.
- El manifiesto lleva `schemaVersion`, `createdAt`, recuentos, tamaños, sal, IVs,
  etiquetas, SHA-256 por bloque y parámetros de `scrypt`; **ningún dato**.
- Restaurar exige destino vacío (o `--force`); escribe en lotes de ≤400
  documentos y ≤6 MiB y comprueba el recuento final.

```
npm run backup:export  -- --out backups/copia.fbak
npm run backup:restore -- --in backups/copia.fbak --dry-run
npm run backup:restore -- --in backups/copia.fbak
```

## 6 ter. Ciclo de subida de un PDF (bloque 06)

Cuatro operaciones, todas de servidor, con el rol de administrador y el origen
comprobados:

| Paso | Operación | Efecto |
| --- | --- | --- |
| 1 | `POST /api/admin/documents/uploads` | Crea el registro `pending`, calcula el `documentId` y **reserva** `bytes` en el presupuesto |
| 2 | `PUT .../uploads/{id}/parts/{n}` | Guarda una parte (≤ 768 KiB, en orden, comprobando tamaño y `%PDF-` en la 0) |
| 3 | `POST .../uploads/{id}/finalize` | Verifica partes, tamaño y SHA-256; mueve reserva → uso y activa |
| 4 | `POST .../uploads/{id}/abort` | Cancela, libera la reserva y borra los fragmentos (idempotente) |

Después, `POST /api/admin/documents/{id}/attach` asocia un documento **activo**
al tema del borrador. El curso, la versión y el tema los aporta el propio
documento: el cliente solo manda la revisión que tenía abierta, de modo que no
puede mover un PDF a otro curso cambiando el cuerpo de la petición.

Garantías y límites, explícitos:

- **Reanudación**: las partes ya guardadas no se reenvían; el editor puede
  reanudar pidiendo el mismo fichero (el navegador no puede conservar un fichero
  entre recargas). Si el fichero elegido tiene otro tamaño, se rechaza antes de
  escribir.
- **Idempotencia**: crear la misma subida devuelve el registro existente
  (`created: false`), finalizar dos veces no cuenta la cuota dos veces
  (`alreadyActive: true`) y cancelar dos veces libera una sola vez
  (`releasedBytes: 0` la segunda).
- **Concurrencia**: reserva y comprobación de presupuesto van en la misma
  transacción. En los dobles y en la demo esto se prueba con dos aperturas
  simultáneas; en Firestore real depende de que la transacción se reintente
  (comportamiento documentado de Firestore, no verificado aquí: sin emulador).
- **Fallo a mitad**: la subida queda `pending` y se puede reanudar o cancelar; la
  fachada de una sola petición cancela en su `catch` para no dejar reservas
  colgadas. Un `pending` huérfano (cierre del navegador) se ve en el editor como
  subida pendiente y se cancela desde ahí: **no hay TTL** porque Firestore lo
  exige en Blaze.
- **Sustitución**: un PDF activo es inmutable. Sustituirlo es subir otro (otro
  `documentId`) y asociarlo; el anterior se archiva
  (`archiveDocument`, que libera su cuota) para que una versión publicada no
  pierda un documento que el alumnado está usando.
- **Nada de un PDF de 8 MiB en un documento**: 8 MiB supera el límite de 1 MiB
  por documento; el troceado no es una optimización, es un requisito.

Lo que **no** se verifica: que el PDF tenga las páginas que declara el
administrador. El servidor no interpreta PDF; el número de páginas es una
declaración expresa de la interfaz (`Confirmo que el documento tiene N páginas`)
y se guarda tal cual.

## 7. Límites de tamaño

- Excel: 2 MB / 2000 filas.
- PDF: 8 MiB por documento, ≤ 5000 páginas, 11 fragmentos (ver §6).
- Lectura de PDF: ≤ 20 páginas y 768 KiB por petición; 600 páginas/hora por
  usuario y 6000/hora en total (límite en memoria del proceso).
- Claims: pocas claves (`role`, `status`, `personRol`, `claimsVersion`).
