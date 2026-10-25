# Auditoría · 25 de octubre de 2026

Revisión del estado de la aplicación y, en particular, de la protección de los
documentos que sube administración. Está escrita sin adornos: separa lo que
está comprobado hoy de lo que solo está implementado, y lo que la aplicación
**no puede** garantizar por mucho que se configure.

---

## 1. Resumen en tres frases

1. **La aplicación está sana**: tipos, avisos y compilación limpios, **1 287
   pruebas automáticas correctas** (9 omitidas), **0 vulnerabilidades** en las
   dependencias tras el cambio de hoy.
2. **El PDF está bien protegido frente a terceros**: no hay URL pública, no hay
   bucket, ni siquiera un enlace firmado; cada byte se entrega tras comprobar
   identidad, matrícula y publicación. Un desconocido no puede descargarlo ni
   sabiendo el identificador.
3. **Lo que no se puede impedir por software**: un alumno con matrícula activa
   puede guardar el PDF que está leyendo y reenviarlo. Eso no es un fallo de la
   aplicación, es el límite de cualquier visor de documentos sin DRM. La única
   defensa real es la marca de agua por persona y el registro de descargas, que
   hoy **no** existen (ver §5).

---

## 2. Cómo se protege hoy un PDF, paso a paso

Ningún byte sale del servidor sin superar **todas** estas comprobaciones
(`src/server/documents/file.ts` y `src/server/documents/service.ts`):

| # | Comprobación | Si falla |
| --- | --- | --- |
| 1 | Cuenta **activa** (no vale una cookie suelta) | 401 |
| 2 | Identificador con forma válida (sin `/`, sin `..`) | 404 |
| 3 | El documento existe y está **activo** (no a medias, no abortado) | 404 |
| 4 | El curso tiene **versión publicada** | 404 |
| 5 | El solicitante tiene **matrícula activa** en ese curso | 403 |
| 6 | El documento está **citado expresamente** en esa versión publicada | 404 |
| 7 | Las partes cubren el tamaño y el **SHA-256** coincide | 409 |
| 8 | Límite de descargas por persona y global | 429 |

Detalles que suman:

- **No hay almacenamiento público.** Los PDF viven troceados en Firestore
  (`pdfChunks`), no en Cloud Storage. No existe ninguna URL que se pueda
  reenviar: la única puerta es `/api/documents/{id}/file` con sesión.
- **Las reglas de Firestore cierran la puerta por dentro**
  (`firestore.rules`): `documents`, `pdfChunks` y `answerKeys` responden
  `allow read, write: if false`. Aunque alguien tenga sesión válida, no puede
  leer un fragmento directamente desde el navegador.
- **Respuestas privadas por cabecera**: `Cache-Control: no-store, private`,
  `nosniff`, `Referrer-Policy: no-referrer`, `Content-Disposition: inline`.
  No queda copia en cachés compartidas ni en el historial de referencias.
- **Los errores no dan pistas**: «no existe», «es de un borrador» y «no te
  corresponde» devuelven lo mismo. No se puede descubrir qué documentos hay.
- **Las claves de corrección nunca viajan al cliente**: la versión publicada se
  construye con `toClientQuiz`, que elimina `correctOptionIds` y `explanation`.
- **Un documento de borrador o de una versión antigua no se sirve** aunque su
  identificador sea correcto: se exige que esté citado en la versión publicada
  actual.

Verificado en ejecución real en esta misma sesión: las páginas de alumno no
contienen la solución (`correctOptionIds`, `explanation`, `isCorrect`: **0
apariciones**), y los cursos en borrador no aparecen en el catálogo.

---

## 3. Quién puede ver el documento

| Quién | ¿Puede? | Condición |
| --- | --- | --- |
| Persona sin sesión | **No** | Redirige a acceso; la API responde 401 |
| Alumno matriculado y activo | **Sí** | Solo si el curso está publicado y el documento está en esa versión |
| Alumno con matrícula revocada | **No** | La matrícula se comprueba en cada petición |
| Alumno de otro curso | **No** | 403, sin revelar si el documento existe |
| Administración | **Sí**, también borradores (por la vía de páginas) | Pero para el PDF **completo** hoy también se le exige matrícula (ver H-11) |
| Google (Firestore) | Almacena los bytes | Cifrado en reposo y en tránsito, según el proveedor |
| Google (Gemini) | **Solo si usas «Crear con IA»** | El PDF se envía a su API para extraer los temas (ver H-12) |

---

## 4. Lo que la aplicación no puede garantizar (dicho claro)

1. **Reenvío por parte de un alumno.** Quien tiene derecho a leer puede guardar
   el fichero y pasarlo a otra persona. Ningún visor web lo impide. Mitigación
   posible: **marca de agua con nombre y fecha** y **registro de descargas**.
2. **Fotografiar la pantalla.** Fuera del alcance de cualquier software.
3. **Un PDF malicioso.** Se comprueba que es un PDF y que sus bytes son los
   subidos (SHA-256), **no** que su contenido sea inocuo. No hay antivirus.
   Mitigación actual: solo administración puede subir ficheros.
4. **Un administrador.** La administración puede leer todo; es su función. Si
   se quiere separar, haría falta un rol «auditor» sin acceso a documentos.

---

## 5. Hallazgos

### 5.1 Corregidos hoy en esta rama

**H-1 · El asistente de IA fallaba con PDF de más de 1 MB** (importante)
Next.js corta los cuerpos de las *server actions* en **1 MB** por defecto, y el
asistente «Crear con IA» manda el PDF en una sola petición. Cualquier temario
de entre 1 y 4 MB recibía un **error 500** de la plataforma antes de llegar a
nuestro código. Comprobado con un PDF de 2 MB, antes y después:

| | Resultado |
| --- | --- |
| Sin la corrección | `500 Internal Server Error`, `Body exceeded 1 MB limit` |
| Con la corrección | La aplicación procesa el fichero y responde con su propio mensaje |

Arreglo: `serverActions.bodySizeLimit = "5mb"` en `next.config.ts`. **No
relaja nada de seguridad**: la aplicación sigue rechazando PDF de más de 4 MiB
y Vercel sigue cortando en 4,5 MB por petición.

**H-2 · Dependencia vulnerable** (media)
`@grpc/grpc-js` 1.9.16 (arrastrada por el SDK de Firebase en el navegador)
tiene un fallo de validación de certificados (GHSA-m9gg-hp2v-232j, CWE-295).
Arreglo: `overrides` a `^1.14.6` en `package.json`. `npm audit`: **4 altas →
0 vulnerabilidades**. Pruebas y compilación, repetidas: correctas.

### 5.2 Recomendados, sin tocar todavía

**H-3 · No hay CSP** (media). Ahora mismo hay `X-Frame-Options: DENY`,
`nosniff` y `Referrer-Policy`, pero ninguna `Content-Security-Policy`. Es la
red de seguridad que limita el daño de un XSS. Propuesta: empezar en modo
`report-only` y luego fijar `default-src 'self'`.

**H-4 · `/verificar/<código>` no tiene límite de peticiones** (media). Cada
intento con formato válido cuesta una lectura de Firestore. Un bucle puede
agotar la cuota diaria gratuita y **dejar la aplicación sin servicio**. Los
códigos no son adivinables (80 bits), así que el riesgo no es descubrir un
certificado, es el coste. Arreglo: el mismo limitador que ya usa la activación.

**H-5 · Las descargas de PDF no quedan registradas** (media-baja). Hoy no se
puede responder «¿quién abrió este documento?». Añadir un evento en `audits`
(`document_downloaded`) da trazabilidad y disuade del reenvío.

**H-6 · El limitador vive en memoria de cada instancia** (media en Vercel). En
un servidor propio funciona; en *serverless*, cada instancia cuenta por su
cuenta, así que el límite efectivo se multiplica por el número de instancias
activas. Si el despliegue es Vercel, conviene moverlo a un almacén compartido
o confiar de verdad en las cuotas de Firebase.

**H-7 · `/api/health` es público y ahora publica el estado de Gemini** (baja):
si hay clave, el modelo y si responde. No expone la clave, pero sí revela qué
IA usa la aplicación. Propuesta: dejar solo `ok`, `configured`, `ready`, `mode`
y mover el detalle de Gemini a una pantalla de administración.

**H-8 · Cabecera `X-Pdf-Sha256`** (baja): la huella del documento viaja al
navegador en cada lectura por páginas. No es un secreto, pero no hace falta.

**H-9 · Sin límite propio en el inicio de sesión** (aceptado): la contraseña la
comprueba Firebase Authentication, que ya aplica sus cuotas. El endpoint de
sesión no se puede usar como oráculo porque exige un token recién emitido.

**H-10 · HSTS** (por confirmar): la aplicación no la fija; Vercel suele
añadirla. No he podido comprobar las cabeceras de producción desde este
entorno (la salida a Internet está bloqueada). Ver §7.

**H-11 · Incoherencia de permisos para administración** (baja, funcional): la
ruta de páginas deja a la administración leer borradores, pero el PDF completo
exige matrícula, así que un administrador que sube un PDF no puede abrirlo con
el visor salvo que se matricule. Conviene decidir una regla única.

**H-12 · El asistente de IA envía el PDF a Google** (decisión, no fallo): al
usar «Crear con IA», el temario se manda a la API de Gemini para extraer los
temas. Si algún documento no debe salir de casa, **no se debe usar el
asistente con él**: eso queda a tu criterio y debe constar en la política
interna.

### 5.3 Pendientes que solo se pueden hacer fuera del código

- **Desactivar el alta libre de usuarios en Firebase Authentication**
  (Identity Platform → *Allow new user sign-ups*) o añadir una *blocking
  function* `beforeUserCreated`. Ya estaba anotado en `docs/SEGURIDAD.md` §5.2:
  sin esto, alguien podría ocupar un correo sintético y bloquear una
  importación. No impide entrar en la aplicación.
- **Alertas de presupuesto y cuotas** en Google Cloud y Vercel: la defensa más
  barata contra un abuso es enterarse el mismo día.
- **Rotar la clave de Gemini** si alguna vez se ha pegado en un chat, un correo
  o un documento. Se rota en Google AI Studio y se cambia solo en Vercel
  (entorno *Production* y *Preview*), sin tocar el código.

---

## 6. Verificación ejecutada hoy

| Comprobación | Resultado |
| --- | --- |
| `tsc --noEmit` | 0 errores |
| `eslint .` | 0 avisos |
| `vitest run` | **1 287 correctas**, 9 omitidas, 80 archivos |
| `next build` | compila |
| `npm audit --omit=dev` | **0 vulnerabilidades** (antes: 4 altas) |
| Recorrido real del asistente con un PDF de 2 MB | **antes**: 500 por límite de 1 MB · **después**: la aplicación procesa el fichero |
| Búsqueda de secretos en el repositorio | sin claves reales; `.env*` ignorado salvo `.env.example` |
| Pruebas de reglas de Firestore | 57 escritas, **0 ejecutadas** (el emulador no se puede descargar aquí) |

---

## 7. Cómo confirmar las cabeceras de producción (sin instalar nada)

Desde cualquier ordenador con `curl`, este comando no muestra contenido, solo
cabeceras:

```
curl -sI https://formacionus.vercel.app/login | findstr /i "strict-transport content-security x-frame"
```

(en Linux o macOS, cambia `findstr /i` por `grep -i`). Deben aparecer
`x-frame-options: DENY` y `strict-transport-security`; si falta la segunda, se
añade una cabecera `Strict-Transport-Security` en `next.config.ts`.

---

## 8. Orden recomendado

1. **H-1 y H-2** — ya hechos; fusionarlos devuelve el asistente a la vida y
   cierra las 4 alertas de dependencias.
2. **H-5 (registro de descargas)** y **H-4 (límite en `/verificar`)** — los dos
   con más efecto real por esfuerzo.
3. **H-3 (CSP)** en modo informe, sin romper nada.
4. **Marca de agua por persona** en el PDF servido: es lo único que disuade de
   verdad del reenvío. Es un bloque de trabajo aparte (generar el PDF con la
   marca en servidor o estamparla al vuelo).
5. **H-6, H-7, H-8, H-10, H-11** — limpieza, cuando haya hueco.
