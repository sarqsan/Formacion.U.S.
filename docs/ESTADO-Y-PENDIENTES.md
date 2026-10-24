# Estado real y qué falta para terminar

> **Fecha de la auditoría: 24 de octubre de 2026** (P1 y la parte ejecutable de
> P0 completados el mismo día).
> Todo lo que dice «verificado» se ha comprobado contra el repositorio o contra
> la aplicación desplegada en `https://formacionus.vercel.app`. Lo que no se ha
> podido comprobar se dice expresamente y **no se cuenta como hecho**.

Este documento responde a una pregunta concreta: *¿qué falta para que la
aplicación esté terminada?* No es una lista de deseos: cada punto está situado
en el código, con lo que ya existe y lo que no.

---

## 1. Lo que ya funciona de verdad

| Área | Estado | Cómo se ha comprobado |
| --- | --- | --- |
| Login real con Firebase Auth | **Funciona** | `admin1` entra en producción; `/api/health` responde `ready:true`, `mode:"firebase"` |
| Sesión con cookie httpOnly verificada en cada petición | **Funciona** | Sin sesión, `/admin/personas` redirige a `/login` y `/api/me` responde `authenticated:false` |
| Activación con código de un solo uso | **Funciona** | Página `/activar` con la política de contraseña real; token de 256 bits guardado solo como hash |
| Cambio de contraseña de una cuenta activa | **Funciona** | `npm run bootstrap -- --reset-password <usuario>`, con 8 pruebas y auditoría sin guardar la contraseña |
| **Cambio de contraseña por el propio usuario** | **Funciona** | Página `/cuenta` + `POST /api/account/password`: exige la contraseña actual, aplica la misma política, revoca las sesiones y audita. 23 pruebas |
| **Restablecer la contraseña de otra persona desde el panel** | **Nuevo (24-10)** | `/admin/personas/<uid>`: contraseña temporal generada por el servidor, se muestra una vez, cierra las sesiones y audita. 10 pruebas |
| **Alta de una persona suelta** | **Nuevo (24-10)** | `/admin/personas`: mismo apellido/rol, mismo usuario calculado y mismo código de un solo uso que la importación de Excel. 9 pruebas |
| **Matriculación en bloque** | **Nuevo (24-10)** | `/admin/matriculas`: matricula a todo el alumnado activo del curso, idempotente, informa de nuevas / ya estaban / fallos. 9 pruebas |
| Importación de personas desde Excel | **Funciona** | Vista previa + confirmación, tokens devueltos una sola vez |
| Cursos, temas, cuestionarios y examen final | **Funciona** | Corrección en servidor (`src/domain/assessments`), intentos auditados |
| Subida de PDF por partes con cuota | **Implementado** | Interfaz en `/admin/cursos/<id>/editar` y pruebas con dobles |
| Lectura de PDF por páginas con matrícula | **Implementado** | Endpoints `/api/documents/...` con comprobación de matrícula y versión |
| Administración de cuentas (deshabilitar, reactivar, reemitir código) | **Funciona** | `/admin/personas/<uid>`, con protección del último administrador |
| Copia de seguridad cifrada | **Implementado** | `npm run backup:export` / `backup:restore`, AES-256-GCM |

Cifras del último `npm run verify` (24-10): **1078 pruebas superadas, 9
omitidas, 64 ficheros**, `tsc`, `eslint` y `next build` limpios.

---

## 2. Lo que falta, por orden de importancia

### P0 — Riesgos antes de usar la aplicación con datos reales

**1. `DEMO_MODE` en producción era una puerta sin contraseña — CERRADO (24-10).**
La demostración entra sin contraseña: la cookie lleva el uid de una cuenta
inventada. Antes bastaba con que alguien escribiera `DEMO_MODE=1` en Vercel para
que el servidor arrancara con alumnado ficticio y sin pedir credenciales.

Ahora hay un candado único (`src/server/config/demo-gate.ts`):

- con `NODE_ENV=production`, `DEMO_MODE=1` **se ignora**; la aplicación usa
  Firebase y no hay acceso sin contraseña;
- **no existe variable de escape**: no se puede saltar desde el entorno;
- solo el valor exacto `1` la pide (`true`, `sí`, `yes` no la abren);
- el proxy del borde, las páginas, el diagnóstico y `/api/health` usan **la misma
  función**: hay una prueba que falla si alguien vuelve a leer `DEMO_MODE` a mano;
- si la variable se queda puesta en producción, el diagnóstico lo marca como
  `FAILED` en `/estado` y en `npm run check:firebase` en lugar de ignorarlo en
  silencio;
- **se puede comprobar desde fuera**: `https://formacionus.vercel.app/api/health`
  publica `"demo": false`. En producción siempre debe ser `false`.

**2. Publicar reglas sin probarlas ya no es un descuido posible — CERRADO (24-10).**
La política existía solo en la documentación: `firebase deploy` a mano publicaba
aunque las 57 pruebas estuvieran BLOCKED, es decir, sin haber probado nada.

Ahora `npm run rules:deploy -- --yes`:

1. ejecuta `npm run test:rules`;
2. si el resultado es **BLOCKED** (no había emulador) o **FAILED**, no publica
   nada y explica por qué;
3. si es PASSED y el proyecto es `formacionus-63555`, publica solo
   `firestore.rules`;
4. `--dry-run` enseña el plan sin tocar nada.

**3. Las reglas siguen sin ejecutarse en este entorno — PENDIENTE (bloqueado).**
No es un descuido: aquí no hay Java ni salida a `storage.googleapis.com`, así que
el emulador oficial no arranca. Sigue siendo el único punto de P0 que no se ha
podido cerrar, y **no se puede cerrar escribiendo más código**: hay que ejecutar
las pruebas en una máquina que tenga JVM y red. Los pasos están en
`docs/ENTORNO-PRUEBAS.md`; en tu Codespace, con red, es instalar Java y lanzar
`npm run test:rules` (57 casos). Hasta que eso pase, las reglas **no se han
probado contra el motor de Firestore**, aunque su política sí está verificada de
forma estática y ninguna escritura de cliente está permitida.

**4. No se ha podido comprobar qué reglas están desplegadas — PENDIENTE (sin acceso).**
Desde aquí no hay credenciales del proyecto, así que no puedo leer la versión
publicada. Comprobarlo requiere Google Cloud/Firebase con tu sesión. Si nunca se
ha publicado nada, el proyecto está con las reglas por defecto de Firestore
(que, en proyectos nuevos, **deniegan** todo acceso de cliente), pero eso hay que
verificarlo, no suponerlo.

### P1 — Operativo del administrador ✅ *(cerrado el 24-10)*

Lo que antes obligaba a abrir una terminal o a repetir clics ya se hace desde el
panel, con sus pruebas y su auditoría:

**3. Restablecer la contraseña de otra persona — hecho.**
En la ficha de la persona (`/admin/personas/<uid>`), botón «Restablecer
contraseña»: la genera el servidor con la política de `/activar`, se muestra
**una sola vez**, cierra las sesiones abiertas y queda auditada sin guardar la
contraseña. Solo cuentas activas: una pendiente se activa con su código y una
deshabilitada se reactiva antes.

**4. Dar de alta a una persona suelta — hecho.**
Formulario en `/admin/personas` con apellido y rol. Reutiliza el mismo camino que
el Excel (mismo cálculo de usuario, mismo código de un solo uso, cuenta siempre
`learner` y pendiente de activación): no hay una segunda forma de crear cuentas.

**5. Matricular en bloque — hecho.**
En `/admin/matriculas`, «Matricular a todo el alumnado activo»: la lista la
calcula el servidor con las cuentas y matrículas reales, no viaja desde el
navegador. Quien ya estaba no cambia de fecha y no se revoca nada.

**6. Recuperación de contraseña por correo — sigue pendiente de tu decisión.**
Las cuentas usan correos internos sintéticos (`usuario@formacion.invalid`), que
no existen: Firebase no puede enviar enlaces de recuperación. Hoy el camino es
«administración te la restablece» (punto 3) o el script. **Requiere decisión
tuya** (ver sección 4).

### P2 — Producto formativo: lo que aún no existe

**7. Certificados.** No hay nada en el código: ni generación, ni plantilla, ni
verificación por código. Si un alumno termina un curso, no obtiene documento.

**8. Vídeos.** No existe nada. Hoy el contenido es texto y PDF.

**9. Informes y exportación.** `/admin/progreso` muestra resultados en pantalla;
no hay exportación a Excel/CSV ni informe descargable.

### P2 bis — Límite del modelo: mismo apellido y mismo rol *(cerrado por decisión)*

El usuario se deriva de `rol + apellido` (`rol1.garcia`), así que el sistema
trata una segunda alta con la misma pareja como la misma persona y la rechaza
(igual en el Excel y en el alta individual). **Decisión del 24-10: no se toca.**
La persona responsable de los datos garantiza que no habrá dos personas con el
mismo apellido y el mismo rol, así que el límite no llega a darse en la práctica.
No hace falta migración, ni dato nuevo, ni cambio en las reglas.

### P3 — Calidad y mantenimiento

**10. `src/demo/` sigue en el árbol.** Es andamiaje útil para enseñar la
aplicación sin Firebase, y está probado, pero mantiene dos caminos para cada
pantalla. O se consolida o se separa del build de producción.

**11. Documentación desactualizada.** `/estado` y el encabezado del `README`
siguen describiendo la fase de demostración («sin servicios conectados», «0
pruebas de reglas ejecutadas»). La aplicación ya está desplegada con Firebase.

**12. No hay pruebas en navegador (E2E).** Todo se prueba en servidor y con
dobles. Nadie comprueba de forma automática que un clic real en producción
llegue a su sitio.

**13. La copia de seguridad nunca se ha ensayado contra el proyecto real.**
`npm run rehearse:backup` existe, pero se ha ejecutado con datos sintéticos.

---

## 3. Lo que **no** puedo verificar desde aquí

Para que no se confunda «no verificado» con «no existe»:

- si las reglas de Firestore están desplegadas y cuáles son las vigentes;
- si el emulador y sus pruebas llegan a ejecutarse en tu entorno;
- las variables de entorno reales de Vercel (solo veo el resultado en `/api/health`);
- que un PDF real se abra correctamente en un móvil Android;
- el contenido de la base de datos (nunca se ha leído).

---

## 4. Decisiones que necesito de ti

1. **Contraseña olvidada:** ¿seguimos con «administración la restablece» (barato,
   coherente con los correos sintéticos) o pasamos a guardar un correo real por
   persona para enviar enlaces de Firebase (más cómodo, pero hay que recoger y
   proteger esos correos)?
2. **Certificados:** ¿entran en el alcance? Es lo más grande de la lista P2.
3. **Siguiente paso:** P1 y el candado de P0 están cerrados. Para terminar P0
   hace falta ejecutar `npm run test:rules` en una máquina con Java y red (tu
   Codespace) y decirme el resultado. Después quedan P2 (certificados, vídeos,
   informes) y P3 (mantenimiento).

Ninguna de estas tres cosas se ha empezado sin tu respuesta.
