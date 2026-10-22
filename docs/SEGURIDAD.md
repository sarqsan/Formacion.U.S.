# Seguridad

Este documento separa con cuidado **lo que está comprobado por pruebas**, lo
que está implementado pero **no ejecutado** contra Firebase, y lo que
**todavía no está resuelto**. No se afirma que algo esté protegido si no hay
una prueba o una configuración verificable detrás.

## 1. Modelo de amenazas (resumen)

| # | Amenaza | Control | ¿Probado? |
| --- | --- | --- | --- |
| T1 | Alta no autorizada (registro público) | No existe interfaz de registro; la cuenta solo nace de una importación de admin o del script de arranque | Sí (flujo) / parcial (ver §5.2) |
| T2 | Importación por quien no es admin | `assertAdmin` en servicio y `requireActor` en endpoint | Sí |
| T3 | Escalada de privilegios vía Excel | El servicio fija `role: "learner"` y `status: "pending_activation"`; ignora usuarios propuestos por el cliente | Sí |
| T4 | Suplantación en la activación | Token de 256 bits, hash en BD, un solo uso, caducidad, ligado al `uid` y al `username` | Sí |
| T5 | Alteración del progreso | Escritura desde cliente prohibida en reglas; recálculo en servidor; auditoría automática comprueba que no hay escrituras de Firestore en el código de navegador | Sí (dominio, servicio y auditoría) / reglas sin ejecutar |
| T6 | Autoinflado de resultados | El cliente envía opciones; `gradeAttempt` corrige contra la clave del servidor; `passed` nunca viene del cliente | Sí |
| T7 | Fuga de respuestas correctas | `toClientQuiz` elimina `correctOptionIds`; `answerKeys` con `allow read: false` | Sí (dominio) / reglas sin emular |
| T8 | PDF público permanente | No hay Storage ni URL: fragmentos solo-servidor y lectura por páginas con sesión, matrícula y orden | Sí (dominio y rutas) / reglas sin emular |
| T9 | Path traversal en Storage | `isSafeStoragePath` + `assertPathWithinTopic` | Sí |
| T10 | Alteración de rol/estado | `role`/`status`/`claimsVersion` solo con Admin SDK; reglas `write: false`; `isAdmin()` exige rol admin en la ficha y en el token | Sí (dominio y auditoría estática) / reglas sin ejecutar |
| T11 | Sesión robada persiste tras deshabilitar | Triple barrera: (1) `resolveSession` compara ficha y token en servidor; (2) las **reglas** consultan la ficha con `get()`, no solo las claims; (3) sesión `checkRevoked`. Política probada con 16 pruebas; reglas **sin ejecutar** | Parcial: lógica sí, reglas no |
| T12 | CSRF en endpoints que escriben | Cookie `SameSite=Lax` + `Origin`/`Referer` obligatorio | Sí (origen) |
| T13 | Fuerza bruta contra la activación | Token de 256 bits (no adivinable) | Sí (entropía) |
| T14 | Bombas de descompresión / Excel gigante | Límite de 2 MB antes de descomprimir; 2000 filas | Sí |
| T15 | Fuga de secretos en el repositorio | `.env*` ignorado; sin claves en código; `.env.example` sin valores | Revisado |
| T16 | Duplicar cuentas de una persona real | Duplicados exigen decisión; "ya existe" no se puede incluir | Sí |
| T17 | Dejar el sistema sin administradores | Protección del último admin activo | Sí |

| T18 | Subida de PDF sin permiso | `assertAdmin` en el servicio, sesión de portal en la ruta y origen verificado; la versión debe ser `draft` | Sí |
| T19 | Ocupar la cuota con subidas falsas | La reserva se hace **en la misma transacción** que el registro, hay límite por usuario y hora (20/h) y la cancelación libera la reserva | Sí (dominio y demo) / transacción real sin emulador |
| T20 | Colar un fichero que no es un PDF | La parte 0 debe empezar por `%PDF-`; se comprueban tamaño declarado, tamaño por parte, número de partes y SHA-256 global antes de activar | Sí |
| T21 | Servir o publicar un documento incompleto | `getMeta` oculta `aborted`; la lectura y la asociación exigen `state === "active"` | Sí |
| T22 | Elegir el id de un documento ajeno | El id lo calcula el servidor a partir del contenido y del destino; el cuerpo con `documentId` u otros campos extra se rechaza (`strictObject`) | Sí |
| T23 | Sustituir un PDF ya publicado | Un `active` es inmutable: no acepta más partes y la cancelación se rechaza (`UPLOAD_ALREADY_ACTIVE`); sustituir es un activo nuevo | Sí |

## 2. Autenticación y sesión

- **Firebase Authentication real.** No se simula ninguna sesión: no se usa
  `localStorage` ni una cookie de conveniencia. El cliente usa el SDK oficial
  con `inMemoryPersistence` y el servidor emite una cookie de sesión httpOnly.
- La cookie se valida con `verifySessionCookie(cookie, true)`: firma, emisor,
  audiencia, caducidad y revocación.
- Además de la firma, el servidor **relee el documento de cuenta**: si el
  usuario está `disabled` o la `claimsVersion` no coincide con el token, la
  sesión se considera inválida aunque el token siga vigente.
- El `middleware.ts` solo evita renderizar páginas a quien no tiene cookie. No
  es autorización: una cookie inventada pasa el middleware y es rechazada por
  `getActor()`.

## 2.b Sesión: la base de datos manda (fase 2)

Se ha endurecido el control de sesión tras la revisión de reglas. Antes, tanto
el servidor como las reglas se apoyaban sobre todo en las Custom Claims, que
son una **foto fija** del momento de emisión: un token sigue diciendo
`status: active` hasta una hora después de deshabilitar la cuenta.

Ahora hay dos comprobaciones basadas en la ficha actual (`accounts/{uid}`):

1. **Servidor** — `resolveSession` (dominio puro) rechaza la sesión si la ficha
   no está activa, si `claimsVersion` no coincide, si el rol del token difiere
   del almacenado o si no existe ficha. Cubierto por 16 pruebas ejecutadas.
2. **Reglas de Firestore** — `isActive()` e `isAdmin()` hacen `get()` de la
   ficha y exigen coincidencia de estado, rol y `claimsVersion`.

Las 44 pruebas de reglas que verifican esto están escritas pero **no se han
podido ejecutar** (sin JVM no hay emulador; ver `PRUEBAS.md` §8). Hasta que se
ejecuten, la barrera 2 está implementada pero **no verificada**.

## 3. Contraseñas

- No se guardan en claro ni se incluyen en el Excel.
- Las cuentas se crean con una contraseña aleatoria de 48 bytes que **nunca se
  entrega a nadie**: la cuenta es inutilizable hasta la activación.
- La contraseña personal se fija en la activación mediante Admin SDK; Firebase
  la almacena con scrypt.
- Política: ≥12 y ≤128 caracteres, mayúscula, minúscula, número, sin espacios
  al principio/final, sin contener el nombre de usuario, sin reutilizar.
- La contraseña viaja una vez por HTTPS al servidor y **no** se registra en
  logs ni en la base de datos.

## 4. Tokens de activación

- 32 bytes de `crypto.randomBytes` → base64url (43 caracteres).
- En BD: solo `sha256(token)`; comparación con `timingSafeEqual`.
- 72 horas de validez, un solo uso (transacción), revocables.
- Un token no sirve para otra cuenta ni con otro `username`.
- Los mensajes de error no permiten distinguir token inexistente de token de
  otra cuenta (evita enumeración).
- El administrador los ve **una sola vez** al confirmar la importación; no se
  guardan en claro ni se envían por correo desde el sistema.

## 5. Riesgos abiertos (honestos)

### 5.1 (cerrado en fase 4) Ya no hay URL firmada ni bucket
Con el plan Spark no existe Cloud Storage, así que el riesgo de "URL firmada =
permiso temporal de portador" **desaparece**: no hay ninguna URL que compartir.
En su lugar, el binario se sirve por páginas desde `/api/documents/{id}/pages`
con `Cache-Control: no-store` (≤ 20 páginas y ≤ 768 KiB por petición) y, desde el
bloque 07, **también entero** en `GET /api/documents/{id}/file` para que el
navegador lo abra con su visor nativo. Lo segundo es una decisión expresa de ese
bloque (experiencia Android sin `pdf.js`), no un descuido: ver 5.3 quater.

Lo que queda es un control de aplicación, no DRM (ver 5.3): un alumno **con
matrícula activa** en ese curso puede descargar las páginas del PDF que está
leyendo, en orden y con límite de peticiones. Sin matrícula no hay acceso,
aunque el curso esté publicado.

### 5.2 Registro en Firebase Authentication
Firebase Auth (proveedor email/password) permite crear cuentas vía API si el
proyecto lo consiente. Como el correo es sintético y nuestro servidor exige
documento de cuenta + claims, una cuenta creada así **no puede entrar** en la
aplicación (sin `accounts/{uid}` no hay sesión válida y las reglas deniegan).
Pero podría ocupar un correo (`rol1.garcia@…`) y bloquear esa importación.

**Acción pendiente al conectar Firebase (requiere autorización):** desactivar
el alta de nuevos usuarios (Identity Platform → "Allow new user sign-ups") y/o
añadir una *blocking function* `beforeUserCreated` que rechace cualquier alta
que no provenga del servidor.

### 5.3 Lectura secuencial: control de aplicación, no DRM
El servidor impide avanzar páginas fuera de orden y no desbloquea el
cuestionario hasta completar la lectura. Aun así, quien tenga matrícula y
permiso puede guardar las páginas que va recibiendo (o automatizar las
peticiones en orden y dentro de los límites) y reconstruir el PDF. Los límites
por usuario y globales encarecen el abuso y protegen la cuota gratuita, no son
DRM. No se ha implementado marca de agua ni cifrado; si se exige, es un bloque
aparte (marca de agua por usuario, PDF cifrado).

### 5.3 ter Subida de PDF: límites conocidos

Lo que la subida por partes **no** resuelve, dicho sin adornos:

- **No hay análisis antivirus.** El servidor comprueba que el fichero es un PDF
  (cabecera, tamaños, SHA-256) pero no que su contenido sea inocuo. Un PDF con
  código incrustado es un PDF válido. El alumnado lo descarga por páginas y lo
  abre con su lector: la mitigación real es que solo se aceptan ficheros de
  administradores y que el visor es un bloque posterior.
- **El número de páginas es una declaración**, no una comprobación. Si el
  administrador se equivoca, el control de lectura usará un número incorrecto.
  La interfaz lo exige de forma expresa y el modelo de datos lo guarda tal cual.
- **Sin TTL**: Firestore solo ofrece TTL en Blaze. Una subida pendiente que se
  abandona ocupa su reserva hasta que alguien la cancela desde el editor. Es
  visible (aparece como «subida pendiente») y cancelable, pero no caduca sola.
- **La atomicidad de la reserva está probada en dobles y en la demo, no en
  Firestore real**: sin JVM no hay emulador y no se ha ejecutado. La
  implementación usa transacciones con lectura previa del contador, que es el
  patrón documentado, pero **no está verificado aquí**.
- **El límite de cuerpo de las funciones desplegadas no se puede verificar desde
  el repositorio.** Por eso la interfaz usa partes de 768 KiB: el margen frente a
  los ~4,5 MB documentados por Vercel en el plan Hobby es amplio, pero es una
  precaución, no una medición hecha en producción.
- **Un `pending` no se sirve a nadie**: ni al alumnado, ni al administrador por
  la API de lectura. Para inspeccionarlo hay que finalizarlo o cancelarlo.

### 5.3 quater Lectura del PDF completo: qué se comprueba y qué no

`GET /api/documents/{id}/file` entrega el fichero entero para que lo abra la
aplicación de PDF del dispositivo. Antes de enviar un byte, el servidor
comprueba, en este orden y sin fiarse de nada del cliente:

1. cuenta **activa** (una cookie no basta; `status` sale de la base de datos);
2. forma del identificador (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, sin `..`):
   así el id no puede convertirse en una ruta ni en una consulta;
3. documento **existente y `active`**: ni `pending`, ni `aborted`, ni
   `archived`, ni con partes incompletas;
4. curso con **versión publicada** (no vale «el fichero existe»);
5. **matrícula activa** del actor en ese curso;
6. el documento está **referenciado expresamente** en la definición de esa
   versión publicada: un PDF de un borrador o de una versión antigua no se
   entrega aunque su id sea correcto y sus bytes sigan en el almacén;
7. las partes cubren el tamaño declarado (`bytes`) y el **SHA-256 global**
   coincide con el que se verificó al activar el documento.

Denegaciones y respuestas: los casos «no existe», «no está en la versión
publicada» y «documento no servible» devuelven **el mismo 404**
(`DOCUMENT_NOT_FOUND`), para no revelar qué documentos hay en borradores ni en
versiones antiguas; sin matrícula, **403** (`COURSE_NOT_AUTHORIZED`); cuenta no
activa, **403**; integridad rota (parte ausente, tamaño, firma o SHA-256), **409**
(`DOCUMENT_CORRUPTED`), sin devolver un PDF aparentemente válido. Ningún error
incluye rutas del almacén, claves de respuesta ni datos de otros documentos.

Cabeceras de la respuesta correcta: `Content-Type: application/pdf`,
`Content-Disposition: inline; filename="…"` con un nombre ASCII derivado del
título (nunca la ruta interna), `Cache-Control: no-store, max-age=0, private`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` y
`Content-Length`. No hay caché compartida: la respuesta es privada por
`Cache-Control` y `private`, y el proxy de sesión no la almacena.

**Lo que esto no es:**

- **No es un antivirus.** El SHA-256 demuestra que los bytes son los que se
  subieron y que no se han alterado en el almacén, **no** que el PDF sea inocuo.
  Un PDF con código incrustado puede tener el hash correcto. La mitigación sigue
  siendo que solo administración sube ficheros y que el alumnado abre el PDF con
  el lector del sistema (con su propio aislamiento), no con código de la
  aplicación.
- **No evita que quien tiene matrícula guarde el fichero.** Entregar el PDF
  completo implica exactamente eso: una persona autorizada puede guardarlo. El
  control es de acceso (quién), no de uso (qué hace después). El límite por
  usuario y el global encarecen la descarga masiva, no la impiden.
- **No demuestra nada contra Firestore real.** La batería se ejecuta con dobles y
  con la demostración; el emulador sigue sin JVM. Que las reglas cierren
  `pdfChunks` a todo cliente es una afirmación del fichero de reglas, **no** una
  prueba ejecutada.
- **La versión antigua no se sirve aunque sea pública en su momento**: solo vale
  la versión publicada vigente del curso. Es lo que evita que un enlace guardado
  siga dando acceso a material retirado.

### 5.3 bis Copias de seguridad: cifradas, pero sin instantánea global

Las copias (`npm run backup:export`) se cifran con AES-256-GCM y una clave
derivada con scrypt de una contraseña que no se guarda en el archivo. Contienen
datos personales y **claves de corrección**, así que se tratan como material
sensible: fuera del repositorio (`.gitignore` excluye `*.fbak` y `/backups/`),
con la contraseña y el SHA-256 del archivo guardados por separado.

Límites que hay que tener presentes: no hay instantánea global (el recorrido no
es una transacción), no incluye usuarios de Firebase Authentication y la
restauración escribe por lotes (un fallo a mitad deja estado parcial). Ver
`docs/INFORME-FASE-7.md` §3.5.

### 5.3 quinquies Ciclo de vida de la cuenta: deshabilitar cierra de verdad

Hasta el bloque 09 una cuenta solo cambiaba de estado al activarse. Ahora
administración puede **deshabilitarla**, **reactivarla** y **reemitir su código
de activación**, con estas garantías:

| Operación | Qué se comprueba en el servidor | Efecto |
| --- | --- | --- |
| Deshabilitar | rol admin · la cuenta existe · transición válida (`pending_activation`/`active` → `disabled`) · no es el último administrador activo | `status = disabled`, `claimsVersion + 1`, claims nuevas, **revocación de refresh tokens**, códigos pendientes anulados, auditoría con el motivo |
| Reactivar | rol admin · la cuenta existe · solo `disabled → active` | `status = active`, `claimsVersion + 1`, claims nuevas, revocación de refresh tokens, auditoría |
| Reemitir código | rol admin · la cuenta existe · solo `pending_activation` | los códigos vivos se revocan **antes** de emitir; el nuevo se guarda **solo como hash** (72 h), se muestra una vez y la auditoría no lo contiene |

Por qué importa el orden y qué se evita:

- **`claimsVersion` sube en la misma escritura que el estado.** Si fueran dos
  escrituras, una petición podría leer el estado nuevo con la versión vieja y
  aceptar un token que debería estar muerto.
- **La sesión muere en la siguiente petición**, no cuando caduque la cookie: el
  servidor relee `accounts/{uid}` en cada petición y exige `status === "active"`
  y `claimsVersion` coincidente.
- **Reemitir no activa ni reactiva.** Un código nuevo solo sirve para una cuenta
  `pending_activation`; reactivar es otra operación explícita. Así la reemisión
  no se convierte en una forma de saltarse la contraseña ni la decisión de
  deshabilitar.
- **Deshabilitar no borra**: progreso, intentos e histórico se conservan. La
  alternativa (borrar la cuenta) destruiría la trazabilidad y además dejaría el
  nombre de usuario reservado sin dueño.
- **El último administrador activo no se puede deshabilitar** (409 `LAST_ADMIN`),
  tampoco uno mismo: sin consola, quedaría un sistema irreversible.
- **El código no viaja en la URL**: se devuelve en el resultado de la acción de
  servidor, así que no queda en el historial del navegador, en `Referer` ni en
  los registros de acceso. La auditoría guarda que se emitió, con su caducidad,
  nunca el secreto.

Lo que **no** está demostrado: que Firebase Auth revoque de verdad los refresh
tokens ni que las claims nuevas invaliden los tokens ya emitidos. Eso exige el
proyecto real; el emulador sigue bloqueado (sin JVM). En la demostración la
propiedad que sí se prueba es la que depende del servidor: cada petición relee
la ficha y una cuenta deshabilitada deja de entrar.

### 5.4 Sin límite de intentos propio
La activación está protegida por entropía del token, pero no hay *rate limit*
en `/api/activate`. Firebase limita intentos de login, no de activación.
Pendiente: limitar por IP y por usuario (p. ej. 10/hora) y registrar intentos.

### 5.5 Sin MFA
No hay segundo factor. La sensibilidad actual (formación interna) no lo exige,
pero un administrador con MFA sería recomendable cuando haya contenido
reservado.

### 5.6 Dependencias con avisos
`npm audit` reporta avisos en dependencias transitivas de `firebase`
(`@grpc/grpc-js`) y del *linter* (`braces`). Detalle y análisis en
[`PRUEBAS.md`](PRUEBAS.md). Nuestro código no importa Firestore desde el
navegador; se revaluará al conectar Firebase.

### 5.7b Reglas sin ejecutar (riesgo de la fase 2)
`firestore.rules` y `storage.rules` se han revisado y endurecido, pero **no se
han podido compilar ni ejecutar** en este entorno: el emulador requiere Java y
la descarga está bloqueada. Consecuencias a asumir hasta que se ejecuten:

- podría haber un error de sintaxis que solo se detectaría al desplegar;
- no hay evidencia empírica de que las reglas permitan/denieguen lo previsto.

Mitigación aplicada: el código de la aplicación **no lee Firestore desde el
navegador** (todo pasa por el servidor con Admin SDK, que no está sujeto a
reglas), así que un fallo en las reglas no rompe la app ni abre el acceso vía
servidor; pero sí podría dejar datos expuestos a un cliente manipulado.
Primera acción pendiente: `npm run test:rules` en un entorno con JDK 11+ y el jar
del emulador. Revisión completa de la fase 1 de Firebase en §5.9.

### 5.7c (cerrado en el bloque 03) Metadatos de documentos visibles para el cliente
La regla de `documents` permitía leer metadatos a cualquier cuenta activa
matriculada en el curso. Con el ciclo de vida de cursos eso alcanzaba también a
los documentos de **borradores**: quien conociera un identificador veía título y
páginas de material no publicado.

Cerrado por diseño, no por filtro: `documents` pasa a solo-servidor
(`allow read, write: if false`) y sale de `CLIENT_READABLE_COLLECTIONS`. La
aplicación nunca leyó Firestore desde el navegador, así que la regla no daba
ninguna funcionalidad; solo superficie. Queda pendiente **desplegar** las reglas
y ejecutar `npm run test:rules` en un entorno con JDK: desde aquí no se han
publicado ni verificado (ver 5.6).

### 5.8 Cuota de almacenamiento (nuevo en fase 4)
Los PDF comparten la cuota de 1 GiB de Firestore con el resto de la base de
datos. El presupuesto por defecto (512 MiB) y la reserva de 128 MiB evitan
llenarla, pero **si se agota el presupuesto, las subidas fallan con 507** en
lugar de aceptar datos a medias. La contrapartida: el sistema depende de una
cuota gratuita que Google puede cambiar; `db:check` avisa al 90 % de uso.

### 5.9 Reglas de seguridad revisadas contra los servicios (fase 1 de Firebase)

Revisión hecha el 22/10/2026 sobre las reglas de `firestore.rules` contrastadas
con el código que de verdad escribe y lee cada colección. **Nada se ha publicado
en Firebase**: ni reglas, ni índices, ni datos.

**Punto de partida que conviene no olvidar:** la aplicación **no lee Firestore
desde el navegador**. El SDK de cliente solo se usa para autenticarse
(`src/lib/firebase/client.ts` usa `firebase/auth`); todas las lecturas y
escrituras de datos pasan por el servidor con el Admin SDK, que no está sujeto a
reglas. Por tanto:

- un fallo en las reglas **no** rompe la aplicación;
- pero sí podría dejar datos expuestos a quien consiga un ID token válido
  (usuario y contraseña) y llame a Firestore directamente desde la consola;
- la autorización real de negocio vive en los servicios (`assertCourseAccess`,
  `assertCanReadProgress`, `assertAdmin`…), no en las reglas.

#### Qué colección, quién la lee y con qué respaldo

| Colección | Lectura de cliente permitida | Quién la escribe | Respaldo en el servidor |
| --- | --- | --- | --- |
| `accounts` | la propia, o todas si administración | solo servidor (`repositories.ts`, `account-admin-store.ts`) | `resolveSession` + `assertActiveAccount`; estado y `claimsVersion` mandan |
| `usernames`, `activationTokens` | nadie | solo servidor | el código de activación viaja una vez y en la base solo queda su hash |
| `audits` | administración | solo servidor | la auditoría se escribe tras cada operación y nunca con secretos |
| `courses` | cuenta activa + `publishedVersion != null` | solo servidor | publicar exige `assertPublishable` y PDFs completos (ADR-027) |
| `courses/{id}/versions` | matrícula activa **y** versión publicada | solo servidor | `assertCourseAccess` en cada lectura de contenido |
| `enrollments` | la propia, o todas si administración | solo servidor | `assertCourseAccess`: sin matrícula activa no hay contenido |
| `answerKeys` | **nadie** (ni administración) | solo servidor | la corrección ocurre en servidor; el cliente nunca recibe claves |
| `progress` | la propia, o todas si administración | solo servidor | la corrección y el desbloqueo del examen se calculan en servidor |
| `progressHistory` | la propia, o todas si administración | solo servidor | `assertCanReadProgress` (B10); se lee con Admin SDK |
| `attempts` | administración | solo servidor | registro inmutable de qué se contestó y cómo se corrigió |
| `documents`, `pdfChunks` | **nadie** | solo servidor | el binario se sirve por `/api/documents/{id}/file` tras comprobar cuenta, matrícula, publicación y SHA-256 |
| `meta` | nadie | solo servidor | contador de cuota y versión de esquema |
| cualquier otra ruta | **nadie** | — | comodín final `allow read, write: if false` |

Reglas transversales: ninguna regla permite escribir desde el cliente (todas las
de escritura son `if false`); `isActive()` cruza tres fuentes (claim de estado,
ficha de cuenta y `claimsVersion`) para que una cuenta deshabilitada o degradada
pierda el acceso **antes** de que caduque su token; `isAdmin()` exige el rol en
el token **y** en la ficha; y `get()` de una cuenta inexistente hace fallar la
evaluación, de modo que una identidad de Authentication sin alta no accede.

#### Defectos encontrados y corregidos en esta revisión

1. **`progressHistory.archivedAt` se escribía con dos tipos distintos.**
   `commitAttempt` guardaba una cadena ISO y `saveProgress` un
   `serverTimestamp()`, así que la misma colección mezclaba `string` y
   `Timestamp` según el camino. La lectura lo toleraba (`toIsoString`), pero
   cualquier consumidor futuro —copias de seguridad, consultas, índices— habría
   tenido que adivinar. Ahora ambos caminos escriben ISO y
   `validateProgressHistoryDocument` lo impone en la escritura (el lector sigue
   aceptando lo antiguo).
2. **`db:check` ejecutaba una consulta que ningún código hace**
   (`accounts` con `status` + `orderBy(createdAt)`) sin índice declarado: en el
   proyecto real habría salido `MISSING_INDEXES` y habría empujado a desplegar un
   índice especulativo. Se ha retirado y en su lugar se comprueba la consulta
   real del histórico (`progressHistory` por `uid`, `limit(200)`, sin `orderBy`),
   que **no** necesita índice compuesto.
3. **No había ninguna prueba de reglas sobre `progressHistory`**, aunque desde
   B10 la aplicación ya lee esa colección (por el servidor). Añadidas 16 pruebas
   (ver `PRUEBAS.md` §23).

#### «Sin registro público»

La aplicación no expone ningún formulario de alta: la única llamada de cliente es
`signInWithEmailAndPassword`. Pero Firebase Authentication **sí permite** crear
cuentas con la clave pública del proyecto si alguien llama al SDK por su cuenta.
La defensa no es la interfaz, es la ficha: un usuario así no tiene documento en
`accounts/{uid}`, `account()` provoca un error de evaluación y la regla deniega
todo (fallar cerrado). Hay dos pruebas para ello: una cuenta de Authentication
sin alta no lee nada, y ni siquiera un token con `role: "admin"` abre la
auditoría si no existe su ficha.

Lo que **no** se puede hacer desde las reglas y queda pendiente en consola:
desactivar los proveedores que no se usan, activar la protección de enumeración
de correo y revisar quién puede crear cuentas. Nada de esto se ha tocado.

#### Qué está verificado y qué no

| Afirmación | Cómo se ha comprobado | Estado |
| --- | --- | --- |
| Ninguna regla permite escritura de cliente | 22 comprobaciones estáticas sobre el texto de `firestore.rules`, en `npm test` | **verificado** |
| Toda colección legible exige cuenta activa o administración | ídem | **verificado** |
| `answerKeys`, `documents`, `pdfChunks`, `meta`, `usernames` y `activationTokens` están cerradas | ídem | **verificado** |
| El histórico y el progreso comparan `resource.data.uid` | ídem | **verificado** |
| Las reglas **compilan** y el motor permite/deniega lo previsto | `npm run test:rules` (57 casos) | **BLOQUEADO**: el jar del emulador no se puede descargar (Java ya se resuelve con `jdk4py`; ver `ENTORNO-PRUEBAS.md` §2 bis) |
| Las consultas reales no exigen índices nuevos | `npm run db:check` contra el proyecto real | **BLOQUEADO**: sin credenciales y con TLS a Google cortado |
| `progressHistory` devuelve `archivedAt` normalizado desde Firestore | prueba de integración escrita (5 casos) | **BLOQUEADO**: requiere emulador |

Las 22 comprobaciones estáticas **no** son una prueba del motor de reglas: leen
el fichero y verifican que sigue diciendo lo que el diseño exige. Sirven para
detectar que alguien afloje una regla sin darse cuenta, no para afirmar que
Firestore acepta o rechaza una petición concreta.

### 5.7 Sin revisión externa
No hay auditoría de seguridad externa ni pruebas de penetración. Las pruebas
automáticas cubren reglas de negocio, no la infraestructura.

## 6. Buenas prácticas aplicadas en el repositorio

- Sin secretos: `.env*` ignorado, `.env.example` vacío.
- Sin datos personales reales ni PDF confidenciales.
- Cabeceras `nosniff`, `DENY` (iframe) y `Referrer-Policy` en todas las rutas.
- `Cache-Control: no-store` en respuestas de API.
- Errores internos nunca se devuelven al cliente con stack ni mensajes de
  Firebase.
- Los endpoints que escriben exigen `Content-Type` correcto y límites de
  tamaño.
- La importación es transaccional con *rollback*: no deja cuentas a medias.
