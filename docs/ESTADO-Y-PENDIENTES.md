# Estado real y qué falta para terminar

> **Fecha de la auditoría: 24 de octubre de 2026** (P1 completado el mismo día).
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

### P0 — Riesgos que conviene cerrar antes de usar la aplicación con datos reales

**1. Las reglas de Firestore nunca se han ejecutado.**
Hay 57 pruebas escritas (`npm run test:rules`), pero necesitan el emulador
oficial y en estos entornos no se ha podido descargar. Tampoco se ha podido
comprobar desde aquí **si las reglas están desplegadas** en el proyecto.
Por qué importa: hoy todo pasa por el servidor (que usa el Admin SDK y no
obedece a las reglas), así que la aplicación funciona igual; pero si las reglas
en la nube son permisivas, cualquiera con la clave web pública podría intentar
leer colecciones directamente. *Qué haría falta:* ejecutar el emulador y
publicar las reglas desde un entorno con `firebase-tools`.

**2. `DEMO_MODE` en producción es una puerta sin contraseña.**
El modo demostración permite entrar con cuentas ficticias sin contraseña
(`src/demo/`). Está **desactivado** en producción —`/api/health` responde
`mode:"firebase"`—, pero nada en el código impide activarlo por error en
Vercel. *Qué haría falta:* que el build de producción ignore `DEMO_MODE`, o un
candado que exija una segunda variable para habilitarlo.

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

### P2 bis — Un límite del modelo que conviene decidir

**Dos personas con el mismo apellido y el mismo rol no pueden coexistir.**
El usuario se deriva de `rol + apellido` (`rol1.garcia`), así que el sistema
considera que una segunda alta con la misma pareja es la misma persona y la
rechaza (igual en el Excel y en el alta individual). Es una decisión del modelo
de identidad, no un fallo del alta: si en la plantilla hay dos personas que
comparten apellido y rol, hoy no se pueden representar las dos. Corregirlo exige
un dato que las distinga (segundo apellido, número de empleado…) y toca usuarios,
reglas y migración: es una decisión de producto, no un arreglo suelto.

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
3. **Siguiente paso:** P1 está cerrado. Quedan P0 (reglas y candado de la
   demostración) y P2 (certificados, vídeos, informes). ¿Cuál primero?

Ninguna de estas tres cosas se ha empezado sin tu respuesta.
