# Informe de la fase 8 — conexión con Firebase real

Fecha: 21 de octubre de 2026 · actualizado en la fase 8.1
Rama: `arena/89a0aca0-formacion-u-s` (sin commits ni despliegues)
Proyecto: **`formacionus-63555`** (ID real confirmado el 21/10/2026) · Firestore nativo, base `(default)`, `europe-southwest1`

---

## 1. Resumen ejecutivo

La aplicación pasa a tener **una sola capa de acceso a datos** con dos
implementaciones intercambiables según la configuración del proceso:

| Configuración | Persistencia | Sesión |
| --- | --- | --- |
| `DEMO_MODE=1` | almacén en memoria con datos sintéticos | cookie `formacion_demo` con un uid ficticio |
| sin `DEMO_MODE` | **Firestore + Firebase Authentication** del proyecto real | cookie httpOnly emitida a partir del ID token |

La interfaz, los servicios de negocio y las pruebas son **los mismos** en los
dos casos: no hay dos aplicaciones ni una versión «de mentira» que se separe
con el tiempo. Lo que cambia es el almacén que hay debajo.

Estado honesto de esta entrega:

- **Conectado en código** (escrito, tipado, probado con dobles): todo lo que
  aparece en la tabla del apartado 3.
- **Ejecutado contra Firebase real**: **nada**. En este entorno no hay
  credenciales del proyecto `formacionus-63555`, ni `.env.local`, ni emulador
  oficial (requiere Java, no disponible). La lectura de comprobación
  `checkConnection()` devuelve `ok: false` aquí, y la página `/estado` lo
  enseña así en vez de afirmar que hay conexión.
- **Demostración**: intacta y funcionando (`npm run check:demo` → PASSED).

No se ha escrito nada en el proyecto real, no se han creado usuarios reales y
no se ha desplegado nada.

---

## 2. Cómo queda la arquitectura

```
src/app/**                      páginas y acciones de servidor
        │
        ▼
src/server/portal/index.ts      «portal activo»: elige demo o Firebase
        ├──────────────► src/demo/service.ts        (memoria, datos sintéticos)
        └──────────────► src/server/portal/firebase.ts
                                │
                                ▼
                   servicios de negocio reales
        (assessments, enrollments, courses/catalog, documents, import)
                                │
                                ▼
      adaptadores Firestore (catalog-store, enrollment-store, learning-store,
      document-store, repositories) + Admin SDK
```

Piezas nuevas o modificadas en esta fase:

- `src/server/portal/learner.ts` — cálculo compartido de la vista del alumno
  (progreso, temas, documentos, examen). Lo usan **las dos** persistencia.
- `src/server/portal/firebase.ts` — implementación real del portal: lecturas,
  resúmenes de administración, altas/bajas de matrícula, borradores,
  publicación, importación y lectura de páginas de PDF.
- `src/server/portal/index.ts` — selector de modo y comprobación de rol en
  servidor antes de cada operación.
- `src/server/courses/definition.ts` — reconstruye la definición editable a
  partir de versión + claves (ida y vuelta probada).
- `src/demo/service.ts` — ahora delega el cálculo del alumno en
  `portal/learner.ts` en lugar de tener su propia copia.
- Páginas de alumno y administración — llaman al portal con el actor de la
  sesión; ya no muestran el aviso de «esto sigue en memoria».

---

## 3. Funciones realmente conectadas

«Conectadas» significa: la ruta de código que usa la interfaz escribe y lee en
Firestore a través de los adaptadores, con autorización comprobada en servidor.
**No** significa ejecutadas contra el proyecto real (ver apartado 5).

| Función | Dónde | Colecciones |
| --- | --- | --- |
| Inicio y cierre de sesión | `/login`, `POST/DELETE /api/auth/session` | Firebase Auth + `accounts/{uid}` |
| Validación de sesión en cada petición | `getActor()` (`checkRevoked`, estado y `claimsVersion`) | `accounts`, Custom Claims |
| Activación de cuenta con token de un solo uso | `/activar`, `POST /api/activate` | `activationTokens`, `accounts`, Auth |
| Listado y ficha de cuentas | `/panel`, `/admin` | `accounts`, `usernames` |
| Cursos por alumno con progreso | `/panel` | `enrollments`, `courses`, `courses/*/versions`, `progress` |
| Detalle del curso, temas y documentos | `/cursos/[courseId]` | `courses`, `courses/*/versions`, `progress` |
| Lectura de documentos y registro del avance | `/cursos/[courseId]/documentos/[documentId]` | `progress`, `documents`, `pdfChunks` |
| Cuestionarios y examen final | `/cursos/[courseId]/temas/*`, `/examen` | `courses`, `answerKeys`, `progress`, `attempts` |
| Matrículas y revocaciones | `/admin/matriculas` | `enrollments` |
| Borradores y publicación de versiones | `/admin/cursos/*` | `courses`, `courses/*/versions`, `answerKeys` |
| Resumen y progreso de administración | `/admin`, `/admin/progreso` | `accounts`, `enrollments`, `progress`, `attempts` |
| Importación de personas (vista previa y confirmación) | `/admin/importar`, `/api/admin/import/*` | `usernames`, `accounts`, `activationTokens`, `audits` |
| Subida de PDF por fragmentos (sin Storage) | `POST /api/admin/documents` | `documents`, `pdfChunks`, `meta/storage` |
| Comprobación de conexión | `/estado` | lectura de `meta` |

Todas las transacciones que ya estaban escritas siguen igual: matrícula
(idempotente por id compuesto), progreso + intento + histórico, publicación de
versión con puntero del curso, consumo de token de activación, cuota de PDF.

---

## 4. Qué sigue en memoria

Solo bajo `DEMO_MODE=1`, y siempre rotulado en la interfaz:

- Cuentas ficticias (`demo-admin`, `demo-alumno-1`, `demo-alumno-2`), sus
  matrículas, su progreso y sus intentos.
- Contenido sintético de dos cursos y **pantallas de texto** en lugar de PDF.
- La vista previa de importación lee un `.xlsx` real, pero confirmar la
  importación **falla a propósito** con `DEMO_NOT_CONNECTED`: crear cuentas
  exige Firebase Authentication y no se simula.

Nada de esto se escribe en Firestore, ni se mezcla con datos reales: son
procesos distintos (`DEMO_MODE=1` frente a configuración real) y con la misma
sesión no se puede pasar de uno a otro.

---

## 5. Pasos pendientes en Firebase Console

La guía operativa completa —con la ruta exacta de cada menú, los valores que
hay que introducir y qué variables de entorno les corresponden— está en
[`CONEXION-FIREBASE.md`](CONEXION-FIREBASE.md). Resumen de lo que **falta**,
todo dentro del plan gratuito:

| # | Acción | Dónde | Valor | Estado |
| --- | --- | --- | --- | --- |
| 1 | Comprobar el ID del proyecto | Configuración del proyecto → General | `formacionus-63555` | **ID confirmado por el usuario** |
| 2 | Crear Firestore en modo nativo (si no existe) | Compilación → Firestore Database → Crear base de datos | `(default)`, `europe-southwest1` | por verificar |
| 3 | Habilitar acceso con correo y contraseña | Compilación → Authentication → Comenzar → Sign-in method | proveedor Correo electrónico/contraseña | **hecho por el usuario** |
| 4 | Autorizar el dominio de la app | Authentication → Settings → Dominios autorizados | `localhost` ya figura; el dominio real al desplegar | pendiente |
| 5 | Registrar la app web `formacion-web` y copiar `firebaseConfig` | Configuración del proyecto → Tus apps → Web | `apiKey`, `authDomain`, `projectId`, `appId` a `NEXT_PUBLIC_*` | pendiente |
| 6 | Generar clave de cuenta de servicio | Configuración del proyecto → Cuentas de servicio | `project_id`, `client_email`, `private_key` a `FIREBASE_*` | **no generada aún (por indicación)** |
| 7 | Dar de alta el primer administrador | terminal, no consola | `BOOTSTRAP_ADMIN_USERNAMES` + `bootstrap-admins.mjs` | pendiente |

Pendiente **fuera** de la consola, cuando el usuario lo autorice:

- `npm run check:firebase` (solo lectura) hasta obtener `exit 0`.
- `npm run db:init -- --apply` con `DB_INIT_CONFIRM=yes` y `DB_ALLOW_PROD=yes`
  para crear `meta/schema`.
- Publicar reglas e índices **solo** después de que las 41 pruebas de reglas y
  las 4 de integración dejen de estar BLOCKED.

De estos pasos solo están hechos los que hizo el usuario en la consola
(proyecto y Authentication). En este entorno no hay credenciales, así que el
diagnóstico sigue en **FAILED (exit 2)** y no se escribe en el proyecto real
sin autorización expresa.

## 6. Pruebas

| Comprobación | Resultado |
| --- | --- |
| `npm run typecheck` | pasa |
| `npm run lint` | pasa (0 errores, 0 avisos) |
| `npm test` | **547 pruebas pasan**, 4 omitidas |
| `npm run build` | compila; 25 rutas |
| `npm run check:demo` (HTTP real, demo intacta) | PASSED (19 comprobaciones) |
| Pruebas nuevas del portal (`tests/server/portal.test.ts`) | 14 |
| Pruebas de emisión de sesión (`tests/server/actor-resolution.test.ts`) | 7 nuevas |
| Pruebas de origen y de endurecimiento de producción (`tests/server/security-helpers.test.ts`) | 4 nuevas |
| `npm run check:firebase` sin credenciales | FAILED (exit 2), sin tocar la red |
| `npm run check:firebase` con configuración y servicio inalcanzable | BLOCKED (exit 3) en ~10 s |
| Configuración web: forma y coherencia de las 5 variables (`checkPublicFirebaseConfig`) | **8 pruebas** pasan sin red |
| Lectura de `.env.local` por los diagnósticos (`env-file.ts`) | **11 pruebas** pasan sin red |
| El diagnóstico no escribe y usa la validación (lectura del script) | **6 pruebas** pasan |
| Pruebas nuevas de ida y vuelta del contenido (`tests/server/definition.test.ts`) | 3 |

Qué demuestran las pruebas nuevas:

- El modo se decide **solo** por configuración; no hay conmutación implícita.
- La administración se rechaza a un alumno **antes** de tocar la base de datos
  (el Admin SDK elude reglas, así que esta barrera es la que importa).
- Una cuenta deshabilitada no accede ni a su propio listado de cursos.
- La vista del alumno no contiene `correctOptionIds`.
- La definición editable se reconstruye sin perder claves; si faltan, no se
  inventan.
- Sin credenciales, la comprobación de conexión devuelve `ok: false` (no
  confirma una conexión que no existe).

### Bloqueadas (no superadas)

| Prueba | Estado | Motivo |
| --- | --- | --- |
| `npm run test:rules` — 41 casos de reglas | **BLOCKED** | el emulador oficial de Firestore necesita Java; no hay JDK persistente en el entorno y la descarga de binarios está bloqueada |
| `npm run test:firestore` — 4 pruebas de integración | **BLOCKED** | mismo motivo |
| Cualquier ejecución contra `formacionus-63555` | **NO EJECUTADA** | sin credenciales; además escribir en el proyecto real requiere autorización expresa del usuario |
| `npm run check:firebase` con credenciales reales | **PENDIENTE** | depende de los pasos del apartado 5 |
| Subida y lectura de un PDF real | **NO EJECUTADA** | no hay documentos reales ni emulador; el código está probado con dobles |

Ninguna de estas se declara superada.

---

## 7. Límites del plan gratuito (Spark) y qué implica

El diseño no usa nada que exija facturación:

- **Sin Cloud Storage** (exige Blaze desde febrero de 2026): los PDF se guardan
  troceados en Firestore y solo los sirve este servidor.
- **Sin Cloud Functions ni App Hosting**: toda la lógica vive en el servidor
  Next.js que el usuario despliegue.
- **Sin backups gestionados, PITR ni TTL**: la copia de seguridad es el
  export/restore cifrado propio (`.fbak`, AES-256-GCM).

Límites que sí se pueden tocar y lo que ocurre al tocarlos:

| Límite | Consecuencia |
| --- | --- |
| 50 000 lecturas y 20 000 escrituras diarias | al agotarse, Firestore devuelve error hasta ~medianoche del Pacífico; la aplicación muestra «datos no disponibles», **no** cambia a memoria |
| 1 GiB de almacenamiento total | la subida de PDF se corta antes: presupuesto propio (`PDF_STORAGE_BUDGET_MB`, 512 por defecto) con reserva para el resto de colecciones |
| 10 GiB de egreso al mes | superarlo puede dejar el servicio interrumpido; el PDF se sirve por fragmentos de 768 KiB y con límite de peticiones en memoria (una sola instancia) |
| 1 MiB por documento | cada fragmento de PDF queda muy por debajo; los documentos de contenido son pequeños |
| 10 MiB por petición/transacción | la subida de un PDF de 8 MiB con 11 fragmentos entra de sobra |

Consecuencia práctica: **coste cero sí, disponibilidad garantizada no**. Al
agotar cuotas la aplicación falla de forma visible y hay que esperar o pasar a
un plan de pago. El despliegue en un host gratuito añade su propio límite
(por ejemplo, Vercel Hobby prohíbe el uso comercial; Netlify Free permite 300
créditos al mes). No se afirma «coste cero garantizado».

---

## 8. Bloqueos para usar usuarios reales

1. **Reglas sin validar** (41 casos, 0 ejecutados). El Admin SDK las elude y
   los endpoints comprueban identidad y rol, pero la segunda barrera —la que
   protege si alguien llega a Firestore con un token de cliente— no está
   verificada. No se publican reglas sin ese paso.
2. **Visor de PDF en la página**: la lectura autorizada y el registro de
   progreso funcionan (el servidor sirve la página y anota el avance), pero el
   documento no se dibuja en pantalla. Falta esta pieza para que un curso con
   PDF sea utilizable de verdad.
3. **Sin credenciales ni emulador** en este entorno: nada de lo conectado se
   ha visto funcionar contra Firebase.
4. **Sin MFA** y sin política de caducidad de contraseñas más allá de lo que
   impone Firebase Authentication.
5. **Límites de peticiones en memoria** (PDF: 600 páginas/hora por usuario;
   activación: 10 intentos/hora por IP). Con varias instancias habría que
   compartir los contadores.

Hasta resolver 1 y 2, el veredicto sigue siendo **NO LISTA para uso real**. La
versión demostrable sigue siendo la forma correcta de enseñar el sistema.

---

## 9. Qué NO se ha hecho (a propósito)

- No se ha escrito nada en el proyecto `formacionus-63555` ni se han creado usuarios
  reales.
- No se han publicado reglas de seguridad.
- No se ha tocado el Gestor de Personal y Cuadrantes U.G.–U.S., su Firebase, sus
  usuarios ni su despliegue.
- No se ha habilitado ningún servicio de pago (Blaze, Storage, Functions, App
  Hosting).
- No se ha eliminado ni modificado el modo demostración ni sus datos
  sintéticos.
- «Desidentificar y preparar temario» sigue en la hoja de ruta: no era esta
  fase.

---

## 10. Verificación de la fase 8.1 (resultados comprobados)

Revisión de la autenticación de extremo a extremo y corrección de lo que
apareció. Todo lo de esta tabla está cubierto por pruebas automáticas en verde.

| Defecto encontrado | Riesgo | Corrección |
| --- | --- | --- |
| `assertTrustedOrigin` aceptaba `X-Forwarded-Host` | una página ajena podía declarar su dominio como propio y pasar el filtro CSRF | se ignoran esa cabecera y `X-Real-IP`; solo valen `APP_ORIGIN` y el `Host` real |
| Se emitía cookie a cuentas pendientes o deshabilitadas con token válido | sesión «a medias» y cookie entregada a quien no debía | `assertSessionIssuable` en el canje: misma política que al leer la sesión |
| En producción no se exigía `APP_ORIGIN` ni prefijo `__Host-` | CSRF dependiente de `Host`; cookie sobrescribible desde un subdominio | `assertProductionHardening`: sin ambos, la aplicación no arranca (503) |
| `/api/activate` sin límite de intentos | sondeo masivo del endpoint | 10 intentos/hora por IP, en memoria |
| `logout()` no cerraba la sesión de Firebase en memoria | la sesión seguía viva hasta recargar | cierra Firebase y luego borra la cookie del servidor |
| Tablas de administración sin `limit` | lecturas sin cota al crecer los datos | `limit(1000)` en cuentas y `limit(2000)`/`limit(1000)` en matrículas e intentos; los recuentos del resumen usan agregaciones `count()` |

Lo que **no** ha cambiado y sigue siendo cierto: no se ha hablado con
`formacionus-63555`, no se han escrito datos, no se han publicado reglas y la
demostración (`DEMO_MODE=1`) sigue funcionando con sus datos sintéticos.

---

## 11. Revisión de la autenticación (fase 8.1)

Recorrido completo del ciclo de la cookie httpOnly, con lo que se comprobó y lo
que se cambió.

| Etapa | Cómo funciona | Resultado de la revisión |
| --- | --- | --- |
| **Creación** | el navegador inicia sesión en Firebase con persistencia en memoria y envía el ID token a `POST /api/auth/session`; el servidor verifica firma, emisor, audiencia y caducidad, exige `auth_time` ≤ 5 min, comprueba la ficha de la cuenta y emite la cookie | **corregido**: antes se emitía cookie a cuentas pendientes o deshabilitadas; ahora `assertSessionIssuable` aplica la misma política que al leer |
| **Verificación** | cada petición verifica la cookie con `checkRevoked: true` y vuelve a leer `accounts/{uid}`: manda la base de datos, no el token | sin defectos; cubierto por 23 pruebas de política de sesión |
| **Renovación** | **no hay renovación deslizante**: la cookie dura `SESSION_TTL_HOURS` (12 por defecto) y después se vuelve a iniciar sesión | decisión consciente (menos superficie de ataque); si se quisiera renovar, habría que añadir un endpoint con su propio límite |
| **Revocación** | deshabilitar la cuenta surte efecto inmediato (estado en Firestore); `claimsVersion` invalida tokens con rol o estado antiguos; la activación revoca los refresh tokens | sin defectos |
| **Suplantación** | el uid sale siempre del token verificado; ninguna petición acepta un uid del cliente; las consultas de progreso ajenas exigen rol de administración | sin defectos |
| **Elevación de privilegios** | el rol vive en la ficha y en las claims, y ambos deben coincidir; una fila de Excel nunca produce administrador; cada operación de administración comprueba el rol en servidor antes de leer | **corregido**: se añadió el caso «token con rol admin sobre ficha de alumno» a las pruebas |
| **Falsificación de solicitudes (CSRF)** | `Origin`/`Referer` obligatorios en toda mutación + `SameSite=Lax` + cookie httpOnly | **corregido**: ya no se acepta `X-Forwarded-Host`; en producción `APP_ORIGIN` es obligatoria y https |

Comprobado también que la cookie se emite con `HttpOnly`, `SameSite=Lax`,
`Secure` en producción, `Path=/` y sin `Domain` (requisito del prefijo
`__Host-`).
