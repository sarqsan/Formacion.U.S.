# Crear curso con IA (Gemini)

Estado: **implementado en la rama `arena/834dae95-formacion-u-s`**, sin fusionar y sin desplegar.
Requiere una credencial externa para funcionar de verdad: `GEMINI_API_KEY`.

## Qué hace

Un asistente de administración que, a partir del **PDF del temario**, propone el contenido del
curso y lo deja en un **borrador normal**, revisable y publicable con el flujo de siempre.

| Paso | Pantalla | Qué ocurre | Qué se escribe |
| --- | --- | --- | --- |
| 1 | `/admin/cursos/ia` | Identificador, título, descripción y PDF del temario | Curso + borrador v1 + tema «Temario» (opcional) + PDF fragmentado con SHA-256 |
| 2 | `/admin/cursos/{id}/ia?v=1&paso=2` | Gemini reparte el PDF en temas y cita sus páginas | Estructura del borrador (temas) |
| 3 | `…&paso=3` | Pantallas de estudio por tema, con páginas del PDF | `screens` del tema, editables campo a campo |
| 4 | `…&paso=4` | Cuestionario por tema y examen final (nº configurable, única/múltiple) | Preguntas + claves + explicación (en `answerKeys`) |
| 5 | `…&paso=5` | Revisión: errores y avisos, y enlace a la publicación existente | Nada (solo lectura) |

El alumnado estudia las pantallas en `/cursos/{id}/temas/{tema}/pantallas`, con progreso
secuencial en el servidor, y responde el cuestionario cuando termina el tema (o cuando termina los
documentos del tema, si también los tiene).

## Reglas que se respetan

- **La IA propone; el servidor decide.** Todo lo generado pasa por las mismas validaciones que el
  contenido escrito a mano (`checkDraftStructure`, `normalizeScreens`, `checkDraftQuizzes`).
- **Nada se publica solo.** El ciclo de vida (borrador → revisión → validación → publicación manual)
  no se ha tocado y no hay ninguna ruta que publique desde el asistente.
- **Las respuestas correctas solo están en el servidor.** Se guardan en `answerKeys/{curso}_v{n}`;
  el documento de versión no las lleva y `assertNoAnswerLeak` falla si aparecen. La explicación de
  cada respuesta va con ellas (mismo documento, solo servidor) y **no** se muestra al alumnado
  después de corregir: en esta aplicación un intento fallido se repite, no se revela la solución.
- **La clave de Gemini nunca sale del servidor.** Va en la cabecera `x-goog-api-key`; los mensajes
  de error se redactan (`redactSecrets`) y `/api/health` publica solo `configured`, `model`,
  `reachable`, `modelAvailable` y un texto explicativo.
- **Reintentar no duplica.** Generar pantallas de un tema sustituye las de ese tema; un
  cuestionario sustituye el de ese tema; el examen final se reemplaza entero. Los demás temas, sus
  correcciones manuales y el tema del PDF no se tocan. Si Gemini falla, no se escribe nada y el
  borrador queda con la misma revisión.
- **Dos pestañas no se pisan.** Todas las escrituras exigen la revisión abierta en la pantalla; si
  otra sesión guardó antes, la operación falla con `DRAFT_STALE` y no se pierde nada.

## Requisitos externos (no están en el repositorio)

1. **Clave de la API de Gemini** (Google AI Studio → *API key*), en el entorno del servidor:
   `GEMINI_API_KEY`. Sin ella, la pantalla lo dice y los botones de generación quedan desactivados;
   el resto de la aplicación funciona igual.
2. Opcional: `GEMINI_MODEL` (por defecto `gemini-2.5-flash`) y `GEMINI_TIMEOUT_MS` (120 s).
3. El PDF tiene que tener **texto seleccionable** y pesar **menos de 8 MiB**. Un escaneo sin OCR no
   se puede leer.
4. El número de páginas del PDF se indica a mano en el paso 1 (la aplicación no incorpora un lector
   de PDF). Si no coincide, las citas de páginas se rechazan en lugar de guardarse mal.

## Estado real de la integración

- Cliente HTTP contra la API oficial (`generativelanguage.googleapis.com/v1beta`), con
  `responseMimeType: application/json` y `responseSchema`: el modelo no puede responder en texto
  libre.
- **No se ha llamado a Gemini con una clave real desde este entorno** (no hay credencial y la red
  del sandbox no lo permite). Lo verificado son las pruebas con `fetch` inyectado y el flujo
  completo contra almacenes en memoria. La comprobación en producción es
  `GET /api/health` → `gemini.configured` / `gemini.reachable`, o el botón «Comprobar conexión»
  de `/admin/cursos/ia`.

## Archivos

Nuevos:

```
src/server/ai/config.ts            lectura de la clave, modelo y tiempo de espera; redacción
src/server/ai/gemini.ts            cliente HTTP, errores accionables, PDF en línea
src/server/ai/status.ts            estado de la conexión (cacheado), sin secretos
src/domain/courses/ai-plan.ts      validación del JSON del modelo (temas, pantallas, cuestionarios)
src/server/courses/ai-service.ts   instrucciones y llamadas (temas, pantallas, cuestionarios)
src/server/courses/ai-flow.ts      recorrido completo: subida, temas, pantallas, cuestionarios
src/server/courses/screens-form.ts lectura del formulario de pantallas
src/server/documents/draft-file.ts lectura verificada del PDF de un borrador (solo administración)
src/app/actions/ai.ts              acciones de servidor del asistente
src/app/admin/cursos/ia/page.tsx   paso 1 + estado de Gemini
src/app/admin/cursos/[courseId]/ia/page.tsx  pasos 2 a 5
src/app/cursos/[courseId]/temas/[topicId]/pantallas/page.tsx  estudio pantalla a pantalla
src/domain/courses/screens.ts      modelo y límites de las pantallas
tests/domain/ai-plan.test.ts, tests/server/ai-{gemini,status,flow}.test.ts,
tests/server/screens-form.test.ts, tests/server/topic-screens.test.ts
```

Modificados (sin cambiar su comportamiento previo salvo lo indicado):

```
src/domain/courses/content.ts        TopicDefinition.screens + validaciones
src/domain/courses/draft.ts          pantallas en la estructura del borrador y en la revisión
src/domain/courses/quiz-draft.ts     explicación de la respuesta correcta
src/domain/assessments/scoring.ts    QuizQuestionDefinition.explanation (solo servidor)
src/server/courses/catalog.ts        copia de pantallas; explicación en answerKeys; fuga de claves
src/server/courses/definition.ts     reconstrucción de pantallas y explicaciones
src/server/courses/editor.ts         saveDraftScreens, pantallas conservadas al guardar estructura
src/server/courses/quiz-form.ts      lectura de la explicación
src/app/admin/cursos/[courseId]/editar/quiz-fields.tsx  campo de explicación
src/server/portal/learner.ts         pantallas en la vista del alumno y lectura secuencial
src/server/portal/{index,firebase}.ts, src/demo/service.ts  cableado y modo demostración
src/app/cursos/[courseId]/page.tsx, …/temas/[topicId]/page.tsx  estudio por pantallas
src/app/api/health/route.ts          estado de Gemini (sin secretos)
.env.example                         GEMINI_API_KEY / GEMINI_MODEL / GEMINI_TIMEOUT_MS
```

## Pruebas

```
./node_modules/.bin/tsc --noEmit     sin errores
./node_modules/.bin/eslint .         sin avisos
npx vitest run                       1268 pruebas correctas, 9 omitidas (78 archivos)
./node_modules/.bin/next build       compila; las rutas nuevas se generan como dinámicas
```
