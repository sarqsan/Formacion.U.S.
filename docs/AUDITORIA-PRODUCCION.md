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

**Límites, explícitos:**

- Redactar **no** es anonimizar en origen: los datos siguen en Firestore.
- El veredicto (`summarize`) se calcula sobre los hallazgos originales; la
  redacción solo afecta a la impresión. Hay una prueba que lo fija.
- El SDK de Firestore (`grpc-js`) puede escribir avisos propios en `stderr`
  (por ejemplo `MetadataLookupWarning`). No incluyen datos de documentos, pero
  son un canal fuera del verificador. Por eso el workflow **no** publica
  artefactos: el único resumen es el de §3.
- El repositorio es **público**: los registros de Actions los ve cualquiera.
  La defensa real es que el verificador redacte antes de imprimir, no limpiar
  después un registro ya contaminado.

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
- Acciones fijadas a SHA completos:
  - `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` (v4.2.2)
  - `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (v4.3.0)
- Sin despliegues, escrituras, migraciones, inicializaciones ni artefactos.

### Configuración externa pendiente

1. Crear el entorno `production-audit` con **revisor obligatorio**.
2. Crear la cuenta de servicio de solo lectura (§5) y sus dos secretos **en el
   entorno**: `FIREBASE_CLIENT_EMAIL` y `FIREBASE_PRIVATE_KEY`.
3. No definir esos dos nombres también como secretos del repositorio: GitHub
   resuelve el entorno con reserva a los del repositorio, y entonces las
   credenciales dejarían de ser exclusivas del entorno.
4. (No verificable desde aquí) Confirmar que la rama `main` está protegida y
   que los secretos del repositorio y del entorno no contienen credenciales de
   escritura.

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

Sí, según la documentación de permisos por método de Firestore nativo:

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

**No verificado en ejecución real:** la primera ejecución autorizada debe
confirmarlo. Si el rol fuera insuficiente, la salida sería `AUDIT_BLOCKED` (con
`PERMISSION_DENIED` en el mensaje), nunca `NO_ADMIN`. En ese caso se amplía el
rol de forma justificada y revisada, no se usa una cuenta con escritura.

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
npm run verify
```

Las pruebas de redacción usan datos sintéticos y no hacen ninguna llamada de
red. La única prueba contra Firebase real es la ejecución manual del workflow,
que sigue pendiente de autorización y de la configuración externa de §4.
