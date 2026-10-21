# Estado final del proyecto — cierre técnico

**Fecha:** 21 de octubre de 2026
**Rama de trabajo:** `arena/89a0aca0-formacion-u-s` (base `c4ce33d7`, `main`)
**Actualización (misma fecha):** existe además una **versión demostrable** con
datos inventados (`DEMO_MODE=1`) que recorre los flujos de alumno y de
administración con los servicios reales sobre un almacén en memoria. No cambia
el veredicto de este documento: ver [`ENTREGA-DEMO.md`](./ENTREGA-DEMO.md).

**Veredicto:** **NO LISTA PARA USO REAL.** La aplicación compila, pasa 476
pruebas automáticas y tiene las piezas construidas, pero **las pruebas críticas
frente a Firestore (41 de reglas y 4 de integración) siguen sin ejecutarse** en
este entorno. Nada de lo que aparece como «PASSED» aquí sustituye a esas
pruebas.

Documento de requisitos y comandos para cerrarlas: [`ENTORNO-PRUEBAS.md`](./ENTORNO-PRUEBAS.md).
Contexto de la fase: [`INFORME-FASE-7.md`](./INFORME-FASE-7.md).

---

## 1. Qué se ha cerrado en este cierre técnico

Sin añadir funcionalidades de producto y **sin tocar `firestore.rules`**:

| Pieza | Qué aporta |
| --- | --- |
| `scripts/lib/env-checks.mjs` | Motor de comprobaciones del entorno con tres estados (PASSED / FAILED / BLOCKED) y códigos de salida 0 / 1 / 2. |
| `scripts/check-environment.mjs` | `npm run check:env` (y `-- --json`). Node ≥ 22, dependencias, Java ≥ 17, Firebase CLI, jar del emulador, emulador vivo, `backups/`, `BACKUP_PASSPHRASE`. |
| `scripts/run-emulator-checks.mjs` | `npm run test:rules` / `test:firestore` / `test:emulator`: arranca el emulador en modo `exec`, exporta `REQUIRE_FIRESTORE_EMULATOR=1` y **clasifica** el resultado final. |
| `tests/integration/firestore-emulator.test.ts` | Con `REQUIRE_FIRESTORE_EMULATOR=1` ya **no se omite en silencio**: aparece un test en rojo `BLOCKED: …`. En la suite normal avisa por consola. |
| `tests/rules/firestore.rules.test.ts` | Preflight: sin `FIRESTORE_EMULATOR_HOST` lanza `BLOCKED: …` en lugar de un error de conexión ambiguo. |
| `scripts/lib/synthetic-data.ts` | Conjunto sintético único (15 documentos) compartido por la siembra y el ensayo de copias. |
| `scripts/seed-synthetic.ts` | `npm run seed:synthetic -- --reset`: siembra el emulador; se niega sin `FIRESTORE_EMULATOR_HOST` y con `NODE_ENV=production`. |
| `scripts/rehearse-backup.ts` | `npm run rehearse:backup`: sembrar → exportar cifrado → restaurar en seco → borrar → restaurar → comparar documento a documento → `RESULTADO: PASSED/FAILED`. |
| `tests/server/synthetic-data.test.ts` | 6 pruebas: rutas únicas, correos `@example.invalid`, referencias coherentes, documento de esquema. |
| `docs/ENTORNO-PRUEBAS.md` | Versiones, requisitos, Java, verificación del jar, datos sintéticos, copias y restauración, lectura de PASSED/FAILED/BLOCKED. |

---

## 2. Verificaciones ejecutadas aquí (comandos y resultados reales)

Todas lanzadas en este entorno: Node v22.22.3, npm 10.9.8, firebase-tools
15.34.0 (local), **sin Java en el `PATH`** y sin acceso de descarga a
`storage.googleapis.com`.

| # | Comando | Resultado real | Estado |
| --- | --- | --- | --- |
| 1 | `npm run typecheck` | 0 errores | **PASSED** |
| 2 | `npm run lint` | 0 errores, 0 avisos | **PASSED** |
| 3 | `npm test` | **476 pasan / 4 omitidas** (29 ficheros + 1 omitido) | **PASSED** |
| 4 | `npm run build` | compila y genera el build | **PASSED** |
| 5 | `npm run verify` | `exit 0` (los cuatro anteriores en orden) | **PASSED** |
| 6 | `npm run check:env` | `FAILED` (exit 1): `java` no está en el PATH | **FAILED** |
| 7 | `JAVA_HOME=… npm run check:env` | `BLOCKED` (exit 2): Java OK, jar del emulador ausente y `FIRESTORE_EMULATOR_HOST` sin definir | **BLOCKED** |
| 8 | `npm run test:rules` | `RESULTADO: FAILED (faltan requisitos locales)` (exit 1) | **FAILED** |
| 9 | `JAVA_HOME=… npm run test:rules` | `RESULTADO: BLOCKED` (exit 2): falla la descarga del jar | **BLOCKED** |
| 10 | `JAVA_HOME=… npm run test:firestore` | `RESULTADO: BLOCKED` (exit 2) | **BLOCKED** |
| 11 | `JAVA_HOME=… npm run test:emulator` | `RESULTADO: BLOCKED` (exit 2) | **BLOCKED** |
| 12 | `REQUIRE_FIRESTORE_EMULATOR=1 npx vitest run tests/integration` | 1 fallo `BLOCKED: …` + 4 omitidas (exit 1) | **BLOCKED explícito** |
| 13 | `npx vitest run -c vitest.rules.config.mts` (sin emulador) | error `BLOCKED: FIRESTORE_EMULATOR_HOST no está definido`, 41 omitidas (exit 1) | **BLOCKED explícito** |
| 14 | `npm run seed:synthetic` (sin emulador) | `✖ Esto escribe datos de prueba: exige FIRESTORE_EMULATOR_HOST` (exit 1) | **guarda funcionando** |
| 15 | `npm run rehearse:backup` (sin emulador) | `✖ Este ensayo exige FIRESTORE_EMULATOR_HOST` (exit 1) | **guarda funcionando** |
| 16 | `npm run backup:export` / `backup:restore` sin flags | `✖ Indica el destino/archivo con --out/--in` | **guarda funcionando** |
| 17 | `npm run firestore:size` | 8 MiB → 11 fragmentos, 768,2 KiB/doc, commit 8,00 MiB; 20 MiB → 27 fragmentos, **20,01 MiB** (no cabe) | **PASSED (medición)** |

El código de salida distingue de verdad los tres estados (los tres primeros
comandos de la tabla 6–11 se han comprobado uno a uno):

```
0 = PASSED    1 = FAILED    2 = BLOCKED (no se ha ejecutado)
```

### 2.1 Qué NO se ha ejecutado (y por qué)

| Prueba | Casos | Motivo | Estado |
| --- | --- | --- | --- |
| Reglas de Firestore (`tests/rules/firestore.rules.test.ts`) | **41** | el jar del emulador no se puede descargar (TLS cortado hacia `storage.googleapis.com`) | **BLOCKED** |
| Integración Firestore (`tests/integration/firestore-emulator.test.ts`) | **4** | mismo motivo: sin emulador no hay Firestore real ni transacciones | **BLOCKED** |
| Ensayo de copia/restauración (`npm run rehearse:backup`) | 1 recorrido | necesita el emulador | **BLOCKED** |

Consecuencia directa: **el flujo real contra Firestore no se ha ejecutado nunca**
(alta de matrícula transaccional, contador de cuota, lectura de fragmentos desde
Firestore). La copia de seguridad sí está probada, pero **contra dobles de
prueba**, no contra el emulador ni el servicio.

No se ha desactivado la validación TLS, no se ha modificado ninguna regla para
que pase, no se ha instalado nada en el ordenador del usuario y no se ha usado
el proyecto Firebase real.

---

## 3. Lo que debe ejecutar y comprobar un entorno con el emulador oficial

En este orden, anotando la salida de cada punto:

1. `npm ci`
2. Instalar JDK ≥ 17 (probado con OpenJDK 25.0.2) y comprobar `java -version`.
3. Obtener `cloud-firestore-emulator-v1.22.0.jar` en
   `~/.cache/firebase/emulators/` (lo descarga el CLI si hay red; si no, se copia
   verificando el MD5 de origen — ver `ENTORNO-PRUEBAS.md` §1.2).
4. `npm run check:env` → **todos PASSED** (el de `BACKUP_PASSPHRASE` es opcional).
5. `npm run test:rules` → **PASSED, 41 pruebas**. Si alguna falla, **no tocar las
   reglas**: guardar el caso y decidir con la prueba delante.
6. `npm run test:firestore` → **PASSED, 4 pruebas** (ya no se omiten).
7. `npm run test:emulator` → **PASSED** (reglas + integración).
8. `npm run seed:synthetic -- --reset` → 15 documentos sintéticos.
9. `npm run rehearse:backup` → **PASSED** y contenido idéntico tras restaurar.
10. `npm run verify` → **PASSED** (476 + 4 omitidas + build).

Si los pasos 5–7 dan **FAILED**, ese es el trabajo pendiente real: son los únicos
resultados que pueden convertir el veredicto en «lista».

---

## 4. Riesgos residuales conocidos

| Riesgo | Estado |
| --- | --- |
| Reglas y transacciones nunca ejecutadas contra un Firestore real | **abierto** (41 + 4 pruebas BLOCKED) |
| Límite de peticiones en memoria por proceso (no distribuido) | asumido y documentado |
| Sin MFA y sin límite de intentos en `/api/activate` | abierto |
| Sin interfaz de matrícula (hoy se hace por API/importación) | abierto |
| DRM inexistente en los PDF servidos por fragmentos | asumido |
| Copia de seguridad sin Firebase Auth y sin atomicidad global | documentado en `SEGURIDAD.md` §5.3 bis |
| Cuota Spark: egreso 10 GiB/mes y apagado al agotarla | límite real de operación |
| `npm audit`: 9 avisos altos en dependencias de desarrollo | documentado, sin `--force` |

---

## 5. Veredicto

- **Código y pruebas automáticas:** en verde (476 pruebas, tipado, lint, build).
- **Pruebas críticas de Firebase:** **0 de 45 ejecutadas** (41 reglas + 4 integración).
- **Veredicto:** **NO LISTA PARA USO REAL** hasta que el entorno del punto 3
  ejecute los pasos 5–9 y todos salgan PASSED.

Este documento no cambia de veredicto por el hecho de que las pruebas automaticen
mejor el bloqueo: ahora el bloqueo **se ve** (`BLOCKED`, exit 2) en lugar de
parecer un fichero omitido.

---

## 6. Actualización — fase 8 (conexión con Firebase real)

La aplicación ya tiene una sola capa de datos (`src/server/portal`) que elige
entre Firestore y el almacén sintético según `DEMO_MODE`. Lo conectado, lo que
sigue en memoria, la configuración que falta y las pruebas bloqueadas están
detallados en [`INFORME-FASE-8.md`](INFORME-FASE-8.md).

Resumen del veredicto: **sigue NO LISTA para uso real**. Las 41 pruebas de
reglas y las 4 de integración continúan **BLOCKED** (sin emulador oficial) y
nada se ha ejecutado contra el proyecto `formacionus-63555` por falta de credenciales
(el ID del proyecto sí está confirmado; lo que falta es la configuración web y la
clave de servicio). La suite automática está en verde: **536 pruebas**, 4 omitidas.
