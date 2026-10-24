# Auditoría de producción — verificador, redacción y cuenta de servicio

Estado: **preparado, no ejecutado**. No se ha creado ninguna cuenta de
servicio, no se ha tocado IAM, no se han creado secretos ni entornos en
GitHub, y no se ha ejecutado ninguna consulta contra el proyecto real.

Este documento describe lo que ya está en el repositorio y lo que falta
**fuera** de él.

---

## 1. Qué hace la auditoría

`npm run db:check` (`scripts/db-check.ts`) es un verificador **de solo
lectura**. No escribe, no migra, no inicializa y no usa Firebase Auth.

- Comprueba conectividad real leyendo `meta/schema`.
- Ejecuta las consultas compuestas reales de la aplicación para detectar
  índices que faltan (`FAILED_PRECONDITION`).
- Lee `accounts`, `courses`, `answerKeys`, `progress`, `attempts` (máximo 2000
  documentos por colección), `meta/storage` y las versiones de cada curso.
- Aplica `runChecks()` (`src/server/db/checks.ts`, módulo puro) y resume los
  hallazgos.

Código de salida: `0` sin hallazgos `error`, `1` con algún `error`. Solo
`severity === "error"` bloquea (ADR-023).

`NO_ADMIN` es un `error`, así que **el código de salida no distingue** «no hay
administrador» de «fallo técnico». Por eso el estado se decide por códigos de
diagnóstico (§3).

## 2. Redacción (`--redact`)

```bash
npm run db:check -- --redact
```

Sin el flag, la salida es la de siempre (salvo el saneado de la línea
siguiente, que se aplica siempre). Con el flag:

- Los identificadores personales (`username`, `uid`, `createdBy` y correos) se
  sustituyen **antes de imprimir** por etiquetas estables: `usuario#N`,
  `uid#N`, `origen#N` (`src/server/db/redact.ts`).
- El índice incluye **todas** las fuentes de identificadores que pueden
  imprimirse: `accounts` y también los `uid` de `progress` y `attempts`. Un
  `uid` sin cuenta —cuenta borrada o `rollbackAccount` fallido— se redacta
  igualmente. Como el índice se construye con las **mismas listas** que se
  pasan a `runChecks`, el límite `MAX_DOCS = 2000` no puede dejar fuera un
  valor imprimible: lo que no se leyó tampoco se recorre.
- Se conservan niveles, códigos, recuentos, `courseId` y el número de
  referencias de cada hallazgo. La misma etiqueta para el mismo valor permite
  correlacionar hallazgos dentro de un mismo informe.
- Filtro genérico para lo que no está inventariado: correos, bloques de clave
  privada, tokens (`ya29.`, `1//`, `AIza…`), cadenas opacas de 40+ caracteres,
  UUID y UID con forma de Firebase (20–40 caracteres con mayúsculas,
  minúsculas y dígitos).
- **Saneado de líneas** (`sanitizeText`): `\n`, `\r`, `\t` y demás caracteres
  de control (incluidos U+0085, U+2028 y U+2029) se sustituyen por caracteres
  visibles (`␤`, `␍`, `␉`) **antes** de componer la línea. Se aplica con y sin
  `--redact`, en los hallazgos, las referencias, la cabecera, los errores y los
  mensajes de Firestore: un `courseId` o un `status` manipulado no puede
  fabricar líneas ni una línea falsa `AUDITORÍA: …`.
- Segunda capa (`guardLine`): si una línea preparada para imprimir todavía
  contuviera un identificador conocido, un correo o una forma de identificador
  que el índice no conocía, se sustituye la línea entera por
  `[línea omitida: contenía un identificador]`. Es una red de seguridad, no el
  mecanismo principal: lo que garantiza la cobertura es el índice y el saneado.
- Cualquier fallo de configuración, conexión o ejecución imprime
  `AUDIT_BLOCKED` y **nunca** `NO_ADMIN`.
- Un argumento desconocido aborta la ejecución en lugar de correr sin redactar.
- **Canal `stderr` del SDK.** Con `--redact`, el verificador intercepta
  `process.stdout` y `process.stderr` (`installStreamGuard`): todo lo que
  escribe el proceso —incluidos los avisos del SDK de Firebase/gRPC, como
  `MetadataLookupWarning` o los mensajes de `UNAVAILABLE`— pasa por el mismo
  filtro. Además, al terminar de imprimir el estado, la salida se **sella**:
  ninguna escritura posterior puede producir una línea que empiece por
  `AUDITORÍA: ` o `Resumen: ` (se marca `[omitido] …`).

**Límites, explícitos** (lo que la redacción NO garantiza):

| Límite | Alcance real |
| --- | --- |
| `guardLine` | Solo actúa sobre líneas que pasan por `formatFindingLines`. No es un filtro global: es una red de seguridad para hallazgos y referencias. |
| Umbral de longitud (`MIN_VALUE_LENGTH = 3`) | Un `username` o `createdBy` de 1–2 caracteres no entra en el índice. Riesgo bajo: `USERNAME_MIN_LENGTH = 4` y la importación valida con `assertValidUsername`. Un `createdBy` corto tampoco se redacta. |
| Filtro por forma (UUID y UID tipo Firebase) | Es **heurístico**: exige 20–40 caracteres con mayúsculas, minúsculas y dígitos, o un UUID. Un identificador con otra forma y sin cuenta asociada no lo detectaría. La garantía real es el índice con `accounts` + `progress.uid` + `attempts.uid`. |
| Saltos de línea dentro de un chunk de stream | Un stream no distingue un salto legítimo de uno inyectado. Por eso los **datos** se sanean antes de escribirse (nunca llegan saltos crudos a la salida) y, tras el sellado, las líneas reservadas se neutralizan. Un aviso del SDK con saltos **antes** del sellado solo podría añadir líneas ajenas, no suplantar el estado: el workflow se queda con la última. |
| `grpc-js` escribe fuera del proceso | Un mensaje que emita Google en el servidor (no en el cliente) no pasa por aquí. No hay forma local de garantizarlo. |
| Redactar **no** es anonimizar en origen | Los datos siguen en Firestore; esto solo controla lo que se imprime. |
| El índice no es un inventario completo | Se construye con lo que se leyó: si una lectura se trunca (`MAX_DOCS`), lo no leído no se recorre ni se imprime, pero tampoco se audita. |

Otros límites:

- El veredicto (`summarize`) se calcula sobre los hallazgos originales; la
  redacción solo afecta a la impresión. Hay una prueba que lo fija.
- El repositorio es **público**: los registros de Actions los ve cualquiera.
  La defensa real es que el verificador redacte antes de imprimir, no limpiar
  después un registro ya contaminado.
- El workflow **no** publica artefactos: el único resumen es el de §3.

## 3. Estado técnico del informe

Con `--redact` el verificador termina con una sola línea:

```
AUDITORÍA: <AUDIT_BLOCKED | NO_ADMIN | ADMIN_COUNT n> · ESQUEMA: <OK | AUSENTE | INCOMPATIBLE | NO COMPROBABLE> · ÍNDICES: <OK | FALTAN | NO COMPROBABLE>
```

Se deriva de los códigos (`NO_ADMIN`, `SCHEMA_*`, `INDEXES_OK` /
`MISSING_INDEXES`), nunca del código de salida ni de contar líneas: ver
`auditStatus()` en `src/server/db/redact.ts`.

El workflow solo acepta esa línea y la línea `Resumen: …` si encajan
exactamente con el patrón esperado; cualquier otra cosa se descarta y el estado
pasa a `AUDIT_BLOCKED`. Así una cadena inesperada no puede colarse en el
resumen del trabajo.

La garantía principal está en el verificador: sanea los saltos de línea antes
de imprimir, así que no puede existir una línea fabricada. Como refuerzo, el
workflow toma la **última** coincidencia (`tail -n 1`) y no la primera, y
vuelve a validar la forma exacta antes de publicarla.

## 4. Workflow manual

`.github/workflows/db-audit.yml`:

- Disparador único `workflow_dispatch`, **sin parámetros**.
- Solo se ejecuta en `main` (`if: github.ref == 'refs/heads/main'`).
- `permissions: contents: read`.
- Entorno `production-audit` (la aprobación se configura en GitHub, no aquí).
- `FIREBASE_PROJECT_ID=formacionus-63555` y `DB_ALLOW_PROD=yes` fijos: no se
  aceptan proyecto ni comandos como entrada.
- Credenciales solo desde secretos del entorno, expuestas únicamente al paso
  de auditoría.
- Acciones fijadas a SHA completos, con runtime `node24` (Node 20 se retiró de
  los runners el 2026-09-23):
  - `actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` (v5.1.0)
  - `actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444` (v5.0.0)
- Sin despliegues, escrituras, migraciones, inicializaciones ni artefactos.

### Protecciones del workflow y sus pruebas

`tests/server/db-audit-workflow.test.ts` interpreta el YAML y **ejecuta los
bloques `run`** con un `npm` sustituido. Falla si se altera:

- `workflow_dispatch` sin `inputs` y sin otros disparadores;
- `if: github.ref == 'refs/heads/main'`;
- `permissions: contents: read` (y ningún permiso de escritura adicional);
- acciones fijadas por SHA completo con comentario de versión, y sin volver a
  las de Node 20;
- `npm run db:check -- --redact` y propagación del código de salida;
- secretos limitados a `DB_AUDIT_*` y expuestos solo al paso de auditoría;
- ausencia de artefactos, de `GITHUB_ENV` y de impresión de credenciales;
- validación del estado y del resumen: valor multilínea rechazado, línea falsa
  descartada, salida vacía ⇒ `AUDIT_BLOCKED`.

Estas pruebas **no** demuestran la configuración de GitHub ni la ejecución real
del runner: eso es lo de la lista siguiente.

### Configuración externa pendiente (la hace el operador)

1. Crear el entorno `production-audit` **antes** de la primera ejecución, con
   revisor obligatorio, «Allow administrators to bypass configured protection
   rules» **desmarcado** y deployment branches limitado a `main`.
   Si el entorno no existe, GitHub lo crea al vuelo **sin ninguna regla**.
2. Crear la cuenta de servicio de solo lectura (§5) y sus dos secretos **en el
   entorno**, con nombres exclusivos:
   `DB_AUDIT_FIREBASE_CLIENT_EMAIL` y `DB_AUDIT_FIREBASE_PRIVATE_KEY`.
   El workflow los mapea a `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`
   solo dentro del paso de auditoría.
3. No definir esos nombres a nivel de repositorio (ni los genéricos
   `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`, que ya usa la aplicación):
   un secreto de repositorio con el mismo nombre es reserva del de entorno.
4. (No verificable desde aquí) Confirmar que `main` está protegida y que ningún
   secreto del repositorio contiene credenciales de escritura.

## 5. Cuenta de servicio de solo lectura

No se ha creado. Pasos para quien la cree (con permisos de propietario en el
proyecto):

1. Google Cloud → IAM → Cuentas de servicio → crear una cuenta dedicada.
2. Conceder **solo** el rol `roles/datastore.viewer` (consola: «Cloud Datastore
   Viewer»). No conceder `roles/datastore.user` ni roles de editor.
3. Crear una clave JSON y guardar `client_email` y `private_key` como secretos
   del entorno `production-audit`. **No** pegarlos en el chat ni en el
   repositorio.

### ¿Cubre `roles/datastore.viewer` lo que consulta el verificador?

**Deducido de la documentación, NO demostrado en ejecución.** La tabla siguiente
cruza el uso real del SDK (verificado leyendo `scripts/db-check.ts`) con la tabla
oficial de permisos por método. Ninguna prueba local puede confirmarlo: el
emulador no aplica IAM y aquí no hay credenciales.

| Operación del verificador | Método de API | Permiso necesario | ¿En `datastore.viewer`? |
| --- | --- | --- | --- |
| `doc(...).get()` (`meta/schema`, `meta/storage`) | `get` | `datastore.entities.get` | Sí |
| `collection().limit().get()` y consultas `where`/`orderBy` | `runQuery` | `datastore.entities.get`, `datastore.entities.list` | Sí |
| Detección de índice que falta | `runQuery` (responde `FAILED_PRECONDITION`) | los mismos; **no** requiere `datastore.schemas.*` | Sí |
| Lectura de metadatos de la base (inicio del SDK) | `projects.databases.get` | `datastore.databases.getMetadata` | Sí |

Fuentes: «Firestore in Native mode → Security for server client libraries»
(permisos por método y roles predefinidos) y «Firestore in Datastore mode →
IAM». El rol incluye `datastore.entities.get`/`list`, `datastore.schemas.get`/
`list` y `datastore.databases.get`/`getMetadata`, y **no** incluye
`datastore.entities.create/update/delete`: con este rol la cuenta no puede
escribir.

**Comprobaciones que exigirían más permisos:** ninguna de las actuales. Si en el
futuro se añadiera al verificador una lectura de definiciones de índices por
API (`projects.databases.indexes.list`), necesitaría `datastore.schemas.list`
(ya incluido); una exportación o un recuento de estadísticas de Datastore
necesitaría `datastore.statistics.*` o `datastore.databases.export`, que **no**
se deben conceder para esta auditoría.

### Deducido frente a demostrado

| Afirmación | Estado |
| --- | --- |
| El verificador solo usa `get`, `runQuery` y metadatos de base (cero escrituras, cero Auth, cero Storage, cero agregaciones) | **Verificado** leyendo el código (`grep` de métodos de escritura: ninguno) |
| `roles/datastore.viewer` incluye los permisos que exigen esos métodos | **Deducido** de la documentación oficial (tabla de arriba) |
| La cuenta real puede ejecutar esas consultas en `formacionus-63555` | **NO demostrado** |
| La auditoría funciona de extremo a extremo contra producción | **NO demostrado** |

**Verificación pendiente (operador, fuera de esta entrega).** Ninguno de estos
comandos se ha ejecutado aquí:

```bash
# 1. Permisos efectivos del rol
gcloud iam roles describe roles/datastore.viewer --project formacionus-63555

# 2. Que la cuenta solo tenga ese rol
gcloud projects get-iam-policy formacionus-63555 \
  --flatten="bindings[].members" \
  --filter="bindings.members:sa-auditoria@formacionus-63555.iam.gserviceaccount.com"

# 3. Autorización resuelta (sin escribir nada)
gcloud policy-troubleshoot-iam //firestore.googleapis.com/projects/formacionus-63555/databases/(default) \
  --permission=datastore.entities.get --permission=datastore.entities.list

# 4. Primera ejecución del workflow, ya autorizada
```

Si el rol resultara insuficiente, la salida sería `AUDIT_BLOCKED` con
`PERMISSION_DENIED` en el mensaje y **nunca** `NO_ADMIN`. En ese caso se amplía
el rol de forma justificada y revisada, nunca se usa una cuenta con escritura.

Notas:

- Las reglas de seguridad de Firestore **no** se aplican al Admin SDK: con
  `datastore.viewer` la auditoría ve todas las colecciones del proyecto. Es
  lectura, pero conviene saberlo.
- El rol es de proyecto, no por colección. Si se quisiera limitar más, habría
  que usar un rol personalizado con solo `datastore.entities.get` y
  `datastore.entities.list`.
- `firebase-admin` con `cert()` no necesita permisos de Auth, Storage ni IAM
  para estas lecturas.

## 6. Cómo se comprueba esto sin producción

```bash
npx tsc --noEmit
npx vitest run tests/server/db-redact.test.ts
npx vitest run tests/server/db-audit-workflow.test.ts
npm run verify
```

Las pruebas de redacción usan datos sintéticos y no hacen ninguna llamada de
red. La única prueba contra Firebase real es la ejecución manual del workflow,
que sigue pendiente de autorización y de la configuración externa de §4.
