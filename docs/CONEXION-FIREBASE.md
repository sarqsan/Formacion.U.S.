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
>
> Antes de tener credenciales hay una pregunta previa: **qué falta**. La
> responde `npm run check:setup`, sin red y sin tocar nada (ver §7).

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

**Cómo saber si la app web ya existe (antes de crear nada).** Desde este
entorno **no se puede comprobar**: no hay credenciales y las llamadas a
`firebase.googleapis.com` están bloqueadas. Se mira en la consola, en un solo
sitio:

> <https://console.firebase.google.com/project/formacionus-63555/settings/general>
> → **Tus apps**. La lista enseña todas las apps registradas.

- Si aparece una app **Web** con apodo `formacion-web` (o cualquier app web:
  solo puede haber una por proyecto en la práctica), **se reutiliza**: se abre y
  se copian sus cuatro valores de *Configuración del SDK*. **No se registra otra
  app**: cada registro crea un `appId` distinto y el que se use debe ser el de
  la app real.
- Si **no** aparece ninguna app web, se registra siguiendo los pasos de abajo
  (solo entonces).
- Si aparece una app web con **otro** apodo, se usa esa igualmente y se dice
  cuál es; no se crea una segunda.

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
el servidor **antes** de intentar conectar (ver Paso 5). Y `npm run check:setup`
los marca como `[pública]`: si alguno falta, es lo primero que se puede
arreglar sin credenciales ni red.

### Paso 4 — Cuenta de servicio **[MANUAL]**

1. **Configuración del proyecto → Cuentas de servicio** → **Generar nueva
   clave privada** → se descarga un `.json`.
2. De ese fichero:
   - `project_id` → `FIREBASE_PROJECT_ID` (público; va en `.env.local`);
   - `client_email` → `FIREBASE_CLIENT_EMAIL`;
   - `private_key` → `FIREBASE_PRIVATE_KEY`, **solo al entorno privado del
     proceso**, nunca a un fichero del espacio de trabajo, ni al chat, ni a un
     commit. Ver §4.5.
3. Guardar el `.json` en un gestor de contraseñas y **borrarlo del disco**
   cuando ya esté cargado en el entorno de ejecución. Nunca se sube a git.

> Este paso **no se ejecuta todavía** en este entorno: no hay ningún sitio
> privado donde dejar la clave, y la red hacia Google está cortada, así que
> generar la clave ahora solo añadiría un secreto sin poder comprobarlo.

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

- **No publicar todavía.** Las 57 pruebas de reglas siguen **BLOCKED** (no hay
  emulador oficial en el entorno de desarrollo). Publicar `firestore.rules` sin
  validarlas está prohibido en este proyecto.
- Cuando el emulador esté disponible: `npm run test:rules` (57 casos) y, con
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

> **Estado actual (22/10/2026): en este entorno NO existe `.env.local`.** Lo que
> sigue siendo cierto es el procedimiento; lo que ya no se puede afirmar es el
> estado descrito en una revisión anterior de esta guía (que el fichero estaba
> completo y que `check:web` daba `PASSED`). Hoy `npm run check:setup` termina en
> **FAILED (exit 2)** porque no hay ningún valor, ni público ni secreto, y no
> existe ninguna variable `FIREBASE_*` en el proceso. Conclusión práctica: **el
> fichero no se conserva entre sesiones** y no se puede dar por hecho. Cada vez
> que se retome el trabajo hay que comprobar `ls .env.local` antes de suponer
> nada, y volver a crearlo si falta.
>
> Además, este entorno **no tiene salida de red hacia Google**: las conexiones a
> `firebase.googleapis.com`, `identitytoolkit.googleapis.com` y
> `<proyecto>.firebaseapp.com` se cortan. Es decir, incluso con el fichero
> completo, `npm run check:firebase` aquí acabaría en **BLOCKED (exit 3)**: la
> verificación de la conexión real tiene que hacerse donde Firebase sea
> alcanzable (tu máquina o el despliegue).

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

### 4.5 Dónde va la clave privada (y dónde no)

Comprobado en este entorno (22/10/2026), sin suposiciones:

| Comprobación | Resultado |
| --- | --- |
| `/run/secrets` | no existe |
| gestor de secretos del entorno (`.arena/`, `.config/arena`) | no existe |
| variables de entorno del proceso | ninguna `FIREBASE_*` ni `GOOGLE*` |
| `.env.local` | no existe; la revisión anterior lo daba por hecho |
| ficheros del espacio de trabajo | se guardan en instantáneas y se ven en el explorador; `.env.local` **no** está excluido de esas instantáneas |

**Conclusión: aquí no hay ningún almacén privado y persistente.** Por tanto:

- **Valores públicos** (`NEXT_PUBLIC_*`): pueden ir a `.env.local` sin problema.
  Viajan en el bundle del navegador; la seguridad no depende de esconderlos.
- **`FIREBASE_PROJECT_ID`**: es público (aparece en el `appId` y en el
  `authDomain`), pero se guarda junto a la configuración del servidor porque es
  el que se compara con el previsto.
- **`FIREBASE_CLIENT_EMAIL` y `FIREBASE_PRIVATE_KEY`**: son las credenciales de
  la cuenta de servicio. La clave **no se pega en el chat, no se escribe en un
  documento, no se commitea y no se deja en un fichero del espacio de trabajo**.
  Se inyecta como variable de entorno del proceso que ejecuta la aplicación:
  - en el despliegue, en la configuración de variables de entorno del proveedor
    (cifradas, nunca en el repositorio);
  - en local, exportada solo en la misma orden que la usa, por ejemplo
    `FIREBASE_PRIVATE_KEY="$(cat /ruta/privada/clave.pem)" npm run check:firebase`,
    borrando el fichero temporal después. Nunca mediante `set -x` ni con
    `npm run check:firebase --json` volcado a un log.

Mientras no exista ese entorno, **la aplicación se queda sin credenciales de
servidor y no se afirma que haya conexión**: `check:setup` lo dirá como
`[SECRETA]` pendiente y `/login` no mostrará el formulario real.

La CLI ayuda a no equivocarse: `npm run check:setup` marca cada acción pendiente
con `[pública]`, `[SECRETA]` o `[configuración]` y avisa de que las secretas no
se pegan en el chat.

### 4.6 Valores públicos: escritos tras autorización expresa (fase 4, 22/10/2026)

**Estado final de esta fase:** el usuario autorizó expresamente escribir los
cuatro valores públicos del SDK web en `.env.local` de este espacio de trabajo,
conociendo que el fichero queda visible en el explorador y en las instantáneas.
Está hecho: seis variables, permisos `600`, excluido por `.gitignore` y **fuera
del commit** (comprobado con `git check-ignore`, `git status` y
`git ls-files --error-unmatch`). Ningún valor aparece en la documentación, en el
diff ni en los commits; tampoco se repite en la salida de los diagnósticos.

Lo que sigue siendo cierto y conviene no olvidar:

| Comprobación | Resultado |
| --- | --- |
| `projectId` recibido | `formacionus-63555` — coincide con `.firebaserc` y con `FIREBASE_PROJECT_ID` |
| Forma de los cuatro valores frente a los patrones de `public-config.ts` | los cuatro pasan; `npm run check:web` → **PASSED (exit 0)** |
| ¿Es un almacén privado este entorno? | **no**: ficheros en instantáneas y visibles en el explorador |
| ¿Basta `.gitignore`? | para el **repositorio** sí; no protege la instantánea del espacio de trabajo |

Los cuatro valores **no son secretos** (viajan en el bundle de cualquier
despliegue; la seguridad la dan las reglas de Firestore y la verificación del
token en el servidor). La autorización se apoyó en eso.

**Lo que sigue pendiente es el secreto de verdad:** `FIREBASE_CLIENT_EMAIL` y
`FIREBASE_PRIVATE_KEY`. No se guardan aquí. `.env.local` es aceptable para los
valores públicos; **no** lo es para la clave privada.

Cómo se comportaba el entorno antes de la autorización (se conserva como
referencia de por qué no se escribe nada sin permiso):

| Comprobación | Resultado |
| --- | --- |
| `projectId` recibido | `formacionus-63555` — coincide con `.firebaserc` y con `FIREBASE_PROJECT_ID` |
| Forma de los cuatro valores frente a los patrones de `public-config.ts` | los cuatro pasan (la CLI lo confirmará al ejecutarse con ellos) |
| Almacén privado disponible | **no existe**: ni `/run/secrets` ni gestor de secretos, y los ficheros del espacio de trabajo se guardan en instantáneas y se ven en el explorador |
| ¿Basta `.gitignore`? | **no**: protege el repositorio, no la instantánea del espacio de trabajo |

Los cuatro valores **no son secretos** (viajan en el bundle de cualquier
despliegue; la seguridad la dan las reglas de Firestore y la verificación del
token en el servidor). Aun así, el entorno **no permite mantener el fichero en
privado**, así que no se han escrito: se han tratado como datos que solo deben
vivir en el entorno de ejecución.

**Consecuencia práctica antes de la autorización:** `npm run check:web` y
`npm run check:setup` daban **FAILED (exit 2)**. No era un error de los valores:
era que no estaban puestos donde la aplicación los lee. Hoy `check:web` está en
**PASSED** y `check:setup` sigue en **FAILED** por una sola razón: faltan las
credenciales de la cuenta de servicio.

**Dónde ponerlos (dos vías, ninguna en este espacio de trabajo sin permiso
explícito):**

1. **Producción / despliegue (la buena).** Las cinco `NEXT_PUBLIC_*` (más
   `FIREBASE_PROJECT_ID`, público) se definen como variables de entorno del
   proveedor (Vercel, etc.). Se inyectan en **tiempo de compilación**: si se
   cambian, hay que volver a construir. Ahí quedan cifradas y fuera del
   repositorio.
2. **Tu máquina, en local.** `.env.local` en tu clon (ignorado por Git), y
   `npm run check:web`. Ese fichero no sale de tu equipo.

La plantilla vacía es **`.env.example`**: tiene los seis nombres exactos con los
valores vacíos. Se copia, se rellena en la copia y **nunca** se rellena el
ejemplo (se versiona).

Si en algún momento se quiere arrancar la aplicación **en este espacio de
trabajo** con la configuración real, hay que aceptarlo de forma explícita: los
valores quedarían en un fichero visible en el explorador y en las instantáneas
del proyecto. Son públicos, así que el riesgo es bajo, pero no es una decisión
que corresponda tomar al agente.

## 5. Qué NO se puede afirmar todavía

- Que la conexión funcione: no se ha ejecutado con credenciales reales.
- Que exista la app web `formacion-web`: **no se puede comprobar desde aquí**
  (sin credenciales y con las llamadas a `firebase.googleapis.com` bloqueadas).
  Solo la consola lo dice: *Configuración del proyecto → Tus apps*. Hasta
  entonces, ni `apiKey` ni `appId` existen en este entorno.
- Que la **configuración web** sea la del proyecto real: el ID
  `formacionus-63555` está confirmado y ya escrito en el código, pero `apiKey` y
  `appId` aún no existen en este entorno porque no se ha registrado (o no se ha
  copiado) la app web.
- Que la configuración esté completa: eso **sí** se comprueba hoy, sin red, con
  `npm run check:setup` (y sus pruebas). «Completa» no es «correcta para
  Google»: que la cuenta de servicio exista y tenga permisos solo lo dice
  `npm run check:firebase`.
- Que las reglas de seguridad sean correctas: 0 de 57 ejecutadas. Lo que sí se
  ha comprobado es que el texto de las reglas sigue la política prevista (22
  comprobaciones estáticas en `npm test`); el motor no se ha ejecutado (ver
  `SEGURIDAD.md` §5.9 y `ENTORNO-PRUEBAS.md` §2 bis).
- Que la lectura de PDF se vea en pantalla con datos reales: la ruta que entrega
  el PDF completo está escrita y probada con dobles y en la demostración, pero no
  se ha ejecutado contra Firestore ni con documentos reales.

---

## 6. Validación pendiente de las reglas (fase 1)

Estado tras la revisión del 22/10/2026: las reglas están **revisadas y
corregidas** en el repositorio, con 57 pruebas escritas y 22 comprobaciones
estáticas ejecutándose en cada `verify`, pero **no se han ejecutado contra el
motor** ni se han publicado.

### 6.1 Con el emulador (máquina con red hacia `storage.googleapis.com`)

1. Java: `pip download jdk4py -d /tmp/jdkpkg --no-deps && cd /tmp/jdkpkg &&
   unzip -q jdk4py-*.whl && export JAVA_HOME=/tmp/jdkpkg/jdk4py/java-runtime &&
   export PATH="$JAVA_HOME/bin:$PATH" && java -version`. Comprobado aquí: deja
   OpenJDK 25 funcional.
2. Conseguir el jar oficial. La descarga automática no es la única vía: si la
   máquina no alcanza `storage.googleapis.com`, basta con copiar
   `cloud-firestore-emulator-v1.22.0.jar` (136 707 194 bytes, SHA-256
   `9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c`) a
   `~/.cache/firebase/emulators/` o apuntar `FIRESTORE_EMULATOR_BINARY_PATH` a
   la copia.
3. `npm ci` y `npm run check:env`: debe quedar en **PASSED**, y la línea del jar
   tiene que decir «SHA-256 verificado». Un archivo truncado o de otra versión
   sale **FAILED** (no se acepta por el nombre).
4. `npm run test:rules` → esperado **PASSED, 57 pruebas**. Si algo falla, el
   fallo es real: **no se toca `firestore.rules` para que pase** (ADR-017), se
   documenta y se decide.
5. `npm run test:firestore` → esperado **PASSED, 9 pruebas**, incluidas las 5 del
   histórico (normalización de `archivedAt` y filtro por `uid`).
6. `npm run db:check` con `FIRESTORE_EMULATOR_HOST` apuntando al emulador: debe
   informar `INDEXES_OK`, incluida la consulta `progressHistory(uid)` sin
   `orderBy`.

Lo que el emulador **no** puede demostrar: que el proyecto real no necesite
índices compuestos (el emulador los crea solo) ni que las reglas publicadas sean
las del fichero.

### 6.2 Con Firebase real (requiere autorización expresa; nada de esto se ha hecho)

1. ~~Registrar la app web~~ **hecho**: existe una app web en `formacionus-63555` y
   sus cuatro valores están puestos (ver §4.6). `npm run check:web` → `PASSED`.
2. Credenciales de servicio en el **entorno privado del proceso** (nunca en el
   repositorio ni en un fichero compartido: ver §4.5 y §8). `DB_ALLOW_PROD=yes`
   **no** hace falta aquí: solo lo exigen `db:init` y `db:check`, que sí pueden
   escribir o consultar el esquema.
3. `npm run check:firebase` (solo lectura) → debe encender todas las
   comprobaciones. Procedimiento detallado fuera de este entorno: **§8**.
4. `npm run db:init` (simulación) y `npm run db:check`: comprobar `INDEXES_OK` con
   las consultas reales. **No añadir índices** salvo que `db:check` señale una
   consulta que el código ejecuta de verdad.
5. Publicar reglas e índices **solo después** de que el emulador pase:
   `firebase deploy --only firestore:rules,firestore:indexes` (acción reservada;
   no ejecutada desde aquí).
6. Repetir la batería negativa contra el proyecto real con una cuenta de prueba
   (lectura anónima, lectura de otro alumno, cuenta deshabilitada) y borrarla al
   terminar.

---

## 7. Antes de conectar: `npm run check:setup` (fase 3)

Pregunta que responde, sin red y en un segundo: **¿qué valores faltan o están mal
para que esta instalación pueda hablar con `formacionus-63555`?**

```bash
npm run check:setup          # informe legible + lista de acciones en orden
npm run check:setup -- --json   # lo mismo, para máquinas
```

Qué comprueba, sin hablar con Google:

| Grupo | Comprobaciones |
| --- | --- |
| Servidor | `FIREBASE_PROJECT_ID` presente **y** igual al previsto; `FIREBASE_CLIENT_EMAIL` y `FIREBASE_PRIVATE_KEY` presentes; la clave se **parsa de verdad** (`node:crypto`) y es **RSA**; `PDF_STORAGE_BUDGET_MB` numérico |
| Cliente web | `apiKey` con forma de Firebase, `authDomain` sin `https://`, `appId` con forma `1:nº:web:hash`, `projectId` **igual al del servidor**, dominio de correo igual al del servidor |
| Producción | `APP_ORIGIN` presente y https fuera de local; cookie con prefijo `__Host-`; sin variables de emulador |
| Entorno | `.env.local` existe → se comprueba que **git lo ignora** |

Salida real en esta máquina (sin `.env.local`): `RESULTADO: FAILED` (exit 2) con
siete acciones numeradas, empezando por `FIREBASE_PROJECT_ID` y siguiendo por la
cuenta de servicio y la app web.

**Lo que NO dice `check:setup`:** si el proyecto existe, si la cuenta de servicio
tiene permisos o si Firestore responde. Eso es `npm run check:firebase` (con
red). `check:setup` solo evita perder tiempo con un despiste de pegado.

### Qué cambia en la aplicación

- **Pantalla de acceso** (`/login`): el formulario real solo se muestra cuando
  están las **dos** partes (credenciales de servidor y configuración web). Antes
  se miraban solo las credenciales: con la app web sin registrar, el formulario
  aparecía y el error saltaba al pulsar «Entrar», en el navegador y sin decir qué
  faltaba. Ahora, si falta algo, se enumeran los valores que faltan y se remite a
  `npm run check:setup`. En demostración se explica que allí no hay Firebase.
- **`GET /api/health`**: añade `ready` (todo rellenado) sin exponer nombres de
  variables ni valores. `ready: true` **no** significa «conectado»: la conexión
  exige red y la comprueba `check:firebase`.

---

## 8. Ejecutar la comprobación REAL fuera de este espacio de trabajo (fase 5)

`npm run check:firebase` responde a una pregunta que **este entorno no puede
responder**: *¿puede un proceso, con credenciales reales, leer Firestore y
Authentication de `formacionus-63555`?* Aquí fallan dos cosas a la vez: no hay
salida de red hacia Google y no hay ningún almacén privado de secretos. Por eso
la comprobación se ejecuta fuera, en un entorno tuyo.

### 8.1 Qué hace falta (y qué NO)

| Necesario | Detalle |
| --- | --- |
| Node.js **22 o superior** | `package.json` declara `engines.node: ">=22"`; comprobar con `node -v` |
| El repositorio clonado + `npm ci` | el diagnóstico corre con `tsx`, que está en `devDependencies`: sin instalar dependencias de desarrollo no arranca |
| `.env.local` con los **cinco valores públicos** | `check:firebase` también valida la configuración web; sin ella da `FAILED` aunque las credenciales sean perfectas. Los valores son públicos (§4.6) |
| `FIREBASE_CLIENT_EMAIL` y `FIREBASE_PRIVATE_KEY` | en el **entorno del proceso**, no en un fichero del repositorio |
| Red hacia `*.googleapis.com` y `*.firebaseio.com` | sin ella el resultado será `BLOCKED`, no `FAILED` |

**No** hace falta: `next build`, Firebase CLI, el emulador, `DB_ALLOW_PROD=yes`,
ni ninguna dependencia nueva. Es un script de Node que solo lee.

Códigos de salida (recordatorio): **0** `PASSED` · **2** `FAILED` (falta o está
mal la configuración; no se ha tocado la red) · **3** `BLOCKED` (configuración
correcta, pero el servicio no responde o la cuenta no tiene permiso de lectura).

### 8.2 Plan A — un ordenador con terminal (recomendado)

Es el camino corto: cinco minutos, sin instalar nada global.

1. Comprobar la versión de Node: `node -v` (debe ser 22 o superior).
2. Clonar y preparar:
   ```bash
   git clone https://github.com/sarqsan/Formacion.U.S..git
   cd Formacion.U.S.
   git switch arena/1aa99b2c-formacion-u-s
   npm ci
   ```
3. Crear `.env.local` en la raíz **solo con los valores públicos** (los mismos
   que ya están en este espacio de trabajo): `FIREBASE_PROJECT_ID`,
   `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
   `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID` y
   `NEXT_PUBLIC_AUTH_EMAIL_DOMAIN`. Comprobar sin red:
   ```bash
   npm run check:web      # debe dar PASSED
   ```
4. En la consola: *Configuración del proyecto → Cuentas de servicio → Generar
   nueva clave privada*. Se descarga un `.json`. **No se abre en el editor y no
   se copia a ninguna carpeta del repositorio.**
5. Cargar las credenciales en la sesión del terminal **sin escribirlas en ningún
   fichero** y sin que queden en el historial (el comando solo lee el JSON, no
   imprime nada):
   ```bash
   export FIREBASE_CLIENT_EMAIL="$(node -p 'require(process.argv[1]).client_email' "$HOME/Descargas/clave.json")"
   export FIREBASE_PRIVATE_KEY="$(node -p 'require(process.argv[1]).private_key' "$HOME/Descargas/clave.json")"
   ```
   Ajusta la ruta al nombre real del archivo. Si prefieres pegar la clave a mano,
   hazlo con `read -rsp "FIREBASE_PRIVATE_KEY: " FIREBASE_PRIVATE_KEY` (entrada
   oculta; pega la línea `private_key` del JSON, con los `\n` tal cual).
6. Ejecutar:
   ```bash
   npm run check:firebase
   ```
7. Limpiar, pase lo que pase:
   ```bash
   unset FIREBASE_CLIENT_EMAIL FIREBASE_PRIVATE_KEY
   ```
   y **borrar el JSON** de la carpeta de descargas. Si la clave se generó solo
   para esta prueba y no se va a usar, revocarla en la consola.

Reglas de seguridad de esta sesión de terminal: no uses `set -x`, no redirijas
la salida de `check:firebase` a un fichero, no ejecutes `env` ni `printenv`, y
cierra el terminal al terminar.

**Qué contarme después:** solo el veredicto (`0`/`2`/`3`) y las líneas de
resultado **sin valores** (por ejemplo `✓ Firestore responde` o
`… Firebase Authentication responde: PERMISSION_DENIED`). El script está diseñado
para no repetir la clave, el correo completo, el `apiKey` ni el `appId`; aun así,
no pegues la salida entera.

### 8.3 Plan B — solo con el móvil (GitHub Codespaces)

Ventaja: el secreto no se pega en una terminal ni se guarda en un fichero; queda
cifrado en tu cuenta de GitHub y se inyecta como variable de entorno en el
Codespace, que es exactamente el mecanismo que lee la aplicación.

1. Desde el navegador del móvil, en el repositorio: **Code → Codespaces → Create
   codespace on `arena/1aa99b2c-formacion-u-s`**.
2. **Antes o después** de crearlo, en *github.com → Settings → Codespaces →
   Secrets → New secret*, crear dos secretos con los nombres **exactos**
   `FIREBASE_CLIENT_EMAIL` y `FIREBASE_PRIVATE_KEY` (el valor de `private_key`
   tal cual viene en el JSON: una línea con los `\n`). Los secretos se exportan
   como variables de entorno de la sesión y **no** se pasan a los forks
   (GitHub Docs). Límite: 48 KB por secreto.
3. En la terminal del Codespace:
   ```bash
   npm ci
   npm run check:web
   npm run check:firebase
   ```
   Si `check:web` falla, crea `.env.local` con los seis valores públicos (§4.6):
   son públicos y no necesitan secreto.
4. Al terminar, **parar el Codespace** (consume cuota mientras está encendido) y,
   si la clave era solo para la prueba, revocarla.

Coste: las cuentas personales de GitHub incluyen 120 core-hours y 15 GB-mes de
Codespaces al mes (unas 60 h en una máquina de 2 núcleos). Pasado ese límite,
GitHub factura. Con un Codespace de 2 núcleos y una sesión de 15 minutos, el
consumo es despreciable. Comprobado en la documentación de GitHub el 22/10/2026.

### 8.4 Plan C — sin terminal propia

Si no hay ordenador ni quieres usar Codespaces, la alternativa honesta es que
**otra persona de confianza** ejecute el Plan A en su equipo, con dos
condiciones: la clave se genera en la consola de *tu* proyecto y se revoca al
terminar, y el resultado se comparte sin valores. No hace falta que esa persona
vea la clave: puede pegar el JSON con `read -rsp` sin mostrarlo en pantalla.

Lo que **no** se debe hacer en ningún caso: pegar la clave privada en este chat,
en un documento compartido, en un `commit`, en una issue, en un gist o en un
`.env.local` de un espacio de trabajo compartido (como el de este entorno).

### 8.5 Qué cambia al pasar al despliegue

| Variable | Cuándo se lee | ¿Reconstruir? |
| --- | --- | --- |
| `NEXT_PUBLIC_*` (las cinco) | en **tiempo de compilación**: Next.js las inserta en el bundle del navegador | **Sí**: si cambian, hay que volver a construir |
| `FIREBASE_*` (proyecto, correo, clave) | en **tiempo de ejecución**, en el servidor | No: basta reiniciar el proceso |
| `APP_ORIGIN`, `SESSION_COOKIE_NAME`, `PDF_STORAGE_BUDGET_MB` | en tiempo de ejecución | No |

Para `npm run check:firebase` **no hay que reconstruir nada**: es un script de
Node que lee el entorno en el momento de ejecutarse.

### 8.6 Estado de esta fase

- Lo comprobado **aquí**: `check:web` → `PASSED`; `check:setup` → `FAILED` con una
  única acción pendiente, `[SECRETA]` (las credenciales); `npm run verify` y
  `check:demo` en verde. Todo sin red hacia Google.
- **Ensayo en seco del Plan A**: con un par de claves **sintético** (generado y
  borrado en `/tmp`, nunca del proyecto), los comandos del paso 5 cargan correo y
  clave sin imprimirlos, y `check:firebase` valida toda la configuración
  (`✓` en proyecto, credenciales, clave PEM y los cinco valores web) y termina en
  **`BLOCKED` (exit 3)** al intentar leer Firestore: exactamente lo que debe
  pasar cuando la red está cortada. Es decir, el procedimiento está probado
  hasta el último paso que este entorno puede dar.
- Ese ensayo destapó un aviso falso: la comprobación comparaba el dominio del
  correo con `gserviceaccount.com` y marcaba «no es el habitual» en las cuentas
  reales de Firebase (`*.iam.gserviceaccount.com`). Corregido y cubierto con
  tres pruebas.
- Lo **no** comprobado: la conexión real. Sigue pendiente y no se afirma.
