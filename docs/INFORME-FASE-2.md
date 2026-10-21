# Informe de la fase 2 — pruebas de seguridad

**Fecha:** 21 de octubre de 2026
**Rama:** `arena/89a0aca0-formacion-u-s` (commit base `c4ce33d`, sin commits nuevos)
**Estado:** completado **parcialmente**: hay un bloqueo de entorno que impide
ejecutar las pruebas de reglas. Se detalla sin adornos.

---

## Resumen ejecutivo

| Requisito de la orden | ¿Verificado? |
| --- | --- |
| Revisar reglas de Firestore/Storage y configuración | **Sí** — revisadas y endurecidas |
| Preparar entorno de emuladores | **Preparado, pero no ejecutable** (falta JVM y red) |
| Pruebas con Rules Unit Testing | **Escritas (44), 0 ejecutadas** — bloqueo |
| Revisar autenticación/autorización de endpoints | **Sí** — auditoría automática + HTTP real |
| Corregir fallos demostrados | **Sí** — 4 hallazgos, incluidos 2 reales de seguridad |
| Ejecutar de nuevo y documentar | **Sí** — 236/236 en verde |

**No se puede afirmar que las reglas de Firestore/Storage estén verificadas.**
Están revisadas, endurecidas y con la batería de pruebas preparada, pero el
motor de reglas solo existe dentro del emulador, que requiere Java.

---

## 1. Bloqueo del entorno (lo primero, porque condiciona todo)

`npm run test:rules` falla así, literalmente:

```
Error: Could not spawn `java -version`. Please make sure Java is installed and on your system PATH.
```

Cuatro vías cerradas, comprobadas una por una:

| Vía | Resultado |
| --- | --- |
| ¿JVM instalada? | `java: command not found`; `/usr/lib/jvm` no existe |
| `apt-get install default-jre-headless` | sin privilegios de root y sin caché de paquetes |
| `pip install install-jdk` (Adoptium) | `JdkError: TLS/SSL connection has been closed` |
| Descarga del `.jar` del emulador | `storage.googleapis.com` y `dl.google.com` → sin salida (000) |

No he sustituido el emulador por un evaluador de reglas de terceros: daría
resultados que no corresponden al motor real de Firebase y sería precisamente
el «resultado inventado» que la orden prohíbe.

**Qué hace falta para desbloquearlo:** JDK 11+ y salida a `storage.googleapis.com`.
Con eso, `npm run test:rules` ejecuta las 44 pruebas sin tocar código.

---

## 2. Archivos modificados en esta fase

| Archivo | Cambio |
| --- | --- |
| `firestore.rules` | **Endurecidas**: `isActive()`/`isAdmin()` consultan la ficha; curso raíz solo si está publicado; añadida `progressHistory` |
| `storage.rules` | Solo comentarios: aclarado que las URLs firmadas no pasan por reglas |
| `src/domain/auth/actor.ts` | **Nuevo**: `resolveSession` (política de sesión pura y testeable) |
| `src/server/auth/session.ts` | Usa `resolveSession`; eliminada la lógica duplicada |
| `tests/server/actor-resolution.test.ts` | **Nuevo**: 16 pruebas |
| `tests/server/endpoint-authorization.test.ts` | **Nuevo**: 12 pruebas de auditoría estática |
| `tests/rules/firestore.rules.test.ts` | **Nuevo**: 34 pruebas (no ejecutadas) |
| `tests/rules/storage.rules.test.ts` | **Nuevo**: 10 pruebas (no ejecutadas) |
| `vitest.rules.config.mts` | **Nuevo**: configuración de las pruebas de reglas |
| `vitest.config.mts` | Excluye `tests/rules/**` del `npm test` normal |
| `package.json` | Scripts `test:rules` y `emulators`; devDependencies `firebase-tools`, `@firebase/rules-unit-testing` |
| `docs/PRUEBAS.md` | Sección 8 con el registro real de la fase 2 |
| `docs/SEGURIDAD.md` | Nuevo apartado 2.b y riesgos 5.7b/5.7c |
| `docs/INFORME-FASE-2.md` | Este informe |

---

## 3. Revisión de reglas: hallazgos y correcciones

### H1 · La sesión se creía al token, no a la ficha (real, corregido)

**Problema.** `isActive()` comprobaba solo `request.auth.token.status`. Un
usuario deshabilitado conservaba acceso de lectura hasta que caducara su token
(hasta 1 h un ID token, hasta 12 h la cookie de sesión). El servidor sí releía
la ficha, pero las reglas eran la segunda barrera y no lo hacían. Mismo fallo en
`isAdmin()` con administradores degradados.

**Corrección.** `account()` hace `get()` de `accounts/{uid}` y:
- `isActive()` exige ficha activa + claim activo + `claimsVersion` coincidente;
- `isAdmin()` exige además rol `admin` en la ficha y en el token.

Si la ficha no existe, `get()` provoca error y Firestore deniega (fallar
cerrado). Coste: una lectura extra por petición evaluada (cacheada dentro de la
misma petición).

**Estado:** implementado, **sin ejecutar**. Es el cambio que más necesita el
emulador, y precisamente lo que validan las pruebas 6 y 7 de la batería.

### H2 · Curso sin publicar visible para alumnos (real, corregido)

`courses/{courseId}` se leía con `isActive()`. Un borrador (`publishedVersion:
null`) quedaba visible: títulos y metadatos de cursos sin publicar. Ahora el
alumno solo lo lee si `publishedVersion != null`; el administrador sigue viendo
borradores.

### H3 · `progressHistory` sin regla explícita (corregido)

La colección se documentó en el modelo de datos pero no tenía regla propia. Caía
en el comodín de denegación (correcto), pero depender del comodín para datos
sensibles es frágil: se ha añadido regla explícita con la misma política que
`progress`.

### H4 · Duplicación de la política de sesión (corregido)

La decisión «¿vale esta sesión?» estaba embebida en `session.ts`, acoplada a
Firebase y sin pruebas. Se ha extraído a `resolveSession` (dominio puro), con
16 pruebas. Durante ese trabajo apareció un fallo propio: aceptaba un
`claimsVersion` guardado como texto; ahora exige entero y falla cerrado.

### Riesgo que NO se corrige (decisión de producto)

`documents/{id}` es legible por cualquier cuenta activa. Sin modelo de
matriculación no hay forma de decidir «este documento es de tu curso». No
expone PDFs (el binario está en Storage, cerrado), solo títulos y nº de
páginas. Documentado como riesgo 5.7c.

---

## 4. Revisión de endpoints (punto 4 de la orden)

### 4.1 Revisión manual

| Endpoint | Sesión | Rol | Origen (CSRF) | Límites | Veredicto |
| --- | --- | --- | --- | --- | --- |
| `GET /api/health` | No (público) | — | — | — | Correcto: no devuelve datos |
| `POST /api/auth/session` | No (público): exige ID token | — | Sí | 64 KB | Correcto |
| `DELETE /api/auth/session` | No (idempotente) | — | Sí | — | Correcto |
| `GET /api/me` | Sí (`getActor`) | — | — | — | Correcto: sin sesión devuelve `{authenticated:false}` |
| `POST /api/activate` | No (token de un solo uso) | — | Sí | 64 KB | Correcto; falta rate limit (§6) |
| `POST /api/admin/import/preview` | Sí (`requireActor`) | Admin (servicio) | Sí | 2 MB + 2000 filas | Correcto |
| `POST /api/admin/import/confirm` | Sí (`requireActor`) | Admin (servicio) | Sí | 2 MB + 2000 filas | Correcto |
| `/panel`, `/admin`, `/admin/importar` | Proxy + `getActor` | Admin en `/admin/*` | — | — | Correcto |
| `/cursos` | Proxy | — | — | — | Página aún no implementada (solo protegida) |

### 4.2 Auditoría automática (ejecutada)

`tests/server/endpoint-authorization.test.ts` (12 pruebas, **en verde**) lee el
código de `src/app/api` y falla si:

- una ruta que exporta `POST/PUT/PATCH/DELETE` no llama a `assertTrustedOrigin`;
- una ruta que escribe no exige sesión, salvo las tres públicas justificadas en
  una lista blanca con motivo escrito;
- aparece una ruta exenta que ya no existe (lista blanca obsoleta);
- una ruta de administración no delega en un servicio que llame a `assertAdmin`;
- un endpoint de lectura no resuelve el actor;
- algún componente `"use client"` escribe en Firestore.

### 4.3 Comprobación HTTP real

| Petición | Resultado real |
| --- | --- |
| `POST /api/admin/import/preview` sin sesión | `401 UNAUTHENTICATED` |
| `POST /api/admin/import/confirm` sin sesión | `401 UNAUTHENTICATED` |
| `POST /api/auth/session` con token falso | `401 ID_TOKEN_INVALID` |
| `DELETE /api/auth/session` | `200 {"ok":true}` |
| `GET /api/me` sin sesión | `200 {"authenticated":false}` |
| `POST /api/activate` con backend inalcanzable | `503 FIREBASE_UNAVAILABLE` |
| `POST /api/activate` con `Origin` ajeno | `403 ORIGIN_FORBIDDEN` |
| `POST /api/activate` sin `Origin` | `403 ORIGIN_MISSING` |
| `/panel`, `/admin`, `/admin/importar`, `/cursos` sin cookie | `307 → /login` |
| Todo endpoint sin configuración | `503 SERVER_NOT_CONFIGURED` |

**No comprobado por HTTP:** que una sesión válida de alumno reciba `403` al
llamar a un endpoint de administración. Requiere acuñar una cookie de sesión
real (Firebase Auth), imposible sin emulador. La comprobación equivalente está
cubierta a nivel de servicio: `buildImportPreview` y `confirmImport` llaman a
`assertAdmin` (18 pruebas en verde, incluidas «rechaza a usuarios que no son
administradores» y «rechaza administradores deshabilitados»).

---

## 5. Pruebas ejecutadas

```bash
npm run verify   # typecheck + lint + test + build  →  exit 0
```

| Comprobación | Resultado |
| --- | --- |
| `tsc --noEmit` (incluye los ficheros de reglas) | 0 errores |
| `eslint` | 0 errores, 0 avisos |
| `vitest run` | **236 pruebas / 15 ficheros — todas pasan** |
| `next build` | compila |

Comparado con la fase 1: 208 → **236** pruebas (+16 de política de sesión,
+12 de auditoría de endpoints).

Ficheros nuevos de pruebas: `actor-resolution.test.ts` (16),
`endpoint-authorization.test.ts` (12).
No ejecutados: `tests/rules/*.test.ts` (44).

### Sucesos durante la verificación

- Al instalar `firebase-tools` con el servidor de desarrollo en marcha, el
  proceso quedó con módulos obsoletos (`@opentelemetry/api`) y devolvía 500 en
  todos los endpoints. **No era un fallo de código**: `require('firebase-admin/firestore')`
  funcionaba en Node; reiniciar el servidor lo resolvió. Se documenta porque un
  500 genérico en todos los endpoints es exactamente el síntoma que podría
  parecer un fallo de seguridad.
- `npm install` añade 16 avisos de dependencias (12 altos) por `firebase-tools`,
  que es **solo de desarrollo** (emulador). No afecta al bundle desplegado.

---

## 6. Riesgos abiertos

| # | Riesgo | Gravedad | Estado |
| --- | --- | --- | --- |
| R1 | **Reglas sin compilar ni ejecutar**: posible error de sintaxis no detectado; sin evidencia empírica de los permisos | **Alta** | Bloqueado por entorno. Mitigado porque el cliente no lee Firestore (todo va por servidor) |
| R2 | Endurecimiento de reglas (H1/H2/H3) sin validar por pruebas | **Alta** | Igual que R1; es lo primero que valida la batería |
| R3 | Sin límite de intentos en `/api/activate` | Media | Pendiente (bloque 5) |
| R4 | PDF: URL firmada = permiso temporal de portador | Media | Aceptado y documentado |
| R5 | Lectura secuencial no es DRM | Baja | Aceptado |
| R6 | Metadatos de documentos visibles a cualquier cuenta activa | Baja | Requiere modelo de matriculación |
| R7 | Sin MFA para administradores | Media | Pendiente de decisión |
| R8 | Alta pública en Firebase Auth permitiría ocupar correos sintéticos | Media | Acción al conectar Firebase (desactivar sign-ups / blocking function) |
| R9 | Avisos de dependencias (12 altos, dev) | Baja | Revisar antes de desplegar |

Ninguno de estos riesgos afecta a la aplicación de cuadrantes: todo ocurre en
este repositorio y con el Firebase propio de Formación, que no está conectado.

---

## 7. Siguiente paso recomendado

1. **Desbloquear el emulador** (JDK 11+ y salida a `storage.googleapis.com`),
   o ejecutar `npm run test:rules` en una máquina que los tenga. Es el único
   paso que convierte «escrito» en «verificado» y el requisito que la orden pide
   y hoy no se puede cumplir aquí.
2. Si el entorno sigue bloqueado, la alternativa es instalar el emulador en tu
   equipo y yo preparar el resto: las 44 pruebas están listas para ejecutarse
   sin cambios.
3. Después, bloque 3 (contenido, PDF y evaluación) con las decisiones
   pendientes de la fase 1.

Me detengo aquí, a la espera de autorización.
