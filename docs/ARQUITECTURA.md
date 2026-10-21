# Arquitectura

## 1. Principios

1. **Aislamiento total** respecto a la aplicación de cuadrantes: repositorio,
   Firebase, credenciales y datos independientes.
2. **El servidor decide.** Corrección de cuestionarios, progreso, roles y
   activación se calculan en servidor. El cliente solo envía intenciones.
3. **Denegar por defecto.** Reglas de Firestore cerradas; escrituras
   solo mediante Admin SDK.
4. **Reglas de negocio puras y probadas.** Todo lo que decide algo vive en
   `src/domain`, sin Firebase, sin red y sin relojes implícitos, para poder
   probarlo sin infraestructura.
5. **Fallo cerrado.** Sin configuración, la aplicación responde 503; nunca
   arranca con valores inseguros.
6. **Nada de secretos en el repositorio.**

## 2. Stack

| Pieza | Elección | Motivo |
| --- | --- | --- |
| Framework | Next.js 16 (App Router) + React 19 | Servidor y cliente en un despliegue; Route Handlers para la lógica sensible |
| Lenguaje | TypeScript estricto | Evitar clases enteras de errores en reglas de seguridad |
| Estilos | Tailwind CSS 4 | Interfaz sobria, sin dependencias de componentes |
| Autenticación | Firebase Authentication (email/password con correo sintético) | Cuentas gestionadas solo por administración; sin registro público |
| Base de datos | Firestore | Progreso por usuario, contenido versionado, auditoría |
| Ficheros | Firestore fragmentado, servido por el servidor | Sin Storage (plan Spark); PDF no accesibles por enlace |
| Excel | `read-excel-file` | Solo `.xlsx`; sin escritor de Excel en el árbol de dependencias |
| Pruebas | Vitest | Rápido, ESM nativo, sin navegador |
| Validación de entorno | Zod | Configuración tipada y fallo cerrado |

`firebase-admin` y el parser de Excel se marcan como `serverExternalPackages`:
usan APIs de Node (gRPC, streams) que no deben empaquetarse con el cliente.

## 3. Capas

```
┌──────────────────────────────────────────────────────────────┐
│ app/            Rutas y componentes (server y client)         │
│                 · páginas, formularios, Route Handlers /api   │
├──────────────────────────────────────────────────────────────┤
│ server/         Orquestación y adaptadores                    │
│                 · session.ts (cookie + claims + BD)           │
│                 · db/schema.ts (esquema y validación)         │
│                 · courses/catalog.ts (publicar versiones)     │
│                 · courses/editor.ts (borradores)              │
│                 · courses/draft-form.ts (formulario)          │
│                 · assessments/service.ts (corrección)         │
│                 · learning/store.ts (puertos de progreso)     │
│                 · import/service.ts (puertos, no Firebase)    │
│                 · auth/activation-service.ts                  │
│                 · firebase/* (Admin SDK: implementación)      │
├──────────────────────────────────────────────────────────────┤
│ domain/         Reglas puras, sin E/S                         │
│                 · roles, apellidos, usuarios, importación     │
│                 · corrección, progreso, versionado, rutas     │
└──────────────────────────────────────────────────────────────┘
```

**Dirección de dependencias:** `app → server → domain`. El dominio no conoce a
nadie. Los servicios de `server` dependen de *puertos* (interfaces), no de
Firebase; los adaptadores reales están en `server/firebase`.

Esto permite probar hoy las propiedades de seguridad del flujo de importación
y activación con dobles en memoria, sin haber conectado Firebase.

## 4. Flujos

### 4.1 Acceso

```
Usuario ──usuario+contraseña──► /login (cliente)
        signInWithEmailAndPassword(usuario@dominio.invalid, contraseña)
        getIdToken()
        ──POST /api/auth/session {idToken}──► servidor
                                    verifyIdToken (firma/iss/aud/exp)
                                    + comprobar cuenta activa y claimsVersion
                                    createSessionCookie (httpOnly, Secure, Lax)
        ◄──Set-Cookie──
        signOut() en cliente; el token deja de existir en el navegador
```

- Persistencia del SDK: **en memoria** (`inMemoryPersistence`).
- La sesión real es una cookie httpOnly, ilegible desde JavaScript.
- `middleware.ts` solo comprueba *presencia* de cookie (redirección temprana);
  la autorización real la hace `getActor()` con Admin SDK.

### 4.2 Activación

```
admin importa ──► cuenta creada (pending_activation) + token (hash en BD)
                       │
        código entregado por canal interno (no por correo)
                       ▼
/activar ──usuario+token+contraseña──► POST /api/activate
                                busca token por hash (SHA-256)
                                comprueba caducidad/uso/revocación/propiedad
                                valida política de contraseña
                                Admin SDK: setPassword + claims(active, v+1)
                                consume token (transacción) + status=active
                                revoca refresh tokens
```

### 4.3 Importación Excel

```
POST /api/admin/import/preview   (multipart: file + resolutions)
   ├─ sesión válida + rol admin
   ├─ límite 2 MB y 2000 filas
   ├─ magic bytes PK (solo .xlsx) + lectura de la primera hoja
   ├─ cabecera exacta {Rol, Apellido} (cualquier orden)
   ├─ normalización de rol y apellido
   ├─ duplicados: mismo fichero / ya existente en BD
   └─ vista previa con filas válidas, errores y duplicados pendientes

POST /api/admin/import/confirm   (mismo cuerpo + decisiones)
   ├─ RECALCULA la vista previa en servidor (ignora usuarios del cliente)
   ├─ exige confirmable (sin errores ni duplicados pendientes)
   ├─ por fila: reserva username → Auth user (contraseña aleatoria)
   │            → claims learner/pending → cuenta + token
   ├─ rollback de lo creado si algo falla
   └─ auditoría + tokens mostrados UNA vez
```

### 4.4 Cursos, temas y PDF

- Contenido **inmutable por versión**: `courses/{courseId}/versions/{n}` con
  estado `draft | published | archived`.
- Publicar exige la versión inmediatamente siguiente y desbloquea "repetir
  curso" para todo el mundo (`requiresNewCompletion`).
- PDF: **sin Firebase Storage** (el plan Spark no lo incluye). Se guardan
  troceados en Firestore (`pdfChunks`, solo servidor) y el alumno pide páginas a
  `/api/documents/{id}/pages?from=&to=` (≤ 20 páginas, ≤ 768 KiB); la lectura
  avanza página a página (`assertCanViewPage`) en la capa de progreso. Tope del
  PDF: **8 MiB** (11 fragmentos), elegido para que quepa en la transacción de
  10 MiB de Firestore. Ver §4.6.
- **Acceso por matrícula** (`enrollments/{uid}_{courseId}`): estar publicado ya
  no da acceso. Matricular y revocar es cosa de administración; toda lectura de
  contenido pasa por `assertCourseAccess`.
- El cuestionario del tema se abre cuando el tema está leído completo y
  corregido en servidor; el examen final solo tras aprobar todos los temas
  obligatorios.

### 4.5 Evaluaciones

```
cliente ──{questionId: [opciones]}──► POST (endpoint: fase 4)
                                     submitAssessment()
                                     gradeAttempt(clave, respuestas)
                                     passed = todas correctas en el intento
                                     recordTopicAttempt / recordFinalExamAttempt
                                     progreso guardado en servidor
```

El cliente **nunca** recibe `correctOptionIds` (`toClientQuiz` los elimina) ni
puede escribir progreso (reglas de Firestore).

La corrección se implementó en fase 3 (`src/server/assessments/service.ts`) con
tres barreras contra la fuga de respuestas: `toPublicVersion` (usa
`toClientQuiz`), `assertNoAnswerLeak` antes de publicar y `throwIfLeaking` en el
adaptador de Firestore. Las claves de corrección viven en una colección aparte
(`answerKeys`, cerrada al cliente) y la respuesta del servicio contiene solo el
resultado.

### 4.6 Borradores: abrir, editar y guardar sin publicar

```
/admin/cursos/{id}            ficha: versiones, validación y acciones
/admin/cursos/{id}/editar?v=n editor de estructura del borrador
```

```
Abrir borrador ──POST startDraftAction──► startDraft
     lee ficha ─► ¿ya hay borrador? ─sí─► reanuda (no crea otra versión)
                                    └no─► clona la publicada o crea vacía
     escribe versión + lastDraftVersion en UNA transacción (estado esperado)

Guardar ──POST saveDraftAction──► parseDraftStructureForm ─► saveDraftStructure
     estructura (checkDraftStructure) ─► revisión esperada ─► transacción
     avisos (reviewDraft) se muestran; NO bloquean el guardado
```

Tres responsabilidades separadas, y cada una en su sitio:

| Nivel | Dónde | Qué hace |
| --- | --- | --- |
| Estructura | `domain/courses/draft.ts` → `checkDraftStructure` | Bloquea el guardado solo por forma: identificadores, longitudes, órdenes |
| Avisos | `reviewDraft` (reutiliza `validateCourseVersion`) | Lo que falta para publicar y lo que conviene mirar; no impide guardar |
| Publicación | `validateCourseVersion` (sin cambios) | Puerta dura; guardar nunca la relaja |

El **orden de temas se normaliza a 1..n** antes de escribir (desempate por
identificador, resultado determinista) y el editor **no edita cuestionarios ni
examen final**: `saveDraftStructure` los conserva por identificador, así que
guardar la estructura no pierde preguntas ni claves.

Concurrencia y errores: cada guardado lleva la `revision` abierta y la exige en
el almacén (`DRAFT_STALE` si otra pestaña guardó); abrir un borrador comprueba
el estado esperado de la ficha (`DRAFT_CONFLICT`) y reintenta leyendo de nuevo,
de modo que un reintento reanuda en vez de duplicar. La pantalla solo muestra
«guardado» cuando el servicio ha confirmado; si falla, vuelve al editor con el
mensaje real.

### 4.7 Persistencia de contenido y progreso

```
courses/{courseId}                     título + publishedVersion + lastDraftVersion
courses/{courseId}/versions/{n}        contenido público (nunca respuestas)
answerKeys/{courseId}_v{n}_{eval}      claves de corrección (solo servidor)
documents/{documentId}                metadatos de PDF (sin binario ni rutas, solo servidor)
pdfChunks/{documentId}_{n}            fragmentos del PDF (Bytes, solo servidor)
progress/{uid}_{courseId}              estado de la versión en curso
progressHistory/{uid}_{courseId}_v{n}  progreso archivado al cambiar de versión
attempts/{autoId}                      qué contestó y cómo se corrigió (inmutable)
meta/schema                            versión del esquema (solo servidor)
meta/storage                           contador de cuota de PDF (solo servidor)
```

Los puertos (`CourseCatalogStore`, `LearningStore`) tienen dos
implementaciones: la de Firestore (`server/firebase/*`, transaccional) y la de
memoria usada en las pruebas (`tests/helpers/db-doubles.ts`).

## 5. Decisiones de estructura

- `domain/` separado de `server/` para que las pruebas no necesiten emuladores.
- Endpoints en `/api/...` solo para lo que necesita cliente: sesión,
  activación, importación (multipart) y futuras evaluaciones. Las páginas se
  renderizan en servidor y leen Firestore con Admin SDK.
- Middleware deliberadamente "tonto": un `edge` no puede ejecutar
  `firebase-admin` y no queremos verificar firmas a medias.

## 6. Despliegue previsto (no ejecutado)

1. Proyecto Firebase **nuevo** de Formación (Auth + Firestore, plan Spark).
2. Subida de reglas (`firestore.rules`, `storage.rules`) y despliegue de índices.
3. Variables de entorno en la plataforma de hosting.
4. Alta de administradores con `scripts/bootstrap-admins.mjs` (simulación
   previa obligatoria).
5. Verificación en emulador antes de cualquier dato real.

Nada de esto se ha hecho en esta fase.
