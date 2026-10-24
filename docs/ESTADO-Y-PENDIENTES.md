# Estado real y qué falta para terminar

> **Fecha de la auditoría: 24 de octubre de 2026.**
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
| **Cambio de contraseña por el propio usuario** | **Nuevo (24-10)** | Página `/cuenta` + `POST /api/account/password`: exige la contraseña actual, aplica la misma política, revoca las sesiones y audita. 23 pruebas nuevas |
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

### P1 — Lo que un administrador necesita a diario

**3. Restablecer la contraseña de otra persona desde el panel.**
Hoy solo se puede con el script de terminal (`--reset-password`), que exige
tener las credenciales de servicio a mano. Para quien administra sin ser
técnico, esto es el hueco más grande que queda. El servicio ya existe
(`resetAccountPassword`); falta una acción en `/admin/personas/<uid>` con su
prueba y su auditoría.

**4. Dar de alta a una persona suelta.**
La única vía es importar un Excel. Para una incorporación individual hay que
fabricar un fichero de una fila. Es pequeño: el alta ya está implementada, solo
falta el formulario.

**5. Matricular en bloque.**
`/admin/matriculas` matricula de uno en uno (una persona, un curso). Falta
«matricular a todo un curso» o «matricular a varias personas». Con 40 personas
son 40 clics.

**6. No hay recuperación de contraseña por correo, y no es un olvido.**
Las cuentas usan correos internos sintéticos (`usuario@formacion.invalid`), que
no existen: Firebase no puede enviar enlaces de recuperación. Hoy el camino es
«pide a administración que te la restablezca» (punto 3) o el script. Con el
cambio de contraseña desde `/cuenta` ya cubierto, solo queda el caso «no puedo
entrar». **Esto requiere una decisión tuya** (ver sección 4).

### P2 — Producto formativo: lo que aún no existe

**7. Certificados.** No hay nada en el código: ni generación, ni plantilla, ni
verificación por código. Si un alumno termina un curso, no obtiene documento.

**8. Vídeos.** No existe nada. Hoy el contenido es texto y PDF.

**9. Informes y exportación.** `/admin/progreso` muestra resultados en pantalla;
no hay exportación a Excel/CSV ni informe descargable.

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
3. **Prioridad:** ¿empezamos por P1 (panel de administración) para que puedas
   operar sin terminal, o por P0 (reglas y candado de demostración) por
   seguridad?

Ninguna de estas tres cosas se ha empezado sin tu respuesta.
