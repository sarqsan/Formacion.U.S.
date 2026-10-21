# Informe de la fase 3 — preparación de la base de datos

**Fecha:** 21 de octubre de 2026
**Rama:** `arena/89a0aca0-formacion-u-s` (base `c4ce33d`, sin commits nuevos)
**Estado:** completado **con una limitación grande y explícita**: no existe
proyecto Firebase ni emulador ejecutable, así que **nada de esta fase se ha
ejecutado contra Firestore**. Todo lo verificable sin red está verificado.

---

## Resumen ejecutivo

| Requisito de la orden | ¿Hecho? |
| --- | --- |
| Definir y documentar el modelo de datos | **Sí** — `src/server/db/schema.ts` como fuente única |
| Capa de persistencia para cursos, versiones y claves | **Sí** — servicios + adaptadores Firestore |
| Persistencia de progreso e intentos | **Sí** — con archivo al cambiar de versión |
| Corrección de evaluaciones en servidor | **Sí** — `submitAssessment`, sin filtrar respuestas |
| Inicialización de la base de datos | **Sí** — `npm run db:init` (idempotente, con `--apply`) |
| Comprobación de la base de datos | **Sí** — `npm run db:check` (solo lectura, código de salida) |
| Índices necesarios | **Sí** — 6 índices compuestos alineados con las consultas |
| Reglas para colecciones nuevas | **Sí** — añadida `meta`; las demás ya existían |
| Pruebas automáticas de lo nuevo | **Sí** — 96 pruebas nuevas, 332 en total |
| Ejecución real contra Firebase | **No** — bloqueo de entorno (sin proyecto, sin JVM) |

`npm run verify` → **exit 0**: TypeScript 0 errores, ESLint 0 avisos, 332/332
pruebas, build de producción correcto.

---

## 1. Lo que había y lo que faltaba

Al empezar la fase, el repositorio tenía dominio, autenticación, importación y
UI, pero **ninguna capa de persistencia** para el núcleo del producto. Lo
confirma la lectura de `src/server/firebase/repositories.ts`: solo existían
repositorios de cuentas, tokens, auditoría e importación. No había forma de
guardar un curso, una versión, sus claves, un PDF, el progreso de un alumno ni
un intento; y por tanto tampoco existía la corrección de evaluaciones.

Es decir: la fase 3 no era "revisar el modelo de datos", era **construirlo.**
Se ha hecho así, no solo documentado.

---

## 2. Qué se ha construido

### 2.1 Esquema (fuente única)

- `src/server/db/schema.constants.ts` — constantes **sin importaciones**:
  `SCHEMA_VERSION = 1`, nombres de colecciones, colecciones legibles por
  cliente frente a solo-servidor, y lista de colecciones de nivel raíz. No
  importa nada a propósito: los scripts ejecutados con `tsx` no dependen de los
  alias `@/`.
- `src/server/db/schema.ts` — reexporta las constantes y añade lo que necesita
  validación: patrones de identificador, constructores de ids
  (`progressDocId`, `progressHistoryDocId`, `answerKeysDocId`, `versionPath`) y
  validadores de documento de cuenta, progreso e intento.

Los identificadores compuestos llevan siempre el uid o el curso delante, de
modo que una regla puede autorizar sin leer otro documento:

```
progress/{uid}_{courseId}
progressHistory/{uid}_{courseId}_v{n}
answerKeys/{courseId}_v{n}_{assessmentId}
courses/{courseId}/versions/{n}
```

### 2.2 Catálogo de cursos

`src/server/courses/catalog.ts`:

- `toPublicVersion` construye el documento público **siempre** con
  `toClientQuiz`, que elimina `correctOptionIds`.
- `toAnswerKeys` construye las claves, que se guardan en otra colección.
- `assertNoAnswerLeak` es la comprobación defensiva: si el JSON del documento
  público contiene la cadena `correctOptionIds`, se aborta la escritura.
- `saveDraftVersion`: solo admin activo, valida el contenido completo
  (`validateCourseVersion`), rechaza versiones existentes (las versiones son
  inmutables) y escribe versión + claves.
- `publishCourseVersion`: exige la versión inmediatamente siguiente
  (`assertPublishable`), que existan las claves, que no haya fuga, y publica en
  transacción.

### 2.3 Evaluaciones en servidor

`src/server/assessments/service.ts` (`submitAssessment`):

1. cuenta activa;
2. curso con versión publicada y claves presentes;
3. lectura completa del tema antes de su cuestionario
   (`isTopicFullyRead`);
4. examen final bloqueado hasta aprobar todos los temas obligatorios;
5. corrección con `gradeAttempt` (todo o nada);
6. intento + progreso (+ archivo de versión anterior) en **una** llamada
   transaccional al almacén.

La respuesta contiene solo el resultado: `passed`, `correctCount`,
`totalQuestions`, `score`, `incorrectQuestionIds`, `unansweredQuestionIds` y
estado agregado. **Nunca** las opciones correctas, ni siquiera al suspender.

### 2.4 Adaptadores Firestore

- `src/server/firebase/catalog-store.ts` — `saveVersion` y `publishVersion` en
  transacción; `getAnswerKeys` fusiona claves por evaluación; todas las
  operaciones pasan por `guard()` (503 si Firebase no está disponible) y
  `throwIfLeaking` antes de escribir.
- `src/server/firebase/learning-store.ts` — `commitAttempt` transaccional:
  escribe el histórico de la versión anterior, el intento y el progreso nuevo
  en el mismo commit.

### 2.5 Scripts operativos

| Comando | Qué hace | Escribe |
| --- | --- | --- |
| `npm run db:init` | conectividad + inventario de colecciones + qué escribiría | no |
| `DB_INIT_CONFIRM=yes npm run db:init -- --apply` | escribe `meta/schema` | sí |
| `npm run db:check` | auditoría completa y prueba de índices | no |

Ambos se niegan a tocar un proyecto real sin `DB_ALLOW_PROD=yes` o sin
`FIRESTORE_EMULATOR_HOST`. `db:check` sale con código 1 si hay errores, para
poder usarlo en integración continua.

La lógica de auditoría (`src/server/db/checks.ts`) está **separada** de los
scripts y no importa nada: recibe datos ya leídos. Por eso sus 27 pruebas se
ejecutan hoy sin Firebase.

Comprobaciones de `db:check`: esquema inicializado y en versión; al menos un
administrador y todos creados por el arranque (la importación nunca concede
admin); roles, estados y `claimsVersion` válidos; usuarios duplicados; curso
publicado que apunta a versión existente, publicada y con claves; claves
huérfanas; progreso de cursos sin publicar o en versiones futuras; intentos no
corregidos en servidor; aprobados con menos de todas las respuestas correctas.

### 2.6 Índices y reglas

- `firestore.indexes.json`: de 2 a **6 índices compuestos**, solo los que usan
  las consultas reales (`accounts`, `progress` ×2, `attempts` ×2, `documents`).
- `firestore.rules`: añadida la regla explícita de `meta/{docId}` cerrada. El
  resto de colecciones nuevas ya tenían regla de la fase 2.

---

## 3. Verificación real

| Comprobación | Resultado |
| --- | --- |
| `npm run typecheck` | **0 errores** |
| `npm run lint` | **0 errores, 0 avisos** |
| `npm test` | **332 pasan / 20 ficheros** (eran 236 / 15) |
| `npm run build` | **OK** |
| `npm run verify` | **exit 0** |
| `npm run db:init` sin configuración | **exit 1** — «Falta FIREBASE_PROJECT_ID» |
| `npm run db:check` sin configuración | **exit 1** — se niega a apuntar a producción |
| `npm run db:init` con emulador inalcanzable | **exit 1** — «14 UNAVAILABLE: No connection established» |

Pruebas nuevas (96):

| Fichero | Casos | Cubre |
| --- | --- | --- |
| `tests/server/schema.test.ts` | 18 | ids compuestos, rechazo de ids peligrosos, validación de documentos |
| `tests/server/schema-drift.test.ts` | 13 | esquema ↔ reglas ↔ índices ↔ documentación |
| `tests/server/catalog-service.test.ts` | 17 | borradores, publicación, claves separadas, no-fuga, archivado |
| `tests/server/assessment-service.test.ts` | 19 | corrección, bloqueos, cambio de versión, no-fuga |
| `tests/server/db-checks.test.ts` | 27 | cada hallazgo de `db:check` |

La prueba más importante es la de no-fuga: comprueba el **conjunto exacto de
campos** devueltos por `submitAssessment`, no solo que no aparezca la cadena
`correctOptionIds`. Si alguien añade mañana un campo que revele la respuesta,
la prueba falla.

---

## 4. Límites: qué NO está verificado

1. **Nada se ha ejecutado contra Firestore.** No hay proyecto Firebase y el
   emulador sigue sin poder arrancar (falta JVM; ya se cerraron cuatro vías en
   la fase 2). Los adaptadores compilan; sus transacciones **no** se han
   ejecutado. Consecuencias concretas:
   - no está probado que `publishVersion` deje el sistema en estado coherente
     si dos administradores publican a la vez;
   - no está probado que los índices declarados sean suficientes (solo que
     `db:check` los ejecutará);
   - no está probado el comportamiento real de `guard()` ante un fallo de red
     a mitad de transacción.
2. **Las reglas siguen sin ejecutarse**: 0 de 44 pruebas (más la regla nueva de
   `meta`, tampoco compilada). El compilador de reglas solo existe dentro del
   emulador.
3. **`db:init` / `db:check` camino feliz sin probar** (requiere credenciales).
   Sí está probado que fallan cerrados.
4. **No hay endpoint HTTP de evaluaciones**: el servicio existe y está probado,
   pero la ruta `/api/assessments/...` es de la fase 4, junto con la
   autenticación real del alumno.
5. **La subida de PDF no se ha implementado**: `documents` se lee, todavía no
   se escribe. Falta decidir el flujo de subida y firma.

Riesgos que siguen abiertos (sin cambios respecto a la fase 2): R1/R2 reglas
sin ejecutar (alto), R3 sin límite de peticiones en `/api/activate`, R4 URL
firmada, R6 metadatos de documentos, R7 sin MFA de administración, R8 registro
público abierto en Firebase Auth, R9 avisos de dependencias.

---

## 5. Cómo crear el proyecto Firebase y dejarlo operativo

> **Nota (fase 4, 21/10/2026):** este apartado se escribió asumiendo el plan
> Blaze. El proyecto funciona ahora en el **plan Spark**: no se activa Storage,
> no se despliega `storage.rules` (ya no existe) y el paso 4 se reduce a
> `firebase deploy --only firestore:rules,firestore:indexes`. Ver
> [`INFORME-FASE-4.md`](INFORME-FASE-4.md).

No se ha hecho: la orden excluía crear el proyecto real. Estos son los pasos
exactos, en orden, con lo que hay que comprobar en cada uno.

### Paso 0 — Requisitos

- Cuenta de Firebase con facturación Blaze (Storage y funciones de servidor).
- `firebase-tools` instalado (ya está en `devDependencies`).
- Un JDK 11+ en la máquina que ejecute las pruebas de reglas.

### Paso 1 — Crear el proyecto

```bash
firebase login
firebase projects:create formacion-us --display-name "Formación U.S."
firebase use formacion-us
```

Elegir **región europe-west1** (Bruselas) o **europe-southwest1** (Madrid):
está pendiente de decisión y afecta a latencia y a la ubicación de los datos
personales (RGPD). Firestore **no** se puede mover de región después.

### Paso 2 — Activar servicios

1. **Firestore** en modo nativo, región elegida.
2. **Storage** en la misma región (los PDF no deben cruzar de región).
3. **Authentication** → proveedor **Correo/contraseña**, y **desactivar** el
   registro público ("Allow new users to sign up": off). Si se deja abierto,
   cualquiera puede crearse una cuenta de Auth (R8); las reglas impedirían el
   acceso a datos, pero es ruido y superficie innecesaria.
4. **App Web** para obtener la configuración del cliente (solo si la fase 4 la
   necesita; hoy el cliente no habla con Firestore).

### Paso 3 — Cuenta de servicio para el servidor

Consola → Configuración del proyecto → Cuentas de servicio → Generar clave
privada. Rellenar `.env.local` a partir de `.env.example`:

```
FIREBASE_PROJECT_ID=formacion-us
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-...@formacion-us.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
SESSION_COOKIE_SECRET=<32+ bytes aleatorios>
```

La clave privada va **con `\n` escapados** y nunca al repositorio. El
`.env.local` está en `.gitignore`.

### Paso 4 — Desplegar reglas e índices

```bash
firebase deploy --only firestore:rules,firestore:indexes,storage
```

Con el JDK disponible, antes del despliegue:

```bash
npm run test:rules   # 44 pruebas + la nueva de meta
```

**No desplegar sin que esas pruebas pasen.** Los índices tardan minutos en
construirse; `firebase firestore:indexes` muestra el estado.

### Paso 5 — Inicializar y auditar

```bash
npm run db:init                                  # simulación
DB_INIT_CONFIRM=yes DB_ALLOW_PROD=yes npm run db:init -- --apply
DB_ALLOW_PROD=yes npm run db:check               # debe salir 0
```

En este punto `db:check` avisará de que **no hay administrador**: es correcto y
esperado. Se resuelve en el paso 6.

### Paso 6 — Primer administrador

```bash
BOOTSTRAP_ADMIN_USERNAMES="rol1.garcia,rol1.perez" node scripts/bootstrap-admins.mjs --dry-run
BOOTSTRAP_ADMIN_USERNAMES="rol1.garcia,rol1.perez" BOOTSTRAP_CONFIRM=yes node scripts/bootstrap-admins.mjs
```

Imprime los códigos de activación **una sola vez** y no los guarda: hay que
entregarlos en mano. Las cuentas se crean en `pending_activation`, sin
contraseña conocida.

Después, `db:check` debe salir **0**. Ese es el criterio de "base de datos
operativa": esquema inicializado, un administrador del arranque, sin errores.

### Paso 7 — Primer curso

Con el panel de administración (fase 4) o con un script: guardar la v1 en
borrador, subir los PDF, publicar la v1. `db:check` verifica que el curso
publicado apunta a una versión existente, publicada y con claves.

---

## 6. Siguiente fase propuesta

1. Endpoint `/api/assessments/submit` (fase 4) sobre `submitAssessment`, con
   sesión de alumno real y límite de peticiones.
2. Endpoint de lectura de páginas + `saveProgress` (progreso de lectura).
3. Subida de PDF a Storage con validación de tipo y tamaño, y escritura de
   `documents`.
4. Panel de administración: crear curso, subir contenido, publicar versión.
5. Con JDK y proyecto: ejecutar `npm run test:rules` y `db:check` de verdad, y
   cerrar R1/R2.

---

## 7. Archivos tocados en esta fase

Nuevos:

```
src/server/db/schema.constants.ts
src/server/db/schema.ts
src/server/db/checks.ts
src/server/courses/catalog.ts
src/server/learning/store.ts
src/server/assessments/service.ts
src/server/firebase/catalog-store.ts
src/server/firebase/learning-store.ts
scripts/db-init.ts
scripts/db-check.ts
tests/helpers/db-doubles.ts
tests/server/schema.test.ts
tests/server/schema-drift.test.ts
tests/server/catalog-service.test.ts
tests/server/assessment-service.test.ts
tests/server/db-checks.test.ts
docs/INFORME-FASE-3.md
```

Modificados:

```
firestore.indexes.json   (2 → 6 índices)
firestore.rules          (regla de meta)
package.json             (scripts db:init, db:check; devDependency tsx)
docs/MODELO-DATOS.md     (progressHistory, meta, índices, inicialización)
docs/ARQUITECTURA.md     (§4.6 persistencia, evaluación en servidor)
docs/PRUEBAS.md          (§9 fase 3)
README.md                (comandos y aviso de fase 3)
```

Sin commits ni push: el trabajo está en el árbol de trabajo de la rama
`arena/89a0aca0-formacion-u-s`.
