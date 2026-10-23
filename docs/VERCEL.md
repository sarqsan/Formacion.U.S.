# Despliegue en Vercel — preparación

Proyecto de Vercel previsto: **`formacion.u.s.`** · repositorio: **`sarqsan/Formacion.U.S.`**
Rama de producción: **`main`**

> **Estado real (21/10/2026): NO VERIFICADO.** Desde este entorno no se ha podido
> comprobar el proyecto de Vercel ni su vínculo con el repositorio:
>
> - no hay Vercel CLI instalado ni `.vercel/project.json`;
> - no hay token de Vercel en el entorno (`VERCEL_TOKEN` vacío);
> - la salida de red del entorno no permite `api.vercel.com`
>   (`SSL_ERROR_SYSCALL`), y la API de GitHub no expone los webhooks del
>   repositorio a la integración disponible (403).
>
> Por eso aquí **no se afirma** que el proyecto exista, que apunte a este
> repositorio ni que tenga las variables correctas. Lo que sí está hecho es
> dejar el repositorio listo para que el primer despliegue no falle por
> configuración. **No se ha desplegado nada.**

---

## 1. Qué detecta Vercel sin tocar nada

| Ajuste | Valor | Por qué |
| --- | --- | --- |
| Framework | **Next.js** (detección automática) | `next` 16.4.2 en `package.json` |
| Install command | `npm ci` | hay `package-lock.json` versionado |
| Build command | `npm run build` | `next build` |
| Output | por defecto (`.next`) | no se usa `output: "export"` |
| Node.js | **22.x** | `engines.node: ">=22"` |
| Root directory | la raíz del repositorio | no es un monorepo |

### Por qué ahora sí hay `vercel.json` (incidencia del 23/10/2026)

La detección automática **no es una garantía**: es un valor guardado en el
proyecto, y si se queda en «Other» el despliegue cambia de naturaleza sin que
nadie toque el código. Ocurrió en producción:

| Síntoma | Dato real |
| --- | --- |
| `/` | 404 de **infraestructura** de Vercel (`NOT_FOUND`), no de Next.js |
| `/login`, `/activar`, `/panel`, `/api/health` | el mismo 404 de Vercel |
| `/favicon.ico` (lo genera Next, no está en `public/`) | 404 |
| `/demo/personas-sinteticas.xlsx` (único fichero de `public/`) | **200, servido** |

Con el preset **«Other»**, la documentación de Vercel dice literalmente:
«This sets the output directory as `public` if it exists». Es decir: se publica
`public/` como sitio estático y **la aplicación Next no se publica nunca**. El
build termina «Listo» porque `next build` sí se ejecuta; lo que falla es qué se
sirve después.

`vercel.json` fija el preset desde el repositorio, que es la única palanca
versionada (la documentación indica que `framework` «overrides the Framework in
Project Settings»):

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "buildCommand": "npm run build",
  "outputDirectory": ".next"
}
```

`tests/server/vercel-config.test.ts` (7 pruebas) impide que esto se pierda: si
alguien borra el fichero, cambia el framework o vuelve a apuntar la salida a
`public/`, la batería falla.

Complementos en el panel (no se pueden fijar desde el código, y ninguno se ha
tocado desde aquí):

- **Settings → Build & Development Settings → Framework Preset**: debe decir
  **Next.js**; con `vercel.json` el preset efectivo ya es Next.js, pero conviene
  que el panel coincida.
- **Root Directory**: vacío (la raíz del repositorio).
- **Production Branch**: `main`; y que el despliegue de `main` figure como
  **Production**, no como Preview.

## 2. Variables de entorno en Vercel

Se configuran en **Project → Settings → Environment Variables**. Distinguir dos
grupos es lo que evita el fallo clásico: las públicas se incrustan **en el
build**; las secretas se leen **en ejecución**.

### Públicas (necesarias en *Build* y *Preview* y *Production*)

| Variable | Origen |
| --- | --- |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | app web `formacion-web` |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `formacionus-63555.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `formacionus-63555` |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | app web `formacion-web` |
| `NEXT_PUBLIC_AUTH_EMAIL_DOMAIN` | `formacion.invalid` |

Si cambian, hay que **volver a desplegar**: un valor público modificado no
afecta a un build ya hecho.

### Secretas (solo servidor; nunca `NEXT_PUBLIC_`)

| Variable | Nota |
| --- | --- |
| `FIREBASE_PROJECT_ID` | `formacionus-63555` |
| `FIREBASE_CLIENT_EMAIL` | del JSON de la cuenta de servicio |
| `FIREBASE_PRIVATE_KEY` | pegar el valor **con los `\n` escapados** y entre comillas; Vercel los conserva |
| `APP_ORIGIN` | `https://<dominio-real>`; **obligatoria** en producción y solo https |
| `SESSION_COOKIE_NAME` | debe empezar por `__Host-` en producción (`__Host-formacion_session`) |

`AUTH_EMAIL_DOMAIN` (`formacion.invalid`) y `SESSION_TTL_HOURS` (`12`) tienen
valor por defecto en el código; se pueden fijar igualmente para dejarlo escrito.

### Modo demostración

Para publicar **solo la demostración**: `DEMO_MODE=1` y **ninguna** credencial
de servidor. Es el estado actual y no escribe en Firestore.

Para el modo real: quitar `DEMO_MODE` y añadir las tres `FIREBASE_*` +
`APP_ORIGIN` + cookie `__Host-`. Los dos modos no deben convivir.

## 3. Qué ya está preparado en el repositorio

- **`.vercelignore`**: excluye `.env.local` y cualquier `.env` real, las copias
  de seguridad (`backups/`, `*.fbak`), los JSON de cuenta de servicio,
  `node_modules`, `.next` y la caché de pruebas. Así el CLI tampoco los sube
  aunque alguien olvide el `.gitignore`.
- **`.gitignore`**: `.env*` (salvo `.env.example`), `serviceAccountKey*.json`,
  `*-firebase-adminsdk-*.json`, `/backups/`, `*.fbak`.
- **`src/server/config.ts`**: falla cerrado. Sin `FIREBASE_PROJECT_ID` o con una
  clave no PEM, la aplicación responde 503 en vez de degradar a memoria; en
  producción exige `APP_ORIGIN` https y cookie `__Host-`.
- **`next.config.ts`**: `serverExternalPackages` para `firebase-admin` (gRPC de
  Node no debe empaquetarse) y sin caché implícita de contenido privado.

## 4. Cómo comprobar el vínculo (cuando haya acceso)

En el panel de Vercel: **Project `formacion.u.s.` → Settings → Git**.

| Comprobación | Valor esperado |
| --- | --- |
| Connected Git Repository | `sarqsan/Formacion.U.S.` (privado) |
| Production Branch | `main` |
| Framework Preset | Next.js |
| Node.js Version | 22.x |
| Root Directory | `./` |
| Build Command | `npm run build` (o vacío = detección automática) |

Y en **Deployments**: que el primer despliegue corresponda al commit
`e23e113` (merge de la PR #1) o posterior, en la rama `main`.

Con CLI, el equivalente sin desplegar es:

```bash
vercel link        # vincula la carpeta con el proyecto; no despliega
vercel project ls  # lista los proyectos de la cuenta
```

`vercel link` y `vercel project ls` **no despliegan**; `vercel deploy` sí.

## 5. Límites que no se pueden saltar

- **Plan Hobby de Vercel: no admite uso comercial.** Para formación interna de
  una empresa hay que usar un plan que lo permita (o Netlify Free, que sí lo
  permite con 300 créditos/mes). No se afirma que Hobby sirva para producción.
- **Firebase Spark**: sin Storage, sin Cloud Functions, sin App Hosting y sin
  backups gestionados. La aplicación ya está diseñada así (PDF troceados en
  Firestore servidos por la propia app; copias `.fbak` fuera de Firebase).
- Un despliegue en Vercel **no** verifica Firestore: la primera lectura real
  sigue pendiente (`npm run check:firebase` → `exit 0`).

## 6. Qué NO se ha hecho

- No se ha desplegado, ni creado, ni modificado el proyecto de Vercel.
- No se han subido variables de entorno a Vercel.
- No se ha comprobado el vínculo con el repositorio (sin acceso ni red).
- No se ha escrito en Firestore, ni creado usuarios, ni publicado reglas.
