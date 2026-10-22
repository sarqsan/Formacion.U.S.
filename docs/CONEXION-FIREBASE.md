# Conexión con Firebase — guía de configuración

Proyecto: **`formacionus-63555`** · Firestore nativo, base `(default)`, `europe-southwest1`
Plan: **Spark (gratuito)**. Nada de esta guía activa facturación.

> Esta guía distingue siempre dos cosas:
> **[MANUAL]** lo que solo se puede hacer en Firebase Console, y
> **[YA IMPLEMENTADO]** lo que ya está en el código y no hay que tocar.
>
> El estado real de la conexión se consulta con `npm run check:firebase`.
> Mientras no haya credenciales, esa comprobación devuelve **FAILED (exit 2)** y
> la aplicación **no afirma** estar conectada.

---

## 1. Variables de entorno: nombres exactos y para qué sirve cada una

Copiar `.env.example` a `.env.local` (ignorado por git) y rellenar solo los
valores que genera Firebase.

### Servidor (secretas — nunca al repositorio)

| Variable | Qué es | Dónde se obtiene |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | ID del proyecto | `formacionus-63555` |
| `FIREBASE_CLIENT_EMAIL` | correo de la cuenta de servicio | JSON de la clave privada (`client_email`) |
| `FIREBASE_PRIVATE_KEY` | clave privada RSA en PEM | JSON de la clave privada (`private_key`) |

### Cliente (públicas — van en el bundle, no son secreto)

| Variable | Qué es | Dónde se obtiene |
| --- | --- | --- |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | `apiKey` de la app web | Configuración del SDK |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `authDomain` (`formacionus-63555.firebaseapp.com`) | Configuración del SDK |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `projectId` | Configuración del SDK |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | `appId` | Configuración del SDK |
| `NEXT_PUBLIC_AUTH_EMAIL_DOMAIN` | dominio de los correos internos | `formacion.invalid` (el mismo que `AUTH_EMAIL_DOMAIN`) |

### Servidor (no las genera Firebase; se fijan a mano)

| Variable | Valor local | Valor en producción | Para qué |
| --- | --- | --- | --- |
| `AUTH_EMAIL_DOMAIN` | `formacion.invalid` | igual | dominio de los correos internos que crea la importación |
| `APP_ORIGIN` | `http://localhost:3000` | `https://tu-dominio` | comprobación de origen (CSRF). **Obligatoria en producción**, solo https |
| `SESSION_COOKIE_NAME` | `formacion_session` | `__Host-formacion_session` | cookie de sesión. **En producción debe empezar por `__Host-`** |
| `SESSION_TTL_HOURS` | `12` | `12` | duración de la cookie (1–336 h) |
| `PDF_STORAGE_BUDGET_MB` | `512` | `512` | presupuesto de PDF en Firestore |
| `DEMO_MODE` | vacío | vacío | `1` = demostración en memoria, **nunca** junto con credenciales reales |

Regla de oro: `AUTH_EMAIL_DOMAIN` y `NEXT_PUBLIC_AUTH_EMAIL_DOMAIN` deben
coincidir. Si no coinciden, las cuentas se crean con un correo y se intenta
entrar con otro: `npm run check:firebase` lo detecta como **FAILED**.

---

## 2. Pasos en Firebase Console

### Paso 1 — Proyecto y Firestore **[HECHO / A VERIFICAR]**

El proyecto **ya existe** y su identificador real está confirmado:

> **ID del proyecto: `formacionus-63555`**.

Ese valor está ya en el código: `.firebaserc`, `FIREBASE_PROJECT_ID` y
`NEXT_PUBLIC_FIREBASE_PROJECT_ID` de `.env.example`, y `EXPECTED_PROJECT` del
diagnóstico. No hay que crear ningún proyecto, y **no se toca** el de la
aplicación de cuadrantes.

1. Abrir <https://console.firebase.google.com/project/formacionus-63555> y
   comprobar que el **ID del proyecto** de *Configuración del proyecto →
   General* es exactamente `formacionus-63555`.
2. **Compilación → Firestore Database**: si ya existe, comprobar que es
   **nativo** y que la ubicación es `europe-southwest1` (Madrid). Si todavía no
   existe, **crear la base de datos**.
   - Modo: **Nativo**.
   - Ubicación: **europe-southwest1 (Madrid)**.
   - Reglas iniciales: **modo de producción** (se sustituirán después, solo
     tras validarlas).
3. Base de datos: dejar `(default)` (no crear una con nombre propio).

### Paso 2 — Authentication **[MANUAL]**

1. Menú **Compilación → Authentication** → **Comenzar**.
2. Pestaña **Sign-in method** → **Correo electrónico/contraseña** →
   **Habilitar** → Guardar. Solo ese proveedor.
3. Pestaña **Settings → Dominios autorizados**: `localhost` ya figura; añadir
   el dominio real cuando se despliegue (por ejemplo `formacion.tudominio.es`).

### Paso 3 — Aplicación web «formacion-web» **[MANUAL]**

El SDK de JavaScript (el del navegador, `src/lib/firebase/client.ts`) pertenece
a una **app web** registrada dentro del proyecto. Sin ese registro no existen
`apiKey` ni `appId` y el inicio de sesión no puede funcionar.

**Si la app web todavía no existe:**

1. <https://console.firebase.google.com/project/formacionus-63555/settings/general>
2. Bajar hasta **Tus apps** → botón **Web** (`</>`).
3. Apodo: `formacion-web` (importante: no marcar *Configurar también Firebase
   Hosting*; este proyecto **no** usa Hosting).
4. **Registrar app**. La consola enseña el bloque `firebaseConfig`:

   ```js
   const firebaseConfig = {
     apiKey: "AIza…",                                    // → NEXT_PUBLIC_FIREBASE_API_KEY
     authDomain: "formacionus-63555.firebaseapp.com",    // → NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
     projectId: "formacionus-63555",                     // → NEXT_PUBLIC_FIREBASE_PROJECT_ID
     storageBucket: "formacionus-63555.firebasestorage.app", // no se usa (Storage exige Blaze)
     messagingSenderId: "…",                             // no se usa
     appId: "1:…:web:…",                                 // → NEXT_PUBLIC_FIREBASE_APP_ID
   };
   ```

   `projectId` y `authDomain` son los que corresponden a `formacionus-63555`
   (el dominio predeterminado es `<id>.firebaseapp.com`). **`apiKey` y `appId`
   no se inventan nunca**: se copian literalmente de la consola. Si el proyecto
   ya tiene la app web registrada, esos dos valores ya existen y solo hay que
   releerlos.

5. Copiar **solo esos cuatro valores**. El `storageBucket` y el
   `messagingSenderId` no se usan y no hay que añadirlos.

**Si la app web ya existe** (por ejemplo, creada al abrir el proyecto por
primera vez): no hay que crear otra. El mismo bloque está en
**Configuración del proyecto → General → Tus apps → `formacion-web` →
Configuración del SDK**, y se puede volver a copiar en cualquier momento.

Comprobaciones que evitan el error más habitual:

- El `projectId` del bloque **debe** ser exactamente `formacionus-63555`, el
  mismo que `FIREBASE_PROJECT_ID` y que el `.firebaserc`. Si la consola mostrara
  otro, hay que decirlo antes de seguir: no se cambia por iniciativa propia.
- `authDomain` se copia **sin** `https://` y **sin** barra final.
- `appId` tiene la forma `1:<número>:web:<hash>`. Si lo que aparece empieza
  por `1:…:ios:` o `1:…:android:`, es la app equivocada.
- `apiKey` empieza por `AIza`. Es pública: identificador del proyecto, no un
  secreto. La seguridad la dan las reglas y la verificación del token en el
  servidor.

`check:firebase` valida la **forma** de estos cinco valores y su coherencia con
el servidor **antes** de intentar conectar (ver Paso 5).

### Paso 4 — Cuenta de servicio **[MANUAL]**

1. **Configuración del proyecto → Cuentas de servicio** → **Generar nueva
   clave privada** → se descarga un `.json`.
2. De ese fichero, copiar a `.env.local`:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY` **entre comillas dobles y con los
     `\n` tal cual vienen en el JSON**.
3. Guardar el `.json` fuera del repositorio y borrarlo del escritorio cuando
   ya esté copiado. Nunca se sube a git.

### Paso 5 — Comprobar la conexión **[YA IMPLEMENTADO]**

```bash
npm run check:firebase          # exit 0 = conecta y lee; 2 = falta config; 3 = no responde
npm run check:firebase -- --json --timeout=15000
npm run check:web               # solo configuración web, sin red (exit 0 o 2)
```

Los dos scripts leen `.env.local` por su cuenta (`src/server/firebase/env-file.ts`),
porque son procesos aparte de Next.js. Una variable exportada en el proceso
manda sobre el fichero.

Qué comprueba, en este orden:

| Bloque | Qué mira | ¿Red? |
| --- | --- | --- |
| Fichero | `.env.local` existe y Git lo ignora | no (git local) |
| Proyecto | `FIREBASE_PROJECT_ID` existe y es `formacionus-63555` | no |
| Credenciales | `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`, y que la clave sea un PEM válido (`createPrivateKey`) | no |
| Configuración web | forma de `apiKey`/`authDomain`/`projectId`/`appId` y que cliente y servidor apuntan al mismo proyecto y al mismo dominio de correo | no |
| Firestore | `listCollections`, `meta/schema`, recuentos de `accounts`/`courses`/`enrollments`/`progress` | sí (lectura) |
| Authentication | `listUsers(1)` | sí (lectura) |

**Solo lectura, comprobado por prueba automática.** El script no contiene
`.set`, `.add`, `.update`, `.delete`, `.create`, lotes, transacciones,
`createUser`, `updateUser`, `setCustomUserClaims` ni `revokeRefreshTokens`; y
`tests/server/firebase-check.test.ts` lee el fichero y falla si alguien
introduce uno. Tampoco ejecuta `db:init`, ni publica reglas, ni despliega.

Códigos de salida:

| Código | Resultado | Significado |
| --- | --- | --- |
| 0 | `PASSED` | configuración válida y Firestore/Auth responden |
| 1 | — | fallo inesperado del propio script |
| 2 | `FAILED` | falta configuración o es inválida (no se toca la red) |
| 3 | `BLOCKED` | configuración presente pero el servicio no responde, tarda más de 10 s (ajustable con `--timeout=`) o la cuenta no tiene permiso de lectura |

Cada lectura va envuelta en su plazo: las librerías de Google reintentan solas
ante un error de red y pueden tardar minutos. Un diagnóstico que no termina no
sirve.

**Después**, y solo si el diagnóstico da `exit 0`:

```bash
npm run db:init -- --apply      # crea meta/schema (pide DB_INIT_CONFIRM=yes y DB_ALLOW_PROD=yes)
```

### Paso 6 — Primera cuenta de administración **[MANUAL, decisión del usuario]**

No existe registro público y una fila de Excel nunca produce un administrador
(por diseño). El alta se hace con:

```bash
BOOTSTRAP_ADMIN_USERNAMES="rol1.apellido" \
BOOTSTRAP_CONFIRM=yes \
node scripts/bootstrap-admins.mjs
```

Crea la cuenta como `pending_activation` y **muestra una sola vez** un código de
activación de un solo uso. Ese código se entrega a la persona, que lo canjea en
`/activar` eligiendo su contraseña. Ejecuta antes con `--dry-run` si quieres ver
el plan sin escribir.

### Paso 7 — Reglas e índices **[MANUAL, y solo cuando toque]**

- **No publicar todavía.** Las 41 pruebas de reglas siguen **BLOCKED** (no hay
  emulador oficial en el entorno de desarrollo). Publicar `firestore.rules` sin
  validarlas está prohibido en este proyecto.
- Cuando el emulador esté disponible: `npm run test:rules` (41 casos) y, con
  todo en verde, publicar con `firebase deploy --only firestore:rules`.
- Índices: `npm run test:firestore` y `firebase deploy --only firestore:indexes`
  (el fichero ya contiene solo los índices que el código usa).
- `.firebaserc` ya apunta a `formacionus-63555`; ningún despliegue se hace desde aquí.

---

## 3. Qué queda ya implementado (no hay que tocarlo)

| Pieza | Estado |
| --- | --- |
| Canje del ID token por cookie httpOnly (`POST /api/auth/session`) | implementado y endurecido |
| Verificación de la cookie en cada petición (`checkRevoked` + ficha de cuenta) | implementado |
| Rechazo de emisión para cuentas pendientes/deshabilitadas o claims obsoletas | implementado |
| Activación con token de un solo uso, claims y revocación de sesiones | implementado |
| Cierre de sesión (Firebase en memoria + cookie) | implementado |
| Comprobación de origen (CSRF) sin confiar en `X-Forwarded-Host` | implementado |
| Endurecimiento de producción (`APP_ORIGIN` https + cookie `__Host-`) | implementado |
| Límite de intentos en `/api/activate` (10/h por IP) | implementado |
| Adaptadores Firestore, transacciones, reglas de negocio | implementado (no ejecutado contra Firebase) |
| Diagnóstico de conexión `npm run check:firebase` (solo lectura, con plazos) | implementado y probado sin red |
| Validación de la configuración web (`checkPublicFirebaseConfig`) | implementado y probado (18 pruebas) |
| Lectura de `.env.local` en los diagnósticos (`env-file.ts`) | implementado y probado (11 pruebas) |
| `npm run check:web` (configuración sin red) | implementado y probado |

## 4. Cómo se ponen los valores desde la interfaz de Arena

Los cuatro valores de la app web (`apiKey`, `authDomain`, `projectId`, `appId`)
y el dominio de correo se introducen **en un fichero del proyecto**, no en el
chat, no en un documento y no en un commit.

### 4.1 El fichero: `.env.local`

`.env.local` es un fichero **de la raíz del repositorio** que está en
`.gitignore`: Next.js lo lee al arrancar y Git lo ignora siempre. Es el único
sitio previsto para valores reales; `.env.example` solo documenta nombres y
debe quedarse con los valores vacíos.

> **Estado actual (21/10/2026):** `.env.local` **ya existe** en la raíz y está
> completo en lo que respecta al **cliente**. Contiene el proyecto
> (`formacionus-63555`), `authDomain`, `apiKey` y `appId` de la app
> `formacion-web`, el dominio de correo, `DEMO_MODE=1` y los emuladores vacíos.
> `npm run check:web` da **PASSED (exit 0)**.
>
> Desde el 21/10/2026 el fichero incluye también la **cuenta de servicio**
> (`FIREBASE_CLIENT_EMAIL` y `FIREBASE_PRIVATE_KEY`, en una sola línea con los
> saltos escapados). La clave se **rotó** ese mismo día: la anterior quedó
> sustituida y su revocación la hace el usuario desde la consola, no el
> repositorio. Ningún identificador ni fragmento de clave se guarda en docs. `npm run check:web` da **PASSED (exit 0)** y
> `npm run check:firebase` valida credenciales, clave PEM y configuración web,
> pero en **este entorno de desarrollo** termina en **BLOCKED (exit 3)**: la
> salida de red del sandbox solo permite npm, PyPI y GitHub, y las conexiones
> TLS a `firestore.googleapis.com` / `identitytoolkit.googleapis.com` se cortan
> (`SSL_ERROR_SYSCALL`). No es un problema de configuración ni una escritura:
> es el único sitio desde el que aún no se puede leer Firestore.

**Cómo se crea desde la interfaz de Arena:**

1. Abrir el explorador de ficheros del panel lateral del proyecto.
2. Comprobar que en la raíz **no** hay ya un `.env.local` (si lo hubiera, se
   edita: no se crea otro).
3. Crear un fichero nuevo llamado exactamente `.env.local` (con el punto
   delante, sin `.txt` al final) en la raíz, al mismo nivel que `package.json`.
4. Pegar este contenido y sustituir **solo** los valores por los de la consola
   (Firebase → Configuración del proyecto → Tus apps → `formacion-web` →
   Configuración del SDK):

   ```dotenv
   # Valores REALES del proyecto formacionus-63555. Nunca se versionan.
   FIREBASE_PROJECT_ID=formacionus-63555

   NEXT_PUBLIC_FIREBASE_API_KEY=AIza…
   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=formacionus-63555.firebaseapp.com
   NEXT_PUBLIC_FIREBASE_PROJECT_ID=formacionus-63555
   NEXT_PUBLIC_FIREBASE_APP_ID=1:…:web:…
   NEXT_PUBLIC_AUTH_EMAIL_DOMAIN=formacion.invalid

   # La demostración sigue activa hasta que se decida pasar al modo real.
   DEMO_MODE=1
   ```

5. Guardar. **No** hay que añadir `FIREBASE_CLIENT_EMAIL` ni
   `FIREBASE_PRIVATE_KEY` todavía: la clave de servicio no se ha generado.
6. Reiniciar el servidor de desarrollo para que Next.js relea el entorno:
   `DEMO_MODE=1 npm run dev`.

Notas que evitan errores:

- Sin comillas no se escapan caracteres; si un valor lleva comillas dobles
  alrededor, se quitan al leerlo. Para la futura clave privada sí hacen falta
  comillas dobles y los `\n` tal cual vienen en el JSON.
- Un `#` precedido de espacio inicia un comentario si el valor no va entre
  comillas.
- Una variable ya exportada en el proceso **manda** sobre el fichero (igual que
  en Next.js).
- `authDomain` se copia **sin** `https://` y **sin** barra final.
- `apiKey` y `appId` no se inventan ni se completan «a ojo»: si la consola
  muestra otra cosa, se copia lo que muestre.

### 4.2 Comprobar que los cuatro valores son válidos (sin red)

```bash
npm run check:web     # equivale a: npm run check:firebase -- --config-only
```

Comprueba la **forma** de los cinco valores y su coherencia con el proyecto
(`formacionus-63555`), sin tocar la red y sin escribir nada. Códigos: **0**
configuración válida · **2** algo falta o no cuadra. También avisa si el
`authDomain` no es el predeterminado y de qué fichero ha leído los valores.

Si en vez de `.env.local` prefieres variables de entorno del proceso, también
funcionan (el código lee `process.env`); lo que **no** persiste entre comandos
es exportarlas en una terminal suelta: hay que definirlas en el mismo comando o
en el fichero.

### 4.3 Comprobar que `.env.local` queda fuera de Git

Tres comprobaciones, en este orden:

```bash
git check-ignore -v .env.local   # debe imprimir la regla de .gitignore que lo excluye
git status --short               # NO debe aparecer .env.local en la lista
git ls-files --error-unmatch .env.local   # debe fallar: «did not match any file»
```

- La primera línea imprime algo como
  `.gitignore:45:.env.*	.env.local`. Si no imprime nada, **el fichero no está
  ignorado**: no se sigue hasta arreglarlo.
- La tercera debe terminar en error (código 1). Si devolviera el nombre del
  fichero, significaría que **ya está dentro del índice de Git**; en ese caso no
  basta con borrarlo del disco: hay que sacarlo del índice con
  `git rm --cached .env.local` y revisar el historial.
- `npm run check:firebase` y `npm run check:web` **también** comprueban lo
  primero cuando el fichero existe, y marcan `FAILED` si Git no lo ignora.

### 4.4 Lo que este mecanismo no promete

- `apiKey`, `authDomain`, `projectId` y `appId` **son públicos**: viajan en el
  bundle del navegador. No son secretos y no hace falta tratarlos como tales;
  la seguridad la dan las reglas de Firestore y la verificación del token en el
  servidor.
- `.env.local` está fuera de Git, pero **vive en el espacio de trabajo de este
  entorno**, que comparten tú y el agente. No es un almacén cifrado. Por eso los
  secretos de verdad (la clave privada de la cuenta de servicio) se añadirán
  cuando exista una decisión explícita sobre dónde guardarlos, y nunca se pegan
  en el chat.
- La demostración (`DEMO_MODE=1`) **no depende** de estos valores: con el
  fichero relleno y sin credenciales de servidor, la aplicación sigue en modo
  demostración y `isFirebaseConfigured()` sigue en `false` (solo mira el
  proyecto y las credenciales de servidor, no las variables públicas).

## 5. Qué NO se puede afirmar todavía

- Que la conexión funcione: no se ha ejecutado con credenciales reales.
- Que exista la app web `formacion-web`: no se ha registrado (o no se ha
  confirmado) todavía, y sin ella no hay `apiKey` ni `appId`.
- Que la **configuración web** sea la del proyecto real: el ID
  `formacionus-63555` está confirmado y ya escrito en el código, pero `apiKey` y
  `appId` aún no existen en este entorno porque no se ha registrado (o no se ha
  copiado) la app web.
- Que las reglas de seguridad sean correctas: 0 de 41 ejecutadas.
- Que la lectura de PDF se vea en pantalla con datos reales: la ruta que entrega
  el PDF completo está escrita y probada con dobles y en la demostración, pero no
  se ha ejecutado contra Firestore ni con documentos reales.
