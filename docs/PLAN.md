# Plan por bloques

> **Estado real a 22/10/2026.** La numeración de este documento es la del plan
> inicial y **no** coincide con la secuencia ejecutada. Lo que hay hecho es:
> B03 (ciclo de versiones), B04 (editor de borradores), B05 (cuestionarios con
> claves separadas), B06 (subida de PDF por partes y cuota), B07 (visor PDF
> privado), B08 (publicación como puerta del servidor), B09 funcional
> (administración de cuentas: deshabilitar, reactivar y reemitir códigos) y B10
> (historial de formación: leer el progreso archivado), más la **revisión de las
> reglas de seguridad** (fase 1 de integración de Firebase: reglas revisadas,
> 57 pruebas escritas y 22 comprobaciones estáticas, motor sin ejecutar). Lo que queda pendiente de
> este plan es, sobre todo, el **bloque 2** (emulador y reglas) y todo lo que
> dependa de Firebase real: siguen **bloqueados** en este entorno por falta de
> JVM y de acceso a los servicios de Google. Ver `PRUEBAS.md` §22 y
> `ENTORNO-PRUEBAS.md`.


Cada bloque es pequeño, verificable y termina con la cadena `npm run verify`
en verde. Nada de esto está autorizado todavía más allá del bloque 1.

## Bloque 1 · Estructura, dominio y pruebas — **COMPLETADO**

- [x] Inspección del repositorio (vacío, solo `README.md`).
- [x] Arquitectura, modelo de datos, reglas de seguridad y documentación.
- [x] Dominio: roles, apellidos, usuarios, importación, evaluaciones,
      progreso, lectura secuencial, versionado, autorización, activación.
- [x] Servicios de importación y activación con puertos y dobles en memoria.
- [x] Lectura de XLSX real, límites y rechazos.
- [x] Reglas de Firestore escritas. (Fase 4: Storage eliminado por el plan
  gratuito; las reglas de Storage ya no existen.)
- [x] Interfaz mínima: portada, acceso, activación, panel, administración,
      importación con vista previa y decisiones.
- [x] 208 pruebas, `typecheck`, `lint` y `build` en verde.

## Bloque 2 · Emulador de Firebase y reglas — siguiente recomendado

Requiere autorización para instalar `firebase-tools` y ejecutar el emulador
(local, sin servicios externos, sin coste).

1. `npm i -D firebase-tools @firebase/rules-unit-testing`.
2. Proyecto *demo* del emulador (`demo-formacion`): Auth + Firestore.
3. Batería de pruebas de reglas:
   - un alumno **no** puede escribir `progress` ni `attempts`;
   - **no** puede leer `answerKeys`, `activationTokens`, `usernames`;
   - **no** puede cambiar su `role`/`status`/`claimsVersion`;
   - un administrador **sí** lee `accounts` y `audits`, pero **no** las claves;
   - nadie lee los fragmentos de PDF directamente (incluido admin).
4. Prueba de integración real: importar un Excel de prueba → activar una
   cuenta → iniciar sesión → comprobar que la cookie funciona y que
   deshabilitar la cuenta corta la sesión.
5. Criterio de aceptación: todas las reglas con caso permitido y denegado;
   `npm run verify` en verde; ningún dato real implicado.

## Bloque 3 · Contenido y evaluación (servidor + interfaz)

**Estado (21/10/2026):** el *servidor* de este bloque está hecho y probado con
dobles en memoria (fase 3): esquema, publicación de versiones, corrección de
evaluaciones, progreso/intentos, `db:init` y `db:check`. Faltan los endpoints,
la subida de PDF y la interfaz (puntos 1–4 y la ruta HTTP del 5). Ver
[`INFORME-FASE-3.md`](INFORME-FASE-3.md).

1. Endpoints de administración de cursos/versiones/temas (crear borrador,
   publicar, archivar) con `assertPublishable`.
2. Subida de PDF por multipart: límite de tamaño, verificación de que es PDF
   (`%PDF-`), cálculo de `sha256`, subida con Admin SDK a la ruta validada.
3. Endpoint que firma URLs por página con autorización previa y control
   secuencial (`assertCanViewPage`).
4. Visor con PDF.js: una página a la vez, sin acceso a la siguiente hasta
   registrar la actual.
5. Endpoints de cuestionario y examen: reciben opciones, corrigen con
   `gradeAttempt`, guardan intento y progreso; nunca devuelven la clave.
6. Criterio de aceptación: un alumno no puede desbloquear el examen sin temas;
   no puede saltarse páginas; reintentar funciona; versión nueva reinicia.

## Bloque 4 · Administración de personas y cuentas

1. Panel con estado por usuario, filtros y detalle (progreso, intentos).
2. Reemitir código de activación (revocando el anterior).
3. Deshabilitar/habilitar cuenta con transición validada y revocación de
   sesiones.
4. Alta de administradores desde interfaz (nunca por importación), con
   protección del último administrador.
5. Recuperación de contraseña mediante código (sin correo real).
6. Criterio de aceptación: cada acción queda en `audits`; un administrador
   deshabilitado pierde acceso en la siguiente petición.

## Bloque 5 · Endurecimiento y operación

1. Límite de intentos en `/api/activate` y en login (por IP y usuario).
2. Desactivar el alta pública en Firebase Auth y/o blocking function.
3. Copias de seguridad de Firestore y política de retención.
4. Revisión de accesibilidad y de textos.
5. Pruebas E2E (Playwright) de los flujos completos.
6. Revisión de `npm audit` y actualización de dependencias.

## Bloque 6 · Conexión y despliegue (solo con autorización)

1. Crear **proyecto Firebase nuevo** de Formación (región decidida contigo).
2. Desplegar reglas e índices; verificar en producción de pruebas.
3. Variables de entorno en el hosting; comprobar `APP_ORIGIN` y cookies
   `Secure`.
4. Ejecutar `scripts/bootstrap-admins.mjs --dry-run` y luego real.
5. Importar el Excel real (con revisión de la vista previa antes de confirmar).
6. Subir los PDF reales (autorización explícita).
7. Botón de acceso desde la aplicación de cuadrantes (cambio aislado, revisado
   aparte).

## Bloque 7 · Versión demostrable (hecho) — demostración de la semana próxima

**Hecho:** modo demostración (`DEMO_MODE=1`) con los servicios reales y almacén en
memoria; recorrido de alumno (lectura en orden, cuestionario repetible, examen
final desbloqueado, panel de progreso); panel de administración (cursos y
versiones, edición de borrador y publicación, matrículas, progreso e intentos,
vista previa de importación desde Excel); revisión visual y móvil; y una única
capa de datos (`src/server/portal`) que usa Firestore cuando no está
`DEMO_MODE=1`. Detalle en `docs/ENTREGA-DEMO.md`.

## Bloque 8 · Qué falta para enseñarlo la semana próxima

**No hace falta Firebase para la demostración**: `DEMO_MODE=1` es suficiente y
está verificado. Lo que sí conviene cerrar antes:

1. **Ensayo cronometrado** del guion (alumno 5 min; alumno + administración
   10 min) en ordenador y en móvil.
2. **Decidir qué se enseña del panel**: la importación se enseña como vista
   previa (la confirmación no crea cuentas en la demostración).
3. **Preparar la frase de encuadre**: «datos inventados, mismas reglas; la
   conexión con Firebase está implementada pero no ejecutada».
4. **No cargar datos reales** antes de la sesión.

**Mejoras que sí cambiarían la demo (no imprescindibles):**

1. ~~Editor de preguntas y creación de temas en el panel~~ — **hecho**:
   temas y estructura en el bloque 04 y cuestionarios y examen final con claves
   separadas en el bloque 05 (ADR-023 y ADR-024).
2. Subida de PDF y lectura real por páginas con documentos sintéticos.
3. Ejecutar las pruebas de reglas e integración con el emulador
   (`docs/ENTORNO-PRUEBAS.md`) y conectar `formacionus-63555` siguiendo
   `docs/CONEXION-FIREBASE.md`.
4. «Desidentificar y preparar temario» (ADR-019), solo después de lo anterior.

## Orden recomendado inmediato

**Bloque 2**, porque valida las reglas de seguridad antes de que exista
contenido real. Sin ese paso, "protegido" sería una afirmación sin prueba.
