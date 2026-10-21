# Informe de la fase 7 — cierre de validación real y preparación para uso controlado

**Fecha:** 21 de octubre de 2026
**Rama:** `arena/89a0aca0-formacion-u-s` (base `c4ce33d`, **0 commits, 0 push, 0 despliegues**)
**Alcance:** ejecutar lo que la Fase 6 dejó pendiente, implementar la copia de
seguridad y restaurarla con datos sintéticos. Sin Blaze, sin tarjetas, sin
cuentas nuevas, sin desplegar, sin datos reales y sin tocar el Gestor de
Personal y Cuadrantes.

---

## Veredicto

> **NO LISTA para uso real.** El bloqueo del emulador persiste y no depende de
> este repositorio: la red de este entorno corta el TLS hacia
> `storage.googleapis.com` en el *ClientHello*. Sin emulador, las **41 pruebas
> de reglas siguen sin ejecutarse** y las pruebas de integración de Firestore
> quedan escritas pero omitidas.
>
> **Preparada para pruebas controladas en servidor con datos sintéticos**, y con
> la copia de seguridad ya implementada y su recorrido completo probado
> (exportar → cifrar → descifrar → restaurar → comparar), aunque el I/O real de
> Firestore de esa copia tampoco se ha podido ejecutar.

| Apartado de la orden | Estado | Evidencia |
| --- | --- | --- |
| 1. Ejecutar las 41 pruebas de reglas | **Bloqueado** (externo, documentado con evidencia) | §1 |
| 2. Validar subida de PDF contra Firestore | **Parcial**: tamaño medido de verdad; transacción y concurrencia pendientes | §2 |
| 3. Copia de seguridad y restauración | **Implementada**; recorrido probado con datos sintéticos; **restauración contra Firestore NO probada** | §3 |
| 4. Verificación final | **Ejecutada**: `npm run verify` → exit 0 | §4 |
| 5. Informe | Este documento | — |

---

## 1. Las 41 pruebas de reglas: por qué no se han podido ejecutar

### 1.1 Lo que se ha resuelto (la JVM ya no es el problema)

En la Fase 6 se consiguió una JVM sin instalar nada en el ordenador del usuario:

```
pip download jdk4py            # wheel de PyPI, 35 MB, en /tmp
chmod +x /tmp/jdkpkg/jdk4py/java-runtime/bin/*
java -version                  # openjdk 25.0.2 (Temurin)
```

Comprobado de nuevo hoy. `firebase emulators:exec` ya no se queja de Java.

### 1.2 Lo que falla, con evidencia reproducible

```
$ npm run test:rules
i  emulators: Starting emulators: firestore
i  firestore: downloading cloud-firestore-emulator-v1.22.0.jar...
Error: Failed to make request to https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.22.0.jar
```

La causa exacta, aislada paso a paso:

| Comprobación | Resultado | Conclusión |
| --- | --- | --- |
| DNS de `storage.googleapis.com` | resuelve (`2607:f8b0:400e…`, `104.154.125.27`) | no es DNS |
| Conexión TCP al 443 | **abre** | no es un puerto cerrado |
| `curl -v https://storage.googleapis.com/` | envía `TLS ClientHello` y recibe `SSL_ERROR_SYSCALL` (conexión cortada) | el corte es en el saludo TLS |
| Mismo intento a `dl.google.com`, `firebase.tools`, `repo1.maven.org`, `registry-1.docker.io`, `raw.githubusercontent.com`, `objects.githubusercontent.com` | mismo corte | no es un fallo puntual de un host |
| `registry.npmjs.org`, `pypi.org`, `github.com`, `api.github.com` | **200** | la política de salida permite solo estos |

Es decir: **filtro de salida por nombre de host (SNI)**, no un problema de
certificados, ni de Java, ni de `firebase-tools`. No se ha intentado eludirlo
(sería justo lo que la orden prohíbe: desactivar o saltarse la validación TLS y
traer ejecutables de fuentes no verificadas).

### 1.3 Alternativas evaluadas y descartadas (con motivo)

| Vía | Resultado |
| --- | --- |
| Descargar el jar desde `storage.googleapis.com` | bloqueado (arriba) |
| Paquete npm con el jar dentro | buscado por nombre y descripción (`firestore emulator`, `cloud-firestore-emulator`, `firebase emulators`, `firestore emulator jar`, ~250 resultados): **no existe**. `google-datastore-emulator` y `firebase-emulators` son envoltorios de 8 KB y 3 KB sin binario |
| Reimplementaciones en Node (`@firestore-emulator/server`, `hidane`, `fireemu`, `fireenook`) | **descartadas**: no son el emulador de Firebase y no validan *estas* reglas; usarlas como equivalente sería exactamente la sustitución que la orden prohíbe |
| Repositorio `jacobg/cloud-firestore-emulator` (GitHub) | contiene el jar **descompilado** (9 108 `.java` + recursos, sin `.class`). Reconstruirlo no daría el artefacto oficial y no es verificable: descartado |
| Imagen de Docker con el emulador | `registry-1.docker.io` y `ghcr.io` bloqueados |
| `FIRESTORE_EMULATOR_BINARY_PATH` (override de `firebase-tools`) | existe y está listo, pero no hay jar que apuntar |
| Maven Central para compilar el emulador | `repo1.maven.org` bloqueado |

### 1.4 Consecuencia

- **41 pruebas de reglas escritas, 0 ejecutadas.** No se ha tocado ninguna regla
  para que pase nada.
- Las reglas de `enrollments` (nuevas en la Fase 6) siguen **sin verificación
  empírica**. Es el riesgo abierto más importante del proyecto.
- En un equipo con salida a `storage.googleapis.com` basta `npm run test:rules`;
  no hay que cambiar nada más.

---

## 2. Subida de PDF: lo que ahora sí está medido

### 2.1 Qué se ha medido (y con qué)

Los límites de Firestore (1 MiB por documento, 10 MiB por petición) se aplican
al **protobuf codificado**. Hasta ahora todo eran cuentas. Ahora hay una medición
real del payload con el **serializador oficial** de `@google-cloud/firestore` y
los **protos oficiales** (`google.firestore.v1.Document` y `CommitRequest`)
codificados con `protobufjs`:

```
npm run firestore:size
```

| PDF | Fragmentos | Documento mayor | Commit total | ≤1 MiB/doc | ≤10 MiB/petición |
| --- | --- | --- | --- | --- | --- |
| 1 MiB | 2 | 768,2 KiB | 1,00 MiB | sí | sí |
| 5 MiB | 7 | 768,2 KiB | 5,00 MiB | sí | sí |
| **8 MiB (tope actual)** | **11** | **768,2 KiB** | **8,00 MiB** | **sí** | **sí** |
| 9 MiB | 12 | 768,2 KiB | 9,00 MiB | sí | sí (1 MiB de margen) |
| **20 MiB (diseño anterior)** | **27** | 768,2 KiB | **20,01 MiB** | sí | **NO** |

Esto confirma con números medidos —no estimados— lo que la Fase 6 dedujo por
aritmética: el diseño anterior **no cabía** en una petición de Firestore (20,01
MiB frente a 10 MiB). Con el tope actual sobran 2 MiB.

Estas cifras las vigila la batería normal (`tests/server/firestore-wire-size.test.ts`,
6 casos): si alguien cambia el tope, el tamaño de fragmento o añade campos a los
metadatos, falla antes de llegar a producción.

### 2.2 Qué NO está medido todavía

- **Atomicidad real**: que la transacción escriba los 11 fragmentos + metadatos
  + contador o nada. Está probado con un doble que reproduce la transacción,
  pero no contra Firestore.
- **Concurrencia real**: dos subidas simultáneas y el reintento de Firestore.
- **Que el servidor acepte** 8 MiB en una transacción: el límite está
  documentado, medido el payload, pero no confirmado por el servidor.

Todo eso está escrito en `tests/integration/firestore-emulator.test.ts` (4
casos). Hoy se ejecuta con `npm run test:firestore`, que arranca el emulador; sin
emulador, los 4 casos se **omiten** (no se finge que pasan).

### 2.3 Por qué no se ha usado el proyecto real

La orden lo prohíbe sin autorización y, además, sería la peor idea posible:
subir 8 MiB de prueba consume cuota de escritura, egreso de red y altera el
contador de cuota. No se ha hecho.

---

## 3. Copia de seguridad y restauración

### 3.1 Qué se ha implementado

| Pieza | Fichero | Qué hace |
| --- | --- | --- |
| Formato y cifrado | `src/server/backup/{archive,crypto}.ts` | Archivo `.fbak`: firma, bloques cifrados por colección y manifiesto al final |
| Codificación | `src/server/backup/codec.ts` | `Bytes`, `Timestamp` y mapas anidados sobreviven al viaje (JSON con etiquetas) |
| Exportación | `src/server/backup/export.ts` | Recorre todas las colecciones, incluidas subcolecciones (`courses/{id}/versions`) |
| Restauración | `src/server/backup/restore.ts` | Verifica, trocea en lotes (≤400 documentos y ≤6 MiB) y escribe |
| Adaptador real | `src/server/firebase/backup-store.ts` | Admin SDK: enumera, lee por flujo y escribe lotes |
| CLI | `scripts/backup-export.ts`, `scripts/backup-restore.ts` | `npm run backup:export`, `npm run backup:restore` |

Contenido de la copia: cuentas, `usernames`, `activationTokens` (solo el hash),
`audits`, `courses` y sus versiones, `answerKeys`, `enrollments`, `progress`,
`progressHistory`, `attempts`, `documents`, `pdfChunks` (binario) y `meta`
(esquema y contador de cuota). Todo lo necesario para reconstruir el
funcionamiento salvo lo que no es legible (§3.5).

### 3.2 Cómo se protege

- **AES-256-GCM** con clave derivada por **scrypt** (N=32768, r=8, p=1), sal
  única por archivo e IV aleatorio por bloque.
- La contraseña se toma de `BACKUP_PASSPHRASE` (mínimo 12 caracteres). **No** se
  escribe en el archivo, ni en el manifiesto, ni en los logs.
- El manifiesto solo lleva metadatos: nombres de colección, número de
  documentos, tamaños y parámetros criptográficos. **Ni un solo dato.**
- Cada bloque lleva el SHA-256 del texto plano además de la etiqueta GCM: se
  detecta tanto una contraseña incorrecta como una copia manipulada.
- Restaurar sobre un destino con datos exige `--force`; escribir en un proyecto
  real exige `BACKUP_ALLOW_PROD=yes`.
- `.gitignore` excluye `/backups/` y `*.fbak`: una copia nunca se sube al
  repositorio.

Comprobado en pruebas: el archivo en disco **no** contiene el apellido de un
alumno, ni el nombre de usuario, ni el título del curso, ni las claves de
corrección, ni los bytes del PDF, ni la contraseña.

### 3.3 La prueba de restauración (datos sintéticos, aislada)

`tests/server/backup.test.ts` — **19 casos ejecutados** con un almacén en
memoria que reproduce las invariantes de Firestore (rutas planas con
subcolecciones, Bytes, escritura atómica por lote):

1. se exporta un conjunto sintético de 15 documentos en 14 colecciones;
2. se comprueba que el archivo no tiene nada legible;
3. se restaura en un almacén vacío y se compara **documento a documento**
   (`canonicalJson`) contra el original: **idénticos**, incluidos los 4 KiB
   binarios del fragmento de PDF;
4. `--dry-run` valida sin escribir nada;
5. con contraseña incorrecta **no se escribe nada**;
6. con un byte alterado del bloque cifrado, falla y no escribe;
7. con un manifiesto que declara un documento de más, falla (`BACKUP_COUNT_MISMATCH`);
8. un fallo en el lote 3 deja los lotes anteriores escritos y **no declara la
   restauración como buena** (por eso la restauración no es atómica global: §3.5);
9. los lotes nunca superan el tamaño configurado;
10. un archivo ajeno o una versión no soportada se rechazan.

**Esto prueba la lógica del formato, el cifrado y la restauración. NO prueba el
I/O de Firestore**: el adaptador real no se ha ejecutado. Por eso la
restauración **no se declara terminada**, solo implementada y probada en
aislado.

### 3.4 Cómo se ejecuta (cuando haya entorno)

```bash
export BACKUP_PASSPHRASE='frase larga y distinta para cada copia'
npm run backup:export  -- --out backups/2026-10-21.fbak    # imprime SHA-256
npm run backup:restore -- --in backups/2026-10-21.fbak --dry-run   # valida
npm run backup:restore -- --in backups/2026-10-21.fbak             # restaura
```

Contra el emulador, añadiendo `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`. Contra
un proyecto real, `--force` si el destino tiene datos y `BACKUP_ALLOW_PROD=yes`.

### 3.5 Límites de consistencia (declarados)

1. **No hay instantánea global**: se recorren colecciones sin transacción
   global. Si alguien escribe durante la exportación, la copia puede mezclar dos
   instantes. Para una copia coherente, hacerla con la aplicación parada.
2. **No incluye Firebase Authentication**: usuarios, contraseñas y sesiones no
   son legibles. Tras restaurar hay que recrear las cuentas de Auth y volver a
   activar a las personas (o aceptar que los `uid` cambien y remapear). Es el
   límite más importante de la restauración.
3. **La restauración no es atómica global**: escribe por lotes; si falla a
   mitad, queda un estado parcial. Se detecta y se informa, pero hay que volver
   a ejecutar sobre un destino vacío.
4. **El manifiesto revela volúmenes**: número de documentos por colección y
   fecha. No revela contenido.
5. **No hay rotación de contraseñas ni verificación de que dos copias sean
   iguales** más allá del SHA-256 por bloque (que sí se comprueba).

---

## 4. Verificación final

```
npx tsc --noEmit     → 0 errores
npm run lint         → 0 errores, 0 avisos
npx vitest run       → 28 ficheros OK + 1 omitido; 470 pruebas OK + 4 omitidas
npm run build        → OK (14 rutas)
npm run verify       → exit 0
```

Las 4 omitidas son las de integración (`tests/integration/firestore-emulator.test.ts`):
se omiten cuando `FIRESTORE_EMULATOR_HOST` no está definido y **no cuentan como
superadas**.

### 4.1 Repaso del checklist de la orden

| Comprobación | Cómo está cubierta | Estado |
| --- | --- | --- |
| La lectura exige cuenta activa y matrícula válida | `document-service.test.ts` (sin matrícula, revocada, otro curso, actor no activo) + `assertActiveAccount`/`assertCourseAccess` | ✅ ejecutado |
| No se puede saltar la secuencia | `PAGE_OUT_OF_ORDER` si `from` no es exactamente la siguiente; campos `lastPageViewed`/`completedAt` del cliente ignorados | ✅ ejecutado |
| Los límites no se eluden con parámetros del cliente | clave del limitador = `pdf:{uid de la sesión}`; coste = rango calculado en servidor; `readPagesQuery` descarta todo lo que no sea `from`/`to` (4 casos nuevos) | ✅ ejecutado |
| Las respuestas correctas no llegan al navegador | `answerKeys` cerrado en reglas; la corrección devuelve solo aprobado/incorrectas; prueba explícita | ✅ ejecutado (servicio) |
| Las operaciones de administración exigen autorización del servidor | `assertAdmin` sobre el actor de sesión; prueba con `role:"admin"` en el cuerpo → 403 | ✅ ejecutado |
| Los errores y las revocaciones no dejan accesos abiertos | error genérico sin detalles; revocación a mitad de curso cierra lectura y evaluación y **no** deja avanzar el progreso (caso nuevo) | ✅ ejecutado |
| Reglas de Firestore | 41 escritas | ❌ **0 ejecutadas** |
| Transacción real de subida | 4 casos escritos | ❌ **0 ejecutados** |

---

## 5. Qué impide todavía usar la aplicación con usuarios reales

Por orden de gravedad:

1. **Las 41 pruebas de reglas no se han ejecutado.** El código y las reglas
   podrían discrepar (por ejemplo, una regla que exige un campo que el código no
   escribe) y no lo sabríamos. **Bloqueante.**
2. **La subida real nunca se ha probado.** El tamaño está medido, pero no
   confirmado por el servidor; la atomicidad y la concurrencia solo están
   probadas con dobles. **Bloqueante para cargar contenido.**
3. **La restauración no se ha probado contra Firestore** ni existe todavía un
   ensayo de recuperación completo (crear proyecto desechable, exportar,
   destruir, restaurar, comparar, medir tiempo). **Bloqueante para datos
   reales.**
4. **Los usuarios de Firebase Authentication no están en la copia**: hay que
   definir el procedimiento de re-activación tras una restauración.
5. **Sin panel de matrícula**: hoy se matricula por API. Un administrador sin
   consola no puede matricular desde la interfaz.
6. **El límite de peticiones es por proceso**: con varias instancias se
   multiplica.
7. **El egreso de 10 GiB/mes** sigue siendo el techo real de uso: superarlo
   apaga el proyecto hasta el mes siguiente. No se declara el coste cero como
   garantizado.

---

## 6. Cambios de esta fase, fichero a fichero

**Nuevo**

- `src/server/firestore/wire-size.ts` — medición del payload con el serializador
  y los protos oficiales.
- `src/server/backup/{codec,crypto,archive,export,restore,store}.ts` — copia de
  seguridad cifrada.
- `src/server/firebase/backup-store.ts` — adaptador de Firestore (sin ejecutar).
- `scripts/backup-export.ts`, `scripts/backup-restore.ts`,
  `scripts/firestore-size-check.mjs`.
- `tests/server/backup.test.ts` (19), `tests/server/firestore-wire-size.test.ts`
  (6), `tests/integration/firestore-emulator.test.ts` (4, omitidos),
  `tests/helpers/backup-double.ts`.

**Modificado**

- `tests/server/document-service.test.ts` — +4 casos (cuota por usuario de
  sesión, coste no manipulable, cuotas separadas, revocación sin avance de
  progreso).
- `tests/server/document-pages-endpoint.test.ts` — +1 caso (parámetros extra
  ignorados).
- `package.json` — `backup:export`, `backup:restore`, `firestore:size`,
  `test:firestore`.
- `.gitignore` — `/backups/`, `*.fbak` (una copia nunca al repositorio).
- `README.md`, `docs/MODELO-DATOS.md`, `docs/SEGURIDAD.md`,
  `docs/PRUEBAS.md` (§12), `docs/DECISIONES.md` (ADR-017).

**Sin tocar**: Gestor de Personal y Cuadrantes, Firebase real, configuración de
despliegue, reglas (no se ha ajustado ninguna para "hacer pasar" pruebas).

---

## 7. Resumen ejecutivo

Se ha agotado lo que se puede hacer sin red hacia Google. La JVM ya no es un
problema (se resolvió con `jdk4py`); el bloqueo real es un filtro de salida que
corta el TLS hacia `storage.googleapis.com` en el saludo inicial, y las rutas
alternativas (npm, PyPI, GitHub, Docker, Maven) no contienen el emulador
oficial. **Las 41 pruebas de reglas siguen sin ejecutarse** y eso, por sí solo,
impide declarar la aplicación lista para uso real.

Lo que sí se ha cerrado: el tamaño del payload de subida está **medido** con el
serializador oficial (8,00 MiB de commit, 2 MiB de margen; el diseño anterior
medía 20,01 MiB y no cabía), y existe una **copia de seguridad cifrada con
recorrido completo probado**: 15 documentos sintéticos exportados, cifrados,
descifrados y restaurados **idénticos**, con detección de manipulación,
contraseña incorrecta y manifiesto falsificado. El I/O de Firestore de esa copia
y de esa subida está escrito y pendiente de ejecución.

`npm run verify` → **exit 0** (470 pruebas en verde, 4 omitidas declaradas, build
correcto).

**Veredicto: NO LISTA para uso real.** Sí preparada para pruebas controladas en
servidor con datos sintéticos, y con un camino corto para cerrar el bloqueo: en
un equipo con salida a Google, `npm run test:rules` y `npm run test:firestore`
ejecutan las 45 pruebas que aquí no han podido correr.
