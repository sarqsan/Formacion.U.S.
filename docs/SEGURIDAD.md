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
| T8 | PDF público permanente | Bucket sin acceso cliente; URLs firmadas de 300 s; rutas validadas | Sí (rutas) / firma sin ejecutar |
| T9 | Path traversal en Storage | `isSafeStoragePath` + `assertPathWithinTopic` | Sí |
| T10 | Alteración de rol/estado | `role`/`status`/`claimsVersion` solo con Admin SDK; reglas `write: false`; `isAdmin()` exige rol admin en la ficha y en el token | Sí (dominio y auditoría estática) / reglas sin ejecutar |
| T11 | Sesión robada persiste tras deshabilitar | Triple barrera: (1) `resolveSession` compara ficha y token en servidor; (2) las **reglas** consultan la ficha con `get()`, no solo las claims; (3) sesión `checkRevoked`. Política probada con 16 pruebas; reglas **sin ejecutar** | Parcial: lógica sí, reglas no |
| T12 | CSRF en endpoints que escriben | Cookie `SameSite=Lax` + `Origin`/`Referer` obligatorio | Sí (origen) |
| T13 | Fuerza bruta contra la activación | Token de 256 bits (no adivinable) | Sí (entropía) |
| T14 | Bombas de descompresión / Excel gigante | Límite de 2 MB antes de descomprimir; 2000 filas | Sí |
| T15 | Fuga de secretos en el repositorio | `.env*` ignorado; sin claves en código; `.env.example` sin valores | Revisado |
| T16 | Duplicar cuentas de una persona real | Duplicados exigen decisión; "ya existe" no se puede incluir | Sí |
| T17 | Dejar el sistema sin administradores | Protección del último admin activo | Sí |

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
con `Cache-Control: no-store` (≤ 20 páginas y ≤ 768 KiB por petición), y el
cliente nunca recibe el fichero completo de una sola respuesta.

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
Primera acción pendiente: `npm run test:rules` en un entorno con JDK 11+.

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
