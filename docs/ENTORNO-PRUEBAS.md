# Entorno de pruebas — requisitos y ejecución

Este documento es el que necesita una persona (o una máquina) con acceso al
emulador oficial de Firestore para terminar las comprobaciones que aquí están
**BLOQUEADAS**. Todo lo demás (pruebas unitarias, tipado, lint, build) ya se
ejecuta en cualquier máquina con Node.

> Situación de partida: ver [`INFORME-FASE-7.md`](./INFORME-FASE-7.md) y
> [`ESTADO-FINAL.md`](./ESTADO-FINAL.md). Resumen: **0 de 57** pruebas de reglas
> y **0 de 9** pruebas de integración ejecutadas hasta la fecha.
>
> **Actualización (fase 1 de integración de Firebase, 22/10/2026):** la falta de
> Java **ya no bloquea**: se ha verificado aquí que `pip download jdk4py` deja una
> JVM 25 funcional sin privilegios de administrador. El bloqueo que queda es solo
> de red: el jar del emulador se descarga de `storage.googleapis.com`, que este
> entorno no alcanza (ver §2 bis).

---

## 1. Versiones y requisitos

| Elemento | Requisito | Comprobado aquí |
| --- | --- | --- |
| Node.js | **≥ 22** (`npm run check:env` lo verifica) | 22.22.3 |
| npm | ≥ 10 (viene con Node 22) | 10.9.8 |
| Dependencias | `npm ci` (o `npm install` si no hay `package-lock.json` fijado) | instaladas |
| Java (JRE/JDK) | **≥ 17**; probado con OpenJDK **25.0.2** | **no instalado** en este entorno |
| Firebase CLI | la local de `node_modules` (`firebase-tools`) | 15.34.0 |
| Emulador | `cloud-firestore-emulator-v1.22.0.jar` | **no disponible** |
| Proyecto | `demo-formacion` (prefijo `demo-` ⇒ el CLI nunca toca un proyecto real) | — |
| Red | salida HTTPS hacia `storage.googleapis.com` para la primera descarga del jar | **bloqueada** |

No hace falta nada de pago: el emulador es local y el proyecto `demo-*` no existe
en Firebase. **No se necesita Blaze ni ninguna cuenta de facturación.**

### 1.1 Java

Cualquiera de estas opciones sirve:

```bash
# Debian/Ubuntu
sudo apt-get install -y openjdk-17-jre-headless   # o openjdk-21-jre-headless

# macOS
brew install openjdk@21

# Sin privilegios de administrador (wheel con una JVM dentro)
pip download jdk4py -d /tmp/jdkpkg --no-deps
cd /tmp/jdkpkg && unzip -q jdk4py-*.whl
export JAVA_HOME=/tmp/jdkpkg/jdk4py/java-runtime
export PATH="$JAVA_HOME/bin:$PATH"
java -version
```

`npm run check:env` informa `PASSED` en cuanto `java` esté en el `PATH` (o
`JAVA_HOME` apunte a una JVM válida).

### 1.2 El jar del emulador

Con red, **no hay que hacer nada**: `npm run test:rules` o
`npm run test:firestore` lo descargan a `~/.cache/firebase/emulators/`.

Sin red (este entorno), hay que llevarlo desde una máquina que sí la tenga:

```bash
# En la máquina con red
npx firebase emulators:start --only firestore --project demo-formacion   # descarga y arranca
ls ~/.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar
md5sum ~/.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar > jar.md5

# Copiar el .jar y el .md5 a la máquina de pruebas y comprobar
mkdir -p ~/.cache/firebase/emulators
cp cloud-firestore-emulator-v1.22.0.jar ~/.cache/firebase/emulators/
cd ~/.cache/firebase/emulators && md5sum -c jar.md5
```

Notas honestas sobre la verificación del jar:

- **No se registra aquí un MD5 de referencia** porque este entorno nunca pudo
  descargar el fichero; inventar un valor sería peor que no tenerlo. La
  comprobación correcta es la de arriba: el mismo MD5 en la máquina de origen
  (que lo obtuvo por el CLI oficial) y en la de destino.
- Comprobaciones adicionales baratas: que sea un JAR válido (`unzip -l` debe
  listar clases, ninguna ruta con `..`), tamaño esperado (decenas de MB) y que
  arranque (`java -jar cloud-firestore-emulator-v1.22.0.jar --help`).
- Ubicaciones alternativas admitidas por el CLI: `FIRESTORE_EMULATORS_PATH`
  (directorio donde está el jar) o `FIRESTORE_EMULATOR_BINARY_PATH` (ruta
  completa al jar).
- El jar **no se versiona** en el repositorio y no debe añadirse.

---

## 2. Cómo se lee el resultado: PASSED / FAILED / BLOCKED

Tres estados, sin ambigüedad:

| Estado | Significado | Código de salida |
| --- | --- | --- |
| **PASSED** | Se ejecutó y todo pasó. | `0` |
| **FAILED** | Se ejecutó y algo falló (código, reglas, asertos). | `1` |
| **BLOCKED** | **No se ejecutó** por falta de un requisito (Java, jar, emulador). No es un aprobado. | `2` |

Reglas de diseño ya implementadas:

- `npm run test:firestore` exporta `REQUIRE_FIRESTORE_EMULATOR=1`. Con esa
  variable, si no hay emulador **la suite falla con un test en rojo titulado
  `BLOCKED: …`** en vez de omitirse en silencio.
- `npm run test:firestore` (envoltorio `scripts/run-emulator-checks.mjs`)
  clasifica además el resultado global: si el emulador no arranca por descarga,
  Java o TLS, imprime **`RESULTADO: BLOCKED`** y sale con `2`.
- `npm run test` (suite normal) sigue **omitiendo** las 4 pruebas de integración,
  pero ahora imprime por consola un aviso explícito:
  `[integración] OMITIDAS las pruebas de Firestore … Esto NO significa que hayan pasado.`
- `tests/rules/firestore.rules.test.ts` lanza `BLOCKED: FIRESTORE_EMULATOR_HOST
  no está definido` si se ejecuta sin emulador, para que un fallo de entorno no
  se confunda con un fallo de las reglas.

Interpretación rápida:

```bash
npm run test:rules      && echo "REGLAS: PASSED"     || echo "REGLAS: FAILED o BLOCKED"
npm run test:firestore  && echo "INTEGRACIÓN: PASSED" || echo "INTEGRACIÓN: FAILED o BLOCKED"
# El detalle del estado está en la última línea de la salida (RESULTADO: …).
```

---

## 3. Comprobación previa del entorno

```bash
npm ci
npm run check:env

# Variantes
npm run check:env -- --json     # solo JSON en stdout, legible por máquina
```

Comprueba: Node ≥ 22, dependencias (`firebase-tools`, `@firebase/rules-unit-testing`,
`vitest`), Java ≥ 17, Firebase CLI, presencia del jar, emulador vivo
(`FIRESTORE_EMULATOR_HOST`), directorio `backups/` escribible y
`BACKUP_PASSPHRASE`.

---

## 2 bis. Estado real del bloqueo (comprobado el 22/10/2026)

| Paso | Estado | Evidencia |
| --- | --- | --- |
| JVM ≥ 17 | **RESUELTO** | `pip download jdk4py` + `unzip` deja `openjdk 25.0.2` en `/tmp/jdkpkg/x/jdk4py/java-runtime`; con `JAVA_HOME` y `PATH` apuntando ahí, `npm run test:rules` ya no se queja de Java |
| Firebase CLI | **RESUELTO** | `firebase-tools` 15.x instalado con `npm ci` |
| Jar del emulador | **BLOQUEADO** | `firebase emulators:exec` falla con `Error: Failed to make request to https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.22.0.jar` |

Salida literal del intento:

```
i  firestore: downloading cloud-firestore-emulator-v1.22.0.jar...
⚠  Unable to fetch the CLI MOTD and remote config. ...
Error: Failed to make request to https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.22.0.jar

RESULTADO: BLOCKED
El emulador no pudo arrancar: no se ha ejecutado ninguna prueba.
```

Consecuencia: sigue siendo **imposible** ejecutar reglas e integración aquí. La
diferencia con respecto a la situación anterior es que el bloqueo está aislado:
es **solo** la descarga del jar. Llevar ese fichero a
`~/.cache/firebase/emulators/` (o definir `FIRESTORE_EMULATORS_PATH`) es lo único
que falta para que esta máquina pueda ejecutarlo todo.

---

## 4. Pruebas de reglas (57 casos)

Las reglas son `firestore.rules`; las pruebas, `tests/rules/firestore.rules.test.ts`
con `@firebase/rules-unit-testing` sobre el emulador.

```bash
npm run test:rules
```

Equivale a ejecutar `firebase emulators:start --only firestore --project
demo-formacion` y lanzar Vitest con `vitest.rules.config.mts`.

Resultado esperado si funciona: **57 pruebas en verde**. Si las reglas deniegan
algo que deberían permitir (o al contrario), aparece un `FAILED` con el caso
concreto: **no se debe tocar `firestore.rules` para que pasen**; el fallo se
documenta y se corrige, o se justifica el cambio con la prueba delante
(ADR-017).

---

## 5. Pruebas de integración con Firestore (9 casos)

`tests/integration/firestore-emulator.test.ts` recorre el camino real:
subida por fragmentos, transacción de matrícula/cuota y recuento de escrituras
frente a los límites del servicio.

```bash
npm run test:firestore
```

Opcional: levantar el emulador a mano y apuntar la variable.

```bash
npm run emulators                       # deja el emulador en 127.0.0.1:8080
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
FIREBASE_PROJECT_ID=demo-formacion \
npx vitest run tests/integration
```

Si se lanza `npx vitest run tests/integration` a pelo **sin** la variable y sin
`REQUIRE_FIRESTORE_EMULATOR`, se omiten con aviso; con `REQUIRE_FIRESTORE_EMULATOR=1`
se obtiene el test `BLOCKED`.

Todo el paquete de una vez:

```bash
npm run test:emulator        # reglas + integración, con clasificación PASSED/FAILED/BLOCKED
```

---

## 6. Datos sintéticos y aislamiento

Regla de oro: **solo datos inventados, solo en el emulador**. Nunca se cargan
PDF reales, nombres reales ni correos reales, y nunca se apunta al proyecto
Firebase real.

- Proyecto `demo-formacion`: el prefijo `demo-` hace que el Admin SDK y el CLI
  no puedan hablar con un proyecto real aunque se equivoque el comando.
- `FIRESTORE_EMULATOR_HOST` es obligatoria en todo lo que escribe; sin ella los
  scripts abortan.
- Los datos sembrados son reconocibles: cuentas `sintetico-admin` /
  `sintetico-alumno`, correos `@example.invalid`, `curso-sintetico`,
  `doc-sintetico`, y un fragmento de PDF de relleno (4 KiB) con SHA-256 de ceros.

```bash
# 1) Emulador en marcha (otra terminal): npm run emulators

# 2) Sembrar (borra antes lo que hubiera en el emulador con --reset)
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export FIREBASE_PROJECT_ID=demo-formacion
npm run seed:synthetic -- --reset
```

El conjunto vive en `scripts/lib/synthetic-data.ts` y lo comparten la siembra y
el ensayo de copias, para que ambos usen exactamente los mismos documentos.

Limpieza: `npm run seed:synthetic -- --reset` vuelve a dejar el emulador con el
conjunto mínimo; al cerrar el emulador los datos desaparecen (salvo que se
exporte con `--export-on-exit`, que aquí no se usa).

---

## 7. Copias de seguridad y restauración (solo sintético, solo aislado)

Formato `.fbak` v1: mágico + bloque NDJSON cifrado por colección + manifiesto sin
datos; AES-256-GCM con scrypt por archivo. **No incluye usuarios de Firebase
Authentication.**

### 7.1 Ensayo automático (lo recomendado la primera vez)

```bash
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export FIREBASE_PROJECT_ID=demo-formacion
npm run rehearse:backup
```

Hace, sobre el emulador: siembra → foto del contenido → exporta cifrado →
restauración en seco → borra → restaura → compara documento a documento
(incluidos los bytes del PDF) e imprime `RESULTADO: PASSED` o `FAILED`.

### 7.2 Exportar y restaurar a mano

```bash
export BACKUP_PASSPHRASE='frase larga solo para el ensayo'
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export FIREBASE_PROJECT_ID=demo-formacion

npm run backup:export -- --out backups/ensayo-$(date +%Y%m%d).fbak
npm run backup:restore -- --in backups/ensayo-20260101.fbak --dry-run   # verifica sin escribir
npm run backup:restore -- --in backups/ensayo-20260101.fbak --force     # escribe
```

Salvaguardas implementadas:

- `--out` / `--in` son obligatorios (no hay rutas por defecto).
- La restauración se niega si el destino no está vacío, salvo `--force`.
- `BACKUP_PASSPHRASE` es obligatoria; se rechazan frases débiles.
- Contra un proyecto **real** hace falta además `BACKUP_ALLOW_PROD=yes`
  explícito. **Aquí no se usa nunca.**
- Los recuentos del manifiesto se verifican contra lo restaurado
  (`BACKUP_COUNT_MISMATCH`) y cada bloque se autentica con GCM (`BACKUP_CORRUPT`: cualquier alteración del fichero rompe el GCM).
- `backups/` y `*.fbak` están en `.gitignore`: una copia nunca se sube al repo.

Limitaciones que siguen vigentes: la restauración **no es atómica globalmente**
(si se corta a mitad, hay que repetirla con `--force`), no hay copia de
Authentication ni de las reglas, y una copia hecha con escrituras en marcha no
es un punto consistente en el tiempo.

---

## 8. Lista de comprobación para el entorno compatible

Ejecutar en este orden y anotar el resultado de cada punto:

1. `npm ci`
2. `npm run check:env` → los 4 primeros deben ser **PASSED**; los dos del
   emulador pasan a PASSED tras el punto 3 (o tras arrancarlo).
3. `npm run test:rules` → **PASSED**, 57 pruebas.
4. `npm run test:firestore` → **PASSED**, 4 pruebas (ya no omitidas).
5. `npm run test:emulator` → **PASSED** (reglas + integración juntas).
6. `npm run seed:synthetic -- --reset` → 15 documentos sintéticos.
7. `npm run rehearse:backup` → **PASSED** y documentos idénticos tras restaurar.
8. `npm run verify` → **PASSED**, 470 pruebas + 4 omitidas (las de integración,
   que aquí ya se han corrido aparte) + build.

Si algo sale **FAILED**, guardar la salida completa: es la evidencia que falta
en `docs/ESTADO-FINAL.md`.
