# Decisiones (ADR)

Cada decisión indica su estado: **adoptada**, **provisional** (hay que
confirmarla) o **pendiente** (bloquea trabajo futuro).

---

## ADR-001 · Aplicación y repositorio independientes

**Estado:** adoptada.

Formación vive en su propio repositorio y usará su propio proyecto Firebase.
No se importa código, datos, usuarios ni reglas de la aplicación de cuadrantes.
La integración futura será un botón en aquella aplicación que abra esta URL.

**Consecuencia:** ningún cambio en esta fase puede romper cuadrantes. Si en el
futuro se toca aquel repositorio (solo el botón), será un cambio aislado y
revisado aparte.

---

## ADR-002 · Next.js 16 (App Router) + TypeScript estricto

**Estado:** adoptada.

Un solo despliegue para páginas y endpoints; la lógica sensible queda en el
servidor sin montar un backend aparte. TypeScript estricto reduce errores en
reglas de autorización.

**Alternativas descartadas:** SPA + API separada (más piezas para el mismo
equipo), Vite + Node (habría que resolver sesión, SSR y despliegue).

---

## ADR-003 · Dominio puro separado de la infraestructura

**Estado:** adoptada.

`src/domain` no importa Firebase ni Next. Permite probar hoy las reglas
críticas (corrección, progreso, autorización, importación) sin emuladores.

**Coste:** algunos adaptadores duplican tipos; aceptado a cambio de pruebas
reales y rápidas.

---

## ADR-004 · Criterio de nombre de usuario

**Estado:** **provisional — requiere confirmación.**

El enunciado pide el criterio "rol y apellido" de la aplicación actual, pero
esta fase prohíbe inspeccionarla. Se ha implementado una estrategia aislada y
sustituible:

```
ROL 1 + García  →  rol1.garcia
ROL 2 + García  →  rol2.garcia
colisión        →  rol1.garcia2, rol1.garcia3, …
```

Garantías independientes del formato final: determinismo, unicidad, caracteres
seguros `[a-z0-9.-]`, longitud ≤ 60, sin nombres reservados.

**Para cerrar la decisión** necesito saber, de la aplicación existente:

1. ¿El usuario es exactamente `rol` + separador + apellido? ¿Qué separador?
2. ¿Se usa el apellido completo, el primero o sus iniciales?
3. ¿Cómo se resuelven las colisiones (sufijo numérico, inicial del nombre, otro)?
4. ¿Los usuarios antiguos tienen formatos distintos que haya que respetar?

Cambiar el criterio solo afecta a `buildBaseUsername` y a sus pruebas.

---

## ADR-005 · Correo sintético con dominio reservado

**Estado:** adoptada (revisable si se quiere correo real).

Firebase Auth exige un identificador tipo correo y el Excel solo tiene dos
columnas. Se usa `usuario@formacion.invalid` (`.invalid` es un TLD reservado por
la RFC 2606: no enrutable). Ventajas: no se inventan datos personales, no se
puede enviar correo por accidente y no se confunde con una dirección real.

**Limitación:** no es posible "recuperar contraseña" por correo. La recuperación
se hará con un código de activación nuevo emitido por un administrador (ver
ADR-006 y bloque 4 del plan).

---

## ADR-006 · Activación con token de un solo uso

**Estado:** adoptada.

Flujo: la importación crea la cuenta con contraseña aleatoria **no entregada** y
un token de 32 bytes (solo se guarda su SHA-256, 72 h, un uso). El usuario
introduce usuario + token + contraseña nueva; el servidor valida la política,
fija la contraseña con Admin SDK, marca `active`, sube `claimsVersion` y revoca
sesiones.

**Alternativa descartada:** emitir un *custom token* y dejar que el cliente fije
la contraseña con `updatePassword`. La contraseña no pasaría por el servidor,
pero no habría forma de demostrar en servidor que se cambió antes de activar la
cuenta.

**Riesgo aceptado:** la contraseña viaja una vez al servidor por HTTPS. No se
registra ni se almacena; Firebase la guarda con scrypt.

**Pendiente de decidir:** cómo se entregan los códigos (en mano, lista impresa,
canal interno). En esta fase no hay envío automático.

---

## ADR-007 · Sesión con cookie httpOnly emitida por el servidor

**Estado:** adoptada.

`signInWithEmailAndPassword` → ID token → `POST /api/auth/session` →
`createSessionCookie` (httpOnly, Secure, SameSite=Lax, 12 h) → `signOut()` en
el cliente. El SDK usa `inMemoryPersistence`: no queda nada en localStorage ni
IndexedDB.

Cada petición verifica la cookie (`checkRevoked`) **y** relee la cuenta:
`status` y `claimsVersion` de la base de datos mandan sobre el token.

**Prohibido por el enunciado:** simular sesiones con localStorage. Aquí no se
usa ninguna marca de sesión legible por JavaScript.

**Pendiente:** "recordarme" (sesión de 5 días) si se considera necesario.

---

## ADR-008 · Duplicados: nunca se omiten en silencio

**Estado:** adoptada.

Dos personas del mismo rol pueden compartir apellido y ser reales. Por eso:

- duplicado dentro del fichero → fila marcada, **bloquea la confirmación**
  hasta que el administrador elija "omitir" o "es otra persona" (crea
  `rol1.garcia2`);
- usuario que ya existe en la base de datos → solo se puede omitir;
- el servidor **recalcula** la vista previa e ignora los usuarios propuestos
  por el cliente.

---

## ADR-009 · Storage cerrado al cliente, URLs firmadas de 5 minutos

**Estado:** **SUSTITUIDA por ADR-014** (21/10/2026). Se conserva como registro
histórico: describía el diseño mientras se asumía el plan Blaze. El plan
gratuito Spark no incluye Storage, así que ya no hay bucket ni URLs firmadas.

Las reglas de Storage deniegan toda lectura/escritura directa, incluso a
usuarios activos y administradores. La subida y la firma las hace el servidor.
Motivo: una regla "usuario activo puede leer" permitiría descargar cualquier PDF
conociendo la ruta.

**Riesgo residual:** una URL firmada es un permiso temporal de portador. Se
mitiga con TTL de 300 s, `no-store`, y no registrándola. Si se exige más, la
alternativa es servir bytes desde el servidor (más coste) o PDF cifrado por
usuario (bloque aparte).

---

## ADR-010 · Curso publicado = versión inmutable

**Estado:** adoptada.

Editar contenido crea una versión nueva; publicar exige `actual + 1`. El
progreso se guarda con `version`; publicar una versión nueva implica repetir el
curso (`requiresNewCompletion`). El progreso anterior se archiva, no se borra.

---

## ADR-011 · El cuestionario se abre al terminar la lectura del tema

**Estado:** **provisional — confirmar.**

Interpretación de "cuestionario al terminar cada tema": se exige haber visto
todas las páginas de todos los documentos del tema (control en servidor). Si se
prefiere que el cuestionario esté disponible desde el principio, basta con
desactivar la comprobación en el endpoint del cuestionario (el dominio ya
separa ambos conceptos).

---

## ADR-012 · Sin curso de ejemplo

**Estado:** adoptada.

Se han implementado validación y reglas de contenido, pero **no** se crea un
curso ficticio: el contenido real lo publicará administración. Así no se
confunde material de prueba con formación válida.

---

## ADR-013 · Administradores iniciales por script, no por interfaz

**Estado:** adoptada.

`scripts/bootstrap-admins.mjs` crea varios administradores de una vez, de forma
idempotente, con token de activación (sin contraseñas compartidas), `--dry-run`
y `BOOTSTRAP_CONFIRM=yes`. La importación de Excel **nunca** crea admin.

**Pendiente:** interfaz para que un administrador dé de alta a otro (bloque 4),
con protección del último administrador ya implementada en dominio.

---

## Decisiones pendientes (resumen para el usuario)

| # | Pregunta | Bloquea |
| --- | --- | --- |
| 1 | Criterio exacto de nombre de usuario (ADR-004) | Datos reales y, si cambia, migración |
| 2 | Entrega de códigos de activación | Operación real |
| 3 | ¿Cuestionario tras leer el tema o libre? (ADR-011) | Experiencia del alumno |
| 4 | ¿Reintentos de evaluación ilimitados o con espera? | Endpoint de evaluación |
| 5 | ¿Correo real en el futuro (avisos, recuperación)? | Modelo de identidad |
| 6 | Límite y origen del nº de páginas de cada PDF | Carga de documentos |
| 7 | Región de Firebase y residencia de datos | Creación del proyecto |
| 8 | Plataforma de despliegue | Bloque 6 |
| 9 | ¿MFA para administradores? | Endurecimiento |

---

## ADR-014 · PDF fragmentados en Firestore, sin Firebase Storage

**Estado:** adoptada (21/10/2026). Sustituye a ADR-009.

**Contexto.** El proyecto debe funcionar en el plan **Spark** (gratuito). Spark
no incluye Cloud Storage: crear un bucket exige el plan Blaze y una tarjeta. El
diseño anterior (ADR-009) dependía de un bucket privado y de URLs firmadas.

**Decisión.** Los PDF se guardan en Firestore troceados:

- metadatos en `documents/{documentId}` (sin binario y sin rutas);
- fragmentos en `pdfChunks/{documentId}_{n}`, campo `data` de tipo `Bytes`;
- lectura por páginas a través de `/api/documents/{id}/pages` (hasta 20 páginas
  y 768 KiB por petición), que exige sesión, matrícula activa y versión
  publicada;
- cuota controlada por `meta/storage.usedBytes`, escrito en la misma
  transacción que los fragmentos.

**Por qué fragmentos de 768 KiB.** Firestore limita cada documento a 1 MiB. Con
`Bytes` (no base64) sobra margen; en base64 un fragmento ocuparía exactamente
1 MiB y no cabría el envoltorio.

**Corrección de la Fase 6 (ADR-016).** El tope de 20 MiB era incompatible con
el límite de **10 MiB por petición/transacción** de Firestore: 27 fragmentos son
20,25 MiB y la subida fallaba siempre. Se baja el tope a **8 MiB** (11
fragmentos = 8,25 MiB + 512 KiB de margen ≤ 10 MiB).

**Consecuencias.**

- Cero coste: no hay bucket, ni salida de datos de Storage, ni tarjeta.
- La lectura de un PDF consume lecturas de Firestore (una por fragmento). Ver
  el cálculo en `docs/INFORME-FASE-4.md`.
- Si el corpus no cabe en ~512 MiB, hay que archivar, comprimir o cambiar de
  estrategia; **no** se sube el plan.
- El contenido público de un curso ya no incluye `storagePath`: no hay nada
  que enlazar.

**Riesgo residual.** Sigue siendo un control de aplicación, no DRM: un alumno
activo con acceso al curso puede descargar las ventanas del PDF que está
viendo. Lo que se elimina es el enlace público y la dependencia de pago.

## ADR-015 · Matrícula explícita; publicar no da acceso

**Estado:** adoptada (21/10/2026).

**Contexto.** Hasta la Fase 5, cualquier cuenta activa leía el contenido de
cualquier curso publicado. Un alumno de un curso podía abrir los PDF y los
cuestionarios de otro, y bastaba con publicar para exponer contenido.

**Decisión.** La relación usuario–curso vive en `enrollments/{uid}_{courseId}`:

- `status` es `active` o `revoked`; `isEnrollmentActive` exige exactamente
  `active` (cualquier otro valor deniega);
- solo un administrador activo matricula o revoca, y el rol se toma de la
  sesión, nunca del cuerpo de la petición;
- `assertCourseAccess(actor, courseId, deps)` es la única puerta de entrada al
  contenido (documentos y evaluaciones);
- revocar no borra el progreso: al reactivar, el alumno sigue donde estaba;
- las reglas de Firestore cierran `enrollments` a escritura y limitan su lectura
  a la propia matrícula (o al administrador).

**Consecuencias.** Importar personas ya no da acceso a ningún curso: hace falta
matricular. Un curso publicado sin matrículas no lo ve nadie salvo
administración. Las reglas nuevas **no se han podido ejecutar** en este entorno
(sin emulador): están escritas y pendientes de verificación.

## ADR-016 · Tope de PDF 8 MiB y lectura por páginas con límites

**Estado:** adoptada (21/10/2026). Corrige ADR-014.

**Contexto.** Dos defectos reales de la Fase 5: (1) 27 fragmentos de 768 KiB no
caben en la transacción de 10 MiB, así que la subida de un PDF grande fallaba
siempre; (2) el endpoint de lectura no tenía autorización por curso ni límite
de peticiones, y permitía pedir fragmentos en bucle hasta agotar la cuota
gratuita (50 000 lecturas/día) y apagar la aplicación.

**Decisión.**

- `MAX_PDF_BYTES = 8 MiB`, `MAX_CHUNKS = 11`, con
  `assertFitsTransaction` calculado sobre `MAX_TRANSACTION_BYTES` (10 MiB) y
  512 KiB de margen.
- La lectura pide páginas (`from`, `to`), máximo 20 por petición y 768 KiB; el
  progreso solo se guarda tras leer con éxito.
- Limitador de ventana deslizante en memoria: 600 páginas/hora por usuario y
  6000/hora en total para lectura; 20/120 para subidas.
- Toda barrera se comprueba en el servidor; el cliente no puede enviar página,
  progreso ni APTO.

**Consecuencias.** PDF de hasta 8 MiB (antes: ninguno de más de ~9 MiB se podía
subir). El límite de peticiones es **por proceso**: con varias instancias se
multiplica por el número de instancias, y hay que moverlo a un almacén
compartido el día que haya más de una.

## ADR-017 · Copia de seguridad cifrada propia (sin servicios de pago)

**Estado:** adoptada (21/10/2026).

**Contexto.** El plan Spark no incluye exportaciones gestionadas, ni backups
programados, ni PITR: todo eso exige Blaze. El proyecto necesita poder
recuperarse sin pagar y sin subir datos personales a un tercero.

**Decisión.** Exportación propia sobre el Admin SDK, en un archivo `.fbak`:

- recorre todas las colecciones, incluidas las subcolecciones de versiones;
- codifica `Bytes` y `Timestamp` sin pérdida (JSON con etiquetas) y **se detiene**
  ante un tipo que no sabe representar;
- cifra con **AES-256-GCM** y clave derivada con **scrypt** de una contraseña
  (`BACKUP_PASSPHRASE`, mínimo 12 caracteres), nunca guardada;
- el manifiesto solo lleva metadatos (colecciones, recuentos, tamaños, sal, IVs,
  etiquetas, SHA-256);
- la restauración verifica bloque a bloque, exige destino vacío salvo `--force`,
  escribe en lotes de ≤400 documentos / ≤6 MiB y comprueba el recuento final;
- `--dry-run` valida sin escribir.

**Consecuencias.**

- La copia incluye claves de corrección y datos personales: se trata como
  material sensible (cifrada, fuera del repositorio, con la contraseña aparte).
- **No** incluye Firebase Authentication: tras restaurar hay que recrear las
  cuentas o re-activar a las personas.
- No hay instantánea global: la copia puede mezclar dos instantes si se hace con
  la aplicación en marcha.
- La restauración no es atómica global (por lotes); un fallo a mitad deja estado
  parcial y se detecta.

**Pendiente.** Ejecutar exportación y restauración contra el emulador y ensayar
una recuperación completa cronometrada en un proyecto desechable. Mientras eso
no ocurra, la restauración **no se declara terminada**.


## ADR-018 · Modo demostración con los mismos servicios y almacén en memoria

**Contexto.** Hace falta enseñar la aplicación la semana próxima y el entorno de
trabajo no tiene Firebase ni emulador. La alternativa barata sería una maqueta
con pantallas falsas; el problema es que entonces la demostración no diría nada
sobre el comportamiento real (orden de lectura, corrección en servidor,
matrícula, publicación de versiones).

**Decisión.** Un modo `DEMO_MODE=1`, explícito y visible, que:

- implementa **los mismos puertos** de persistencia (`CourseCatalogStore`,
  `EnrollmentStore`, `LearningStore`) con un almacén en memoria;
- ejecuta los **servicios reales** de evaluación, matrículas, lectura y
  publicación sin duplicar reglas en la interfaz;
- usa una cookie con el uid de una cuenta inventada, nunca una sesión de Firebase;
- muestra una franja permanente de «modo demostración» y una página `/estado`
  con lo conectado y lo que no;
- recorre la lectura con pantallas de texto en lugar de PDF, porque el binario
  necesita Firestore y no hay documentos reales que enseñar (ni se deben usar).

**Consecuencias.**

- Enseñar la aplicación no exige tocar Firebase ni cargar datos personales.
- El modo está apagado por defecto y **no puede activarse solo**: sin
  `DEMO_MODE=1` la aplicación pide Firebase y no hay datos de ejemplo.
- Las pruebas de la demostración verifican reglas de verdad (14 casos), pero **no
  sustituyen** a las pruebas de reglas ni a las transacciones contra el emulador.
- Todo lo que se simula está dicho en pantalla; nada se presenta como conectado.

**Pendiente.** Editor de preguntas, creación de temas desde la interfaz y subida
de PDF real: las tres necesitan persistencia de verdad para probarse.

## ADR-019 · «Desidentificar y preparar temario»: aparcado, con alcance definido

**Contexto.** Se ha pedido una función que quite referencias identificativas de
los PDF antes de publicarlos (texto, imágenes, metadatos) y que el administrador
revise y apruebe el resultado. Implicaría OCR, detección de entidades y revisión
humana; y, si se resuelve con un servicio externo, enviar documentos fuera del
entorno.

**Decisión.** No implementarla todavía. No es necesaria para la versión
demostrable, y hacerla a medias daría una falsa sensación de seguridad sobre
justo lo que más importa: que no se escape un dato identificativo.

**Alcance guardado para cuando se aborde** (detalle en `docs/ENTREGA-DEMO.md` §8):
subida a un entorno de preparación, extracción de texto e imágenes, detección de
referencias, transformación con marcadores, comparación original/resultado,
aprobación explícita auditada y generación del material definitivo solo tras la
aprobación. Criterio de aceptación: en un conjunto de PDF de muestra no sobrevive
ninguna referencia identificativa, y el original nunca se publica.

**Coste.** Cero si se resuelve en local (OCR y reglas propias, más trabajo); con
coste y cesión de documentos si se usa un servicio externo. Cualquier opción
requiere autorización explícita.

## ADR-020 · Una sola capa de datos: el portal elige demo o Firestore

**Contexto.** La demostración y la aplicación real compartían la interfaz, pero
las pantallas leían directamente del almacén en memoria. Conectar Firestore
habría obligado a duplicar páginas o a mantener dos versiones de la aplicación,
y a partir de ahí las dos se habrían separado.

**Decisión.** Un único punto de entrada (`src/server/portal`) que elige la
persistencia según la configuración del proceso y expone las mismas funciones
para las dos:

- con `DEMO_MODE=1`, almacén sintético en memoria;
- sin él, Firestore y Firebase Authentication del proyecto `formacionus-63555`.

El cálculo de la vista del alumno (progreso, temas, documentos, examen) vive en
`src/server/portal/learner.ts` y lo usan **las dos** implementaciones, de modo
que la demostración no puede mostrar un porcentaje distinto del real.

El **identificador del proyecto** es un dato del entorno, no una suposición: el
ID real, confirmado el 21/10/2026, es `formacionus-63555`. Aparece en un solo
sitio por capa (`.firebaserc`, `EXPECTED_PROJECT`, `.env.example`) y una prueba
falla si esos tres dejan de coincidir o si reaparece el identificador antiguo.
Los valores de la app web (`apiKey`, `appId`) no se escriben en el repositorio:
se copian de la consola cuando el usuario los facilite.

**Consecuencias.**

- La conmutación es explícita y no depende de que una consulta falle: si
  Firestore no responde en modo real, se muestra un error de datos y **no** se
  cae al almacén de memoria (sería una pérdida invisible de progreso).
- Toda función de administración se autoriza en servidor **antes** de leer: el
  Admin SDK elude las reglas de Firestore, así que esa barrera es la única que
  existe en el servidor.
- Añadir una función nueva supone implementarla una vez en la interfaz y dos en
  la capa de datos; el compilador avisa si falta una de las dos.

## ADR-021 · Los metadatos de documentos son solo-servidor

**Contexto.** Hasta el esquema v1, `firestore.rules` permitía leer
`documents/{documentId}` a cualquier cuenta activa matriculada en el curso del
documento. El razonamiento era que solo contenía metadatos (título, páginas,
tamaño). Con el ciclo de vida de cursos aparece un caso que ese razonamiento no
cubría: los metadatos de un documento de una versión **en borrador**. Un alumno
matriculado que conociera un identificador podía leer el título y el número de
páginas de material que todavía no se ha publicado. La aplicación nunca ha
leído Firestore desde el navegador (todo pasa por el servidor con el Admin
SDK), así que la regla no aportaba ninguna funcionalidad: solo superficie.

**Decisión.** `documents` pasa a `allow read, write: if false` y sale de
`CLIENT_READABLE_COLLECTIONS`, que ahora enumera exactamente las colecciones
que las reglas abren al cliente. Los metadatos se sirven únicamente desde el
servidor, en las rutas que ya comprueban sesión, matrícula y publicación.

**Consecuencias.**

- Un identificador conocido no revela nada: ni el documento ni sus metadatos.
- Las pruebas de deriva obligan a que la lista de colecciones legibles y las
  reglas sigan coincidiendo; `tests/rules` fija la expectativa de que **ni el
  administrador** lee `documents` desde el cliente.
- El cambio no exige migrar datos ni desplegar reglas para que la aplicación
  siga funcionando (el servidor no pasa por reglas). Sí hay que desplegarlas
  para que la barrera exista: **no se ha hecho desde este entorno**.

## ADR-022 · Un curso nace sin versiones; las plantillas clonan sin compartir estado

**Contexto.** El alta de cursos no existía. La tentación, para reutilizar el
editor que ya había, era crear una «versión 1 vacía» al crear el curso y exigir
que estuviera completa para poder guardarla. Eso tiene dos efectos malos:
obliga a inventar contenido para que exista el curso, y debilita la validación
de publicación si se relaja para permitirlo.

**Decisión.**

1. Crear un curso escribe **una sola ficha** con `publishedVersion: null` y
   `lastDraftVersion: null`. No se crea ninguna versión y no se exige contenido
   ni publicación. El borrador incompleto es un estado legítimo y se guardará
   en el bloque siguiente; la puerta de publicación (`validateCourseVersion`)
   no se relaja.
2. El alta usa `create()` y no `set()`: crear nunca sobrescribe un curso
   existente. Al ser una sola escritura atómica, no hace falta transacción; se
   usará cuando el curso y su primera versión se creen a la vez.
3. Las plantillas viven en `src/domain/courses/template.ts`. La definición
   vacía no valida para publicar (a propósito) y la clonación de una versión
   para un borrador es una **reconstrucción campo a campo**, no un clon
   genérico: el compilador obliga a revisar el clon cuando se añada un campo
   nuevo, que es justo la situación en la que dos versiones acabarían
   compartiendo un array. Los metadatos (fecha y autoría) nunca se copian: la
   versión nueva se creó ahora y por quien está operando ahora.

**Consecuencias.**

- «Sin versiones» es un estado visible y explicable en el panel, no un error.
- Un curso sin versión publicada no aparece en el catálogo y no admite
  matrículas.
- Las pruebas fijan las dos propiedades: estado inicial con los dos punteros a
  null, y clonación con independencia en todos los niveles de anidamiento
  (temas, documentos, cuestionarios, opciones y claves).

## ADR-023 · El borrador se guarda con tres niveles de validación y concurrencia optimista

**Contexto.** El bloque 03 dejó los cursos naciendo sin versiones. Faltaba poder
trabajar el contenido: crear el primer borrador, guardarlo a medias y retomarlo
días después, sin publicar nada y sin poder estropear lo publicado. Dos
tentaciones a evitar: (a) reutilizar `validateCourseVersion` para decidir si se
puede guardar, lo que impediría guardar un borrador vacío; (b) «arreglar» la
concurrencia con un `set()` optimista, que perdería el trabajo de otra pestaña.

**Decisión.**

1. **Tres niveles, un solo código de publicación.** `checkDraftStructure`
   (dominio) solo mira la forma —identificadores, longitudes, órdenes— y es lo
   único que bloquea el guardado. `reviewDraft` presenta como avisos los
   problemas que detecta `validateCourseVersion`, que **no se toca**: sigue
   siendo la puerta de publicación, en su bloque. Un borrador vacío o incompleto
   se guarda, y se ve sin ambigüedad que todavía no es publicable.
2. **Abrir un borrador es una transacción con estado esperado.** La versión y
   `courses.lastDraftVersion` se escriben juntas, comprobando los punteros
   leídos. Si la ficha cambió, `DRAFT_CONFLICT` sin escribir y el servicio
   reintenta releyendo: la segunda pasada reanuda el borrador existente en lugar
   de crear otro. Nunca quedan versiones huérfanas ni punteros a versiones que no
   existen. Si la versión ya existía como borrador, se **adopta** fijando solo
   el puntero.
3. **Guardar exige la revisión abierta.** `revision` empieza en 1 y se
   incrementa en cada guardado; el almacén compara y rechaza con `DRAFT_STALE`
   sin escribir. Dos pestañas, dos administradores o un doble clic no se pisan en
   silencio: la segunda operación recibe un error con mensaje y la persona
   recarga. Es concurrencia optimista, no bloqueos.
4. **La versión publicada es intocable.** Solo se aceptan escrituras sobre
   `status: "draft"` (`VERSION_NOT_EDITABLE` en cualquier otro caso) y el
   borrador nace de una clonación profunda de la publicada, sin referencias
   compartidas. Publicar **consume** el borrador: `lastDraftVersion` vuelve a
   `null` en la misma transacción.
5. **El editor no edita todo.** Este bloque gestiona título, descripción y
   temas (crear, renombrar, reordenar, marcar obligatorio, eliminar). Los
   documentos y los cuestionarios se **conservan por identificador**; las claves
   de corrección no se tocan. Editar preguntas y subir PDF es otro bloque, y no
   se finge que está hecho.

**Consecuencias.**

- Eliminar un tema es seguro: solo puede ocurrir en un borrador, y la versión
  publicada y el histórico no se modifican (hay prueba explícita de que el
  documento publicado queda idéntico campo a campo).
- Un borrador sin cuestionarios no tiene documento de `answerKeys`: se trata
  como `null` en lugar de como error, y `ANSWER_KEYS_MISSING` solo aparece si se
  intenta clonar una versión **publicada** que debería tenerlas y no las tiene.
- Los errores llevan código (`DRAFT_STALE`, `DRAFT_CONFLICT`,
  `COURSE_STRUCTURE_INVALID`, `DEFINITION_TOO_LARGE`) y la interfaz muestra el
  mensaje real; nunca hay un «guardado» sin confirmación del servicio.
- El límite de 800 KiB por definición se comprueba en el servicio con el tamaño
  UTF-8 real, antes de acercarse al 1 MiB por documento de Firestore; no se
  duplica la regla en la interfaz.

## ADR-024 · Los cuestionarios del borrador se editan con su clave en una sola escritura

**Contexto.** El bloque 04 dejó el editor de estructura: títulos, descripción y
temas. Faltaban las preguntas, y sin ellas ningún curso puede publicarse
(`validateCourseVersion` exige cuestionario en los temas obligatorios y examen
final). El modelo separa contenido público (`versions/{n}`, sin respuestas) y
claves (`answerKeys`, solo servidor), así que editar preguntas toca **dos**
documentos.

**Decisión.**

1. **Una operación, dos documentos.** `replaceDraftContent` escribe la
   versión y sus claves en la misma transacción. Hacerlo en dos pasos dejaría
   una ventana en la que la versión tiene preguntas cuya respuesta correcta
   todavía no existe: un intento entregado en ese instante sería incobrable y el
   alumno vería un fallo imposible de explicar.
2. **Las claves se recalculan, no se parchean.** Se derivan del contenido
   (`toAnswerKeys`) en cada guardado. Así una pregunta eliminada no deja su
   clave huérfana y no hay forma de que contenido y clave se desincronicen.
3. **El formulario no manda las preguntas existentes.** La acción relee la
   versión y fusiona los cambios por identificador: lo que no llega se elimina,
   y un campo manipulado no puede inventar una pregunta. Los identificadores de
   pregunta y opción son estables; renombrar la opción no la cambia.
4. **Misma concurrencia que el resto del borrador.** Se exige `revision`; un
   guardado con la revisión vieja devuelve `DRAFT_STALE` sin escribir.
5. **Nada de esto publica ni relaja la puerta.** Un cuestionario vacío se
   guarda; `validateCourseVersion` sigue siendo quien decide si algo es
   publicable. `optionLabels` sin texto es un **aviso** (el alumnado vería el
   identificador), no un error: el contenido anterior al editor no tiene
   etiquetas y bloquearlo obligaría a reescribir cursos ya publicados.

**Consecuencias.**

- Editar preguntas de una versión publicada es imposible por contrato
  (`VERSION_NOT_EDITABLE`, 409); hay que crear la siguiente versión.
- El documento de claves conserva su `createdAt` original al editarse.
- La vista del editor incluye las respuestas correctas porque solo la consumen
  pantallas de administración; el alumnado sigue recibiendo `PublicQuestion`.
- Las pruebas fijan: contenido sin claves, claves sin restos, atomicidad ante
  fallo del almacén, publicación intacta y ausencia de respuestas en la vista
  del alumno.

## ADR-025 · La subida de un PDF es un ciclo con estados, no una escritura

**Contexto.** El bloque 06 tiene que aceptar PDF de hasta 8 MiB en una
plataforma cuyo plan gratuito no incluye Cloud Storage y cuyas funciones
desplegadas tienen un límite de cuerpo pequeño (≈4,5 MB documentados por Vercel
en Hobby, no medibles desde el repositorio). El PDF vive troceado en Firestore
(768 KiB por fragmento), y Firestore limita a 1 MiB por documento y 10 MiB por
transacción. Una sola petición con el fichero entero no es una opción.

**Decisión.**

1. **Cuatro pasos idempotentes con estado explícito** en lugar de un `PUT`
   grande: `create → putPart × n → finalize`, y `abort` para cancelar. El estado
   (`pending`, `active`, `aborted`, `archived`) está en el documento, no en la
   memoria del proceso: si el servidor se reinicia a mitad, la subida se puede
   reanudar o cancelar.
2. **La cuota se reserva al crear, no al terminar.** Sin reserva habría una
   ventana en la que diez subidas simultáneas caben todas y el presupuesto se
   desborda al finalizar. La reserva se comprueba y se escribe en la **misma
   transacción** que el registro; al finalizar se convierte en uso y al cancelar
   se libera. `create` es idempotente por `documentId`, así que un reintento no
   reserva dos veces.
3. **El SHA-256 se verifica fuera de la transacción de finalización.** Leer once
   fragmentos (8,25 MiB) dentro de una transacción se acerca al límite de 10 MiB
   con el propio PDF y con el registro de cuota. Se leen y se comprueban antes; y
   solo cuando la huella coincide, una transacción corta mueve la reserva a uso y
   activa. El coste es una ventana en la que el documento está `pending` aunque
   sus bytes ya estén escritos: es visible (aparece como pendiente) y no se sirve
   a nadie.
4. **El identificador lo pone el servidor.** `doc_` + 32 hex de
   `sha256(courseId|version|topicId|bytes|sha256)`. Dos consecuencias buscadas:
   el cliente no puede elegir ni adivinar un id para ocuparlo, y subir dos veces
   el mismo fichero al mismo tema es la misma operación (idempotencia gratis).
   Sustituir un PDF es subir otro: un activo nunca se sobrescribe.
5. **Solo un `active` cuenta.** `pending` y `aborted` no se sirven, no se
   asocian y no se publican. Asociar exige además que la versión sea `draft`.
6. **Nada de un fichero de 8 MiB como base64 en un documento**: serían ~10,7 MiB
   en un límite de 1 MiB. El troceado en `Bytes` no es una optimización.

**Consecuencias.**

- Reanudar exige volver a elegir el fichero (el navegador no conserva `File`
  entre recargas); el servidor comprueba el tamaño y acepta las partes que ya
  tenía. El editor dice explícitamente «el documento aún no está guardado»
  hasta que la finalización responde.
- Una subida abandonada ocupa su reserva hasta que se cancela desde el editor:
  **no hay TTL**, porque Firestore solo lo ofrece en Blaze.
- El número de páginas es **declarado**, no verificado: el servidor no
  interpreta PDF. La interfaz exige confirmarlo y lo deja escrito.
- `archiveDocument` libera el uso de un activo que ya no se referencia, sin
  borrar el historial de la versión que lo usó.
- La atomicidad de la reserva está probada en dobles y en la demo; contra
  Firestore real **no está verificada** (sin JVM no hay emulador).

## ADR-026 · La demostración no pide configuración de Firebase para subir PDF

**Contexto.** Las rutas nuevas nacieron llamando a `getServerConfig()` para
comprobar el origen de la petición. En la demostración (`DEMO_MODE=1`) no hay
`FIREBASE_PROJECT_ID` ni credenciales, así que todas las llamadas devolvían 503:
la sección de PDF se veía, pero ningún botón funcionaba.

**Decisión.** Dos piezas pequeñas, sin duplicar el camino real:

1. `configuredAppOrigin()` lee **solo** `APP_ORIGIN` (opcional). La comprobación
   de origen (`assertTrustedOrigin`) es la misma de siempre y sigue aceptando el
   `Host` real como respaldo.
2. `requirePortalActor()` resuelve la sesión de la demo en modo demostración y
   delega en `requireActor()` (Firebase) en modo real. La autorización no se
   decide ahí: `assertAdmin` sigue en el servicio.

**Por qué no se relaja la seguridad.** En modo real el camino completo sigue
exigiendo la configuración entera —incluido el endurecimiento de producción
(`APP_ORIGIN` obligatorio y https, prefijo `__Host-` en la cookie)— porque
`requireActor()` la pide antes de leer la sesión. Lo único que cambia es que una
petición **anónima** en la demostración ya no falla con un 503 engañoso.

**Consecuencias.** El recorrido `check:demo` ejercita las rutas HTTP reales de
subida (crear, partes, finalizar, asociar, cancelar) contra el mismo código que
se despliega; las pruebas estáticas de autorización aceptan `requirePortalActor(`
como guarda de sesión, con lo que sigue sin poder añadirse una ruta de
administración sin guarda.

## ADR-027 · Publicar es una puerta del servidor, no un botón desactivado

**Contexto.** El bloque 03 dejó `publishCourseVersion` comprobando el orden de
las versiones (`assertPublishable`) y la existencia de claves, y el bloque 04
añadió en el panel de administración un botón «Publicar» que se **desactiva**
mientras queden problemas de validación. El bloque 05 empezó a guardar
borradores incompletos a propósito (un curso a medias tiene que poder
guardarse). El resultado era una garantía de interfaz, no de servidor: una
acción de servidor se puede enviar sin pasar por el navegador, y entonces se
publicaba un curso sin temas, sin examen o con un PDF que no existe.

Al escribir la comprobación aparecieron dos defectos que solo se ven al
publicar de verdad:

1. **`validateCourseVersion` rechazaba los identificadores de documento
   reales.** Exigía forma de slug (`[a-z0-9-]`), pero el servidor genera los
   identificadores como `doc_` + 32 hex (bloque 06). Cualquier curso con un PDF
   subido era, literalmente, imposible de publicar. No se había notado porque
   la publicación nunca validaba el contenido.
2. **El adaptador de Firestore no archivaba la versión anterior.** Los dobles y
   la demostración sí (y el comentario del doble decía «igual que la transacción
   real»), pero `FirestoreCourseCatalogStore.publishVersion` solo actualizaba la
   nueva y el puntero. Tras publicar la v2, la v1 seguía `published`: la
   siguiente publicación habría fallado con `VERSION_MULTIPLE_PUBLISHED` (500,
   «estado inconsistente») y la vista del alumnado podía resolver dos versiones.

**Decisión.**

1. **Validación en servidor.** `publishCourseVersion` aplica
   `validateCourseVersion` a la definición **reconstruida** con
   `definitionFromDocuments(versión, claves)`. No se duplica la regla: es la
   misma función que usa el editor para avisar. Un borrador se guarda igual de
   permisivo que antes; lo que cambia es que ya no se puede publicar lo que el
   editor marca como error.
2. **Los documentos son parte de la publicación.** Puerto estrecho
   `PublishDocumentLookup` (`getMeta`), y `checkPublishableDocuments` exige, para
   cada documento: identificador seguro, existencia, `state === "active"`,
   todas las partes recibidas y que sea del mismo curso. Devuelve **todos** los
   problemas a la vez y el servicio responde `DOCUMENT_NOT_PUBLISHABLE` (409)
   con la lista. No se lee ni un byte del PDF.
3. **El tipo obliga.** `publishCourseVersion` recibe `PublishDependencies`
   (catálogo **+** documentos), no las dependencias generales. Si alguien
   intenta publicar sin la consulta de documentos, no compila: la garantía no
   depende de acordarse.
4. **La regla de identificadores de documento se alinea con el almacén.**
   `validateCourseVersion` usa `isSafeDocumentId` (la misma que la ruta que
   sirve el PDF y la que valida el almacén) en lugar de la de slugs. Sigue
   rechazando formas de ruta (`../`), que es lo que la regla protegía; deja de
   rechazar lo que el propio servidor genera.
5. **Archivar la anterior, en la misma transacción.** El adaptador de Firestore
   lee el puntero del curso, marca `archived` la versión publicada anterior y
   actualiza versión + puntero + `lastDraftVersion: null` en una sola
   transacción (todas las lecturas antes de la primera escritura). Se conserva
   la v1 y sus claves: el histórico no se borra.

**Consecuencias.**

- Un fallo de la puerta ocurre **antes** de escribir: la versión sigue en
  borrador, el curso mantiene su versión publicada y no hay estado intermedio.
- Publicar dos veces la misma versión da `VERSION_ALREADY_PUBLISHED` (409), no
  un 500; después de publicar la v2 se puede publicar la v3 sin tocar nada.
- `lastDraftVersion` queda en `null` al publicar: el editor deja de reanudar un
  borrador que ya es inmutable.
- El panel sigue desactivando el botón cuando `validateCourseVersion` encuentra
  problemas (comodidad), pero ese desactivado ya **no es la garantía**.
- La comprobación contra Firestore real sigue sin ejecutarse (sin emulador y sin
  credenciales). Lo que sí está probado es que el código de la transacción
  archiva la anterior y mueve el puntero (`tests/server/publish-gate.test.ts`,
  comprobación sobre la fuente), y que demo y dobles se comportan igual
  (ejecutado). El bloqueo de B09 sigue declarado.

## ADR-028 · Una cuenta se deshabilita, no se borra; y deshabilitar cierra la sesión

**Contexto.** Desde el principio existen en el dominio tres piezas que **ninguna
operación usaba**: la tabla de transiciones de estado
(`assertCanTransitionStatus`), la protección del último administrador
(`assertCanRemoveAdmin`) y las claims con `claimsVersion`. En la interfaz solo se
podía leer la lista de cuentas. En la práctica: un código de activación caducado
no se podía reemitir (la persona quedaba fuera del sistema para siempre), una
baja del servicio no se podía reflejar y una cuenta comprometida no se podía
cerrar sin tocar la consola de Firebase.

**Decisión.**

1. **Deshabilitar, nunca borrar.** Borrar destruiría progreso, intentos e
   histórico y dejaría el nombre de usuario reservado sin dueño. Deshabilitar es
   reversible y conserva la trazabilidad.
2. **Cerrar la puerta por los tres lados.** En una sola operación: `status =
   disabled`, `claimsVersion + 1` (en la **misma** escritura, para que nadie lea
   estado nuevo con versión vieja), claims nuevas y revocación de los refresh
   tokens de Firebase Auth. La sesión abierta muere en la siguiente petición
   porque el servidor relee la ficha.
3. **Los códigos pendientes se anulan al deshabilitar.** Si no, el código que
   alguien guardó podría reactivar la cuenta por la puerta de atrás y saltarse la
   decisión de administración.
4. **Reemitir solo para `pending_activation`**, y siempre revocando antes de
   emitir: así nunca hay dos códigos vivos. Un código nuevo **no** activa ni
   reactiva: reactivar es otra operación explícita.
5. **El código se muestra una sola vez, fuera de la URL.** Se devuelve en el
   resultado de la acción de servidor; no queda en el historial del navegador, en
   `Referer` ni en los registros. En la base solo se guarda su hash y la
   auditoría registra la emisión sin el secreto.
6. **El último administrador activo no se puede deshabilitar**, ni por otro
   administrador ni por sí mismo. Es la única operación que dejaría el sistema
   sin acceso y sin forma de arreglarlo desde la aplicación.
7. **Sin límites nuevos inventados.** No se añade caducidad a la cuenta ni
   borrado automático: no hay TTL en Spark (ADR-025) y no hay requisito de
   producto que lo pida.

**Consecuencias.**

- El panel tiene una sección **Personas** con lista filtrable, ficha con
  matrículas, progreso e intentos, y las tres operaciones.
- Las cuentas deshabilitadas siguen apareciendo en la lista (con su estado), no
  desaparecen: lo que no se puede es entrar ni recibir documentos.
- Reemitir un código no cambia el estado: si la cuenta estaba pendiente, sigue
  pendiente hasta que la persona active con su contraseña.
- Todo queda en `audits` con `targetUid`, `claimsVersion` resultante y, al
  deshabilitar, el motivo (máximo 200 caracteres).
- El portón contra la escalada de privilegios no cambia: por aquí **no** se
  cambia el rol ni se crean administradores (ADR-013 sigue vigente).
- Lo que no se ha podido verificar: que Firebase Auth revoque de verdad y que las
  claims se propaguen. La batería usa dobles y la demostración; el bloqueo de B09
  (reglas y emulador) sigue declarado.
