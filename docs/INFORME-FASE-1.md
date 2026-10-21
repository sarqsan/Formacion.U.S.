# Informe de la fase 1

**Fecha:** 21 de octubre de 2026
**Estado:** bloque 1 completado. Detenido a la espera de autorización.

---

## 1. Repositorio, rama y commit de partida

| Dato | Valor |
| --- | --- |
| Repositorio | `github.com/sarqsan/Formacion.U.S.` |
| Rama de trabajo | `arena/89a0aca0-formacion-u-s` |
| Commit de partida | `c4ce33d7d1806f546c1d19892702bc27f401f108` (`Initial commit`) |
| Contenido inicial | solo `README.md` (17 bytes): repositorio vacío |
| Repositorio de cuadrantes | **no abierto, no clonado, no modificado** |

No se ha creado ningún commit, push, pull request, merge ni despliegue, tal como
pedías. Los cambios están en el árbol de trabajo de la rama.

---

## 2. Archivos creados o modificados

**18 entradas raíz**, ~7 000 líneas de código y pruebas. Resumen por área:

### Configuración y proyecto
`package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`,
`eslint.config.mjs`, `vitest.config.mts`, `.gitignore`, `.env.example`,
`firebase.json`, `firestore.indexes.json`, `firestore.rules`, `storage.rules`.

### Dominio (reglas puras, sin Firebase)
`src/domain/text.ts`, `roles.ts`,
`people/{surname,username,header,import-rows}.ts`,
`assessments/scoring.ts`,
`progress/{course-progress,reading}.ts`,
`courses/{versioning,content}.ts`,
`auth/{activation,authorization}.ts`,
`storage/paths.ts`.

### Servidor
`config.ts`, `http.ts`, `deps.ts`,
`auth/{tokens,session,activation-service}.ts`,
`import/{excel,request,service}.ts`,
`firebase/{admin,repositories}.ts`,
`admin/bootstrap-plan.ts`.

### Aplicación web
`src/proxy.ts` (protección de rutas),
`app/{layout,page,globals.css}`,
`app/login/*`, `app/activar/*`, `app/panel/*`,
`app/admin/page.tsx`, `app/admin/importar/*`,
`app/api/{health,me,activate,auth/session,admin/import/preview,admin/import/confirm}`,
`src/lib/firebase/client.ts`.

### Pruebas
13 ficheros en `tests/` (dominio, servidor, fixture XLSX generado en memoria).

### Documentación
`README.md` (reescrito), `docs/ARQUITECTURA.md`, `docs/MODELO-DATOS.md`,
`docs/SEGURIDAD.md`, `docs/PRUEBAS.md`, `docs/DECISIONES.md`, `docs/PLAN.md`
y este informe.

### Utilidades
`scripts/bootstrap-admins.mjs` (alta de administradores iniciales).

---

## 3. Arquitectura adoptada y decisiones pendientes

### Arquitectura

```
app/     Rutas Next.js y endpoints /api
server/  Sesión, servicios con puertos, adaptadores Firebase
domain/  Reglas puras: importación, evaluación, progreso, versionado, permisos
```

- **Next.js 16 + React 19 + TypeScript estricto**, Tailwind 4.
- **Firebase propio** (Auth + Firestore + Storage), sin conectar todavía.
- **Sesión:** cookie httpOnly emitida por servidor (`createSessionCookie`),
  SDK de cliente con `inMemoryPersistence`. Sin `localStorage`.
- **Importación:** el servidor recalcula siempre la vista previa e ignora
  cualquier nombre de usuario enviado por el cliente; toda cuenta nace
  `learner` + `pending_activation`.
- **Activación:** token de 32 bytes (hash SHA-256 en BD, 72 h, un uso) +
  contraseña personal fijada en servidor.
- **Evaluación:** corrección exclusiva en servidor; aprobado = todas correctas.
- **PDF:** bucket cerrado al cliente; URLs firmadas de 5 min; lectura página a
  página validada en servidor.
- **Versionado:** versiones inmutables; publicar `n+1` obliga a repetir curso.

Detalle completo en [`ARQUITECTURA.md`](ARQUITECTURA.md) y
[`MODELO-DATOS.md`](MODELO-DATOS.md).

### Decisiones pendientes (necesito tu respuesta)

1. **Criterio exacto de nombre de usuario** de la aplicación actual
   (ADR-004). Provisional: `rol1.garcia`, colisiones `rol1.garcia2`. Es lo
   único que no puedo deducir sin ver la aplicación antigua, que esta fase
   prohíbe inspeccionar.
2. **Entrega de los códigos de activación** (en mano, lista, canal interno).
3. **¿El cuestionario exige haber leído el tema completo?** (ADR-011,
   provisional: sí).
4. **Reintentos de evaluación**: ¿ilimitados o con espera entre intentos?
5. **Dominio de correo**: sintético `.invalid` (actual) o correo real futuro.
6. **Límite y origen del número de páginas** de cada PDF.
7. **Región de Firebase** (residencia de datos) y **plataforma de despliegue**.

---

## 4. Pruebas ejecutadas y resultados reales

### Automáticas

```bash
npm run verify   # typecheck && lint && test && build
```

| Comprobación | Resultado |
| --- | --- |
| `tsc --noEmit` | 0 errores |
| `eslint` | 0 errores, 0 avisos |
| `vitest run` | **208 pruebas / 13 ficheros — todas pasan** |
| `next build` | compila, 13 rutas |

Cobertura por área: importación (xlsx real, cabeceras, duplicados,
resoluciones), usuarios y apellidos, corrección de cuestionarios, progreso y
desbloqueo del examen, lectura secuencial, versionado, rutas de Storage,
autorización, activación (token usado/caducado/de otra cuenta), política de
contraseñas, tokens, configuración y comprobación de `Origin`, plan de
administradores.

### Manuales sobre la aplicación en ejecución

| Comprobación | Resultado |
| --- | --- |
| `GET /`, `/login` | 200 |
| `GET /panel`, `/admin` sin sesión | 307 → `/login` |
| `POST /api/activate` sin Firebase | 503 `SERVER_NOT_CONFIGURED` |
| `POST /api/activate` con `Origin` ajeno | 403 `ORIGIN_FORBIDDEN` |
| `POST /api/activate` sin `Origin` | 403 `ORIGIN_MISSING` |
| Firebase inaccesible | 503 `FIREBASE_UNAVAILABLE` |
| `POST /api/admin/import/preview` sin sesión | 401 `UNAUTHENTICATED` |
| Emuladores con `NODE_ENV=production` | 503 `SERVER_CONFIG_UNSAFE` |
| `node --check scripts/bootstrap-admins.mjs` | sintaxis correcta; sin credenciales termina con error claro |

### Fallos reales encontrados y corregidos

1. Un duplicado intra-fichero se marcaba como "ya existe en BD" (bloqueaba la
   resolución "es otra persona").
2. La comprobación de orden de temas no detectaba órdenes repetidos.
3. **La interfaz no tenía estilos**: faltaba la regla `@tailwindcss/turbopack`
   en `next.config.ts`. Detectado por los avisos `Unknown at rule: @theme` y
   confirmado midiendo el CSS generado (1,7 KB sin utilidades → 13,6 KB con
   ellas).
4. Firebase inaccesible devolvía 500 genérico en lugar de 503.
5. `middleware` está deprecado en Next 16 → migrado a `src/proxy.ts`.
6. Entorno sin `NODE_ENV` no compilaba en pruebas.

### No ejecutado (motivos)

Emulador de Firebase, pruebas de reglas con `rules-unit-testing`, conexión
real (login/importación/activación), visor PDF, endpoints de evaluación, E2E,
carga, accesibilidad y despliegue. Detalle y plan en [`PRUEBAS.md`](PRUEBAS.md).

**No se ha verificado contra Firebase porque no hay ningún proyecto Firebase
conectado.** Lo que sí está comprobado es que, sin configuración, la aplicación
falla cerrada (503) y que las reglas de negocio se cumplen en el dominio.

---

## 5. Riesgos detectados y dependencias externas pendientes

### Riesgos

| Riesgo | Impacto | Mitigación actual / propuesta |
| --- | --- | --- |
| Criterio de usuario distinto al real | Retrabajo en datos ya importados | Cambio aislado en `buildBaseUsername`; decidir **antes** de importar |
| Alta pública en Firebase Auth | Ocupación de correos y bloqueo de importaciones | Desactivar sign-ups + blocking function (bloque 5) |
| URL firmada de PDF = permiso temporal | Descarga en la ventana de 5 min | TTL corto, `no-store`; alternativa: servir bytes |
| Lectura secuencial no es DRM | Se puede leer en otro visor | Aceptado y documentado |
| Sin límite de intentos en activación | Fuerza bruta sobre tokens (inviable: 256 bits) | Añadir rate limit (bloque 5) |
| Sin MFA | Robo de credenciales de administrador | Valorar TOTP para admin |
| Avisos de dependencias (`@grpc/grpc-js`, `braces`) | Superficie de ataque | No se usan en tiempo de ejecución; revisar antes de desplegar |
| Sin auditoría externa | Fallos no detectados | Revisión de seguridad antes de datos reales |
| Duplicados con mismo apellido y rol | Cuentas duplicadas o personas omitidas | Decisión explícita del administrador (nunca automática) |

### Dependencias externas pendientes de autorización

1. Crear el **proyecto Firebase de Formación** (Auth + Firestore + Storage) y
   su cuenta de servicio.
2. Instalar `firebase-tools` y `@firebase/rules-unit-testing` (solo
   desarrollo y emulador local).
3. Elegir **plataforma de despliegue**.
4. Decidir **región** de los servicios.
5. Los **PDF reales** y el **Excel real** (no se han tocado).

Nada de esto se ha ejecutado: no hay servicios externos configurados ni
credenciales en el repositorio.

---

## 6. Siguiente bloque recomendado

**Bloque 2 — Emulador de Firebase y pruebas de reglas.**

Motivo: las reglas de Firestore y Storage son la última barrera frente a
manipulación desde el navegador, y están escritas pero **no probadas**. Antes
de cargar una sola persona real conviene demostrar con pruebas que:

- un alumno no puede escribir su progreso ni sus intentos;
- nadie puede leer las claves de corrección;
- un usuario recién importado no puede entrar sin activar;
- deshabilitar una cuenta corta la sesión en la siguiente petición;
- Storage no es accesible directamente ni siquiera para un administrador.

Todo ello en el emulador local, sin proyecto Firebase real, sin datos reales y
sin coste.

Criterio de aceptación: casos permitidos y denegados para cada colección,
`npm run verify` en verde y un informe con los resultados reales.

Cuando lo autorices, empiezo por ahí. Para el bloque 3 (contenido y
evaluaciones) necesitaré también tus respuestas a las decisiones 1–4 del
apartado 3.
