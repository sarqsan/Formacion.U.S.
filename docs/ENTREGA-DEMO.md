# Versión demostrable — recorrido, límites y guion

**Fecha:** 21 de octubre de 2026
**Estado:** se puede enseñar y recorrer de principio a fin con datos inventados.
**No** es un sistema conectado: ver «Qué es real y qué no» antes de presentarlo.

---

## 1. Arrancar la demostración

```bash
npm install                    # o npm ci
DEMO_MODE=1 npm run dev        # http://localhost:3000
```

En la portada aparece una franja amarilla **«Modo demostración»** en todas las
páginas mientras esté activo, con un botón para reiniciar los datos. Sin
`DEMO_MODE=1` la aplicación no usa ningún dato ficticio: exige Firebase
configurado y, si no lo está, explica qué falta en vez de romperse.

### Cuentas de demostración (inventadas)

| Usuario | Rol de cuenta | Rol de persona | Para qué sirve |
| --- | --- | --- | --- |
| `rol1.ejemplo` | Alumno | ROL 1 | Recorrido completo del alumno |
| `rol2.ejemplo` | Alumno | ROL 2 | Ya tiene el primer tema superado: sirve para enseñar el progreso |
| `admin.demo` | Administración | ROL 1 | Panel de administración |
| `rol2.pendiente` | Alumno (pendiente de activación) | ROL 2 | Enseñar el estado «importada pero sin activar»; no puede entrar |

No hay contraseñas: en `/login` se elige un perfil y se entra. Los correos del
contenido usan el dominio reservado `example.invalid` y los nombres son
«Ejemplo», «Muestra» o «Sintético».

### Contenido

- **Curso 1 — «Prevención de riesgos en el puesto de trabajo»** (publicado, v1):
  2 temas obligatorios, 5 pantallas, 4 preguntas de tema y 3 de examen final.
- **Curso 2 — «Protección de datos y confidencialidad»** (publicado, v1): 1 tema,
  2 pantallas, 1 pregunta de tema y 2 de examen final. Además tiene un **borrador
  v2** con un tema nuevo, listo para publicar delante de la audiencia.

Todo el texto es de relleno, genérico y sin procedimientos reales: no hay
documentos, personas ni información sensible.

---

## 2. Guion del alumno (5 minutos)

1. `/login` → «Alumno de demostración (ROL 1)».
2. `/panel`: un único curso (solo aparece aquel en el que hay matrícula), 0 % de
   progreso y «Siguiente: Identificación de riesgos».
3. Abrir el curso: temario con estados (leído / pendiente / bloqueado) y examen
   final bloqueado.
4. «Estudiar» → pantalla 1 de 3. Pulsar **«Leído, continuar»** tres veces. Se
   puede comprobar que una pantalla posterior no se abre antes de tiempo (el
   servidor la rechaza).
5. Al terminar la lectura, el cuestionario se abre solo. Responder mal a
   propósito: el resultado dice cuántas han fallado y **no** revela la correcta.
   Repetir hasta acertar; los intentos se acumulan.
6. Superar el segundo tema: el examen final pasa a «Disponible».
7. Aprobar el examen: el curso queda al 100 % y «Completado».

Atajo para enseñar el progreso sin repetir todo: entrar como `rol2.ejemplo`
(primer tema ya superado).

## 3. Guion de administración (5 minutos)

1. `/login` → «Administración de demostración». El panel muestra cuentas,
   cursos publicados, borradores, matrículas, intentos y cursos completados.
2. **Matrículas**: matricular a `rol1.ejemplo` en «Protección de datos». Se puede
   comprobar en otra pestaña que el curso aparece en su panel. Revocar y
   reactivar: el progreso se conserva.
3. **Cursos**: abrir «Protección de datos» → versión 2 (borrador) → cambiar el
   título, el de un tema y las pantallas → **Guardar borrador** → **Publicar
   versión 2**. Al publicar, quien tenía el curso empezado lo repite desde cero
   (se ve en `/panel`, vuelve a «Versión 2» y 0 %).
4. **Progreso**: por cada matrícula, temas superados, pendientes y últimos
   intentos con fecha, aciertos y resultado.
5. **Importar desde Excel**: descargar el fichero de ejemplo, subirlo y ver la
   vista previa: 4 filas, 1 correcta, 2 duplicadas (ya existen esas cuentas), 1
   con rol no admitido. La confirmación está desactivada y se explica por qué.

---

## 4. Qué es real y qué no

**Lógica real (el mismo código que se usará con Firebase):**

- Corrección de cuestionarios y exámenes en servidor, con claves separadas del
  contenido público (`gradeAttempt`, `submitAssessment`).
- Desbloqueo del examen final por temas obligatorios y reinicio de progreso al
  publicar una versión nueva (`course-progress`, `progress-loader`).
- Lectura en orden: el servidor rechaza saltos de pantalla o página
  (`assertCanViewPage`, `recordPageViewed`).
- Matrículas: sin matrícula activa no hay acceso; matricular y revocar son
  acciones de administración (`assertCourseAccess`, `enrollStudent`).
- Autoría: validación del contenido, guardado de borrador, publicación con
  numeración consecutiva e inmutabilidad de lo publicado.
- Vista previa de importación con el lector real de `.xlsx` y las reglas de
  usuarios/duplicados.
- Todas estas piezas están cubiertas por pruebas: **14 pruebas** de la
  demostración (`tests/demo/`) más las del portal (`tests/server/portal.test.ts`),
  que dejan la suite en **547 pruebas** (4 omitidas: las de integración con el
  emulador).

**Administración de cuentas (bloque 09).** Se puede deshabilitar, reactivar y
reemitir el código de activación de una cuenta **de la demostración**. Lo que se
ve es real dentro del proceso: la cuenta deshabilitada pierde la sesión en la
petición siguiente, el código anterior deja de valer y todo queda en la
auditoría. Lo que **no** ocurre: no se habla con Firebase Auth, así que la
revocación de refresh tokens y la propagación de claims son un registro local,
no una llamada real.

**Historial de formación (bloque 10).** Al publicar una versión nueva de un
curso, lo cursado en la versión anterior se archiva y el alumno empieza de cero.
Ese archivo se lee: el panel muestra **Historial de formación** con la versión,
el resultado (completado o incompleto), los temas superados, el examen final y la
fecha, y la ficha de administración muestra el mismo registro de cada persona.
Antes de este bloque el archivo se escribía y no se leía; en la demostración
incluso se descartaba. Lo que se ve ahora sí ocurre dentro del proceso; lo que
**no** se ha ejecutado es la consulta contra Firestore real (sin emulador).

**Simulado (y así se indica en pantalla):**

- El almacenamiento: un diccionario en memoria del proceso. Al reiniciar el
  servidor se vuelve al estado inicial y no hay persistencia ni concurrencia
  real.
- La sesión: una cookie con el uid de una cuenta ficticia. No hay contraseña,
  token firmado ni verificación de Firebase.
- El «PDF»: la **subida** se ejecuta de verdad en la demostración (se parte en
  trozos de 768 KiB, se verifica el SHA-256 y el documento queda activo o se
  cancela), y la **lectura** también: el alumnado abre el PDF completo con el
  visor del navegador. Los ficheros de la demostración los **genera el propio
  servidor al arrancar** (un PDF 1.4 mínimo, con tabla `xref` real), así que el
  repositorio no guarda binarios. Los fragmentos viven en la memoria del proceso
  y desaparecen al reiniciar.
- La creación de cuentas tras la importación: no se ejecuta.

**Pendiente de Firebase o servicios externos (no se declara conectado):**

| Función | Qué falta |
| --- | --- |
| Inicio de sesión y activación reales | Proyecto Firebase con Authentication y credenciales de servicio |
| Persistencia de cursos, matrículas, progreso e intentos | Firestore; las reglas están escritas pero **0 de 41 pruebas ejecutadas** |
| Persistencia de PDF y cuota real | Firestore + emulador para validar transacciones y reservas; en la demo los fragmentos se pierden al reiniciar |
| PDF en Firestore real | Emulador para validar transacciones, reservas y lectura de fragmentos; en la demo los ficheros se generan en memoria |
| Creación de cuentas al confirmar la importación | Firebase Authentication (no disponible en el plan gratuito sin proyecto) |
| Copia de seguridad ensayada de verdad | Emulador; el ensayo automático está bloqueado |

Nada de esto se presenta como funcionando: `/estado` muestra esta misma tabla
dentro de la aplicación y la franja de demostración está siempre visible.

---

## 5. Cómo se ha comprobado

| Comprobación | Comando | Resultado |
| --- | --- | --- |
| Servidor de demostración | `DEMO_MODE=1 npm run dev` | arranca en 3000 |
| Rutas sin sesión | `curl` a 10 rutas | 7 responden 200 (`/`, `/login`, `/activar`, `/estado`, la plantilla `.xlsx`, `/api/health`) y las 3 protegidas responden 307 a `/login` |
| Rutas de alumno | `curl` con cookie de alumno a 6 rutas | 5 responden 200; `/admin` responde 307 al panel |
| Rutas de administración | `curl` con cookie de administrador a 6 rutas | 6 responden 200 |
| Recorrido por HTTP (acciones reales) | `npm run check:demo` | **PASSED** (19 comprobaciones): reinicio, lectura de 3 pantallas, matrícula, publicación y control de acceso |
| Servicios de la demostración | `npx vitest run tests/demo` | **14 pruebas PASSED** |
| Cadena completa | `npm run verify` | tipado, lint, **547 pruebas** y build en verde |

`npm run check:demo` necesita el servidor de demostración arrancado; envía los
formularios del servidor tal cual (sin JavaScript) y comprueba las redirecciones.

---

## 6. Limitaciones conocidas de la versión demostrable

- Los datos se pierden al reiniciar; el botón «Reiniciar datos» vuelve al estado
  inicial en cualquier momento.
- Solo se editan títulos, orden de temas y pantallas de un **borrador**. El
  editor de **preguntas** (crear, borrar, cambiar la correcta) no está: hacerlo
  a medias dejaría claves de corrección desincronizadas.
- No se pueden crear temas nuevos desde la interfaz; el borrador v2 trae uno ya
  preparado para demostrar la publicación.
- Un administrador no puede «entrar como alumno» a un curso: se le redirige al
  panel de contenido (es una decisión de permisos, no un fallo).
- La subida de PDF funciona en el editor del borrador (en memoria y sin
  persistencia); lo que no hay todavía es la lectura del PDF por páginas.
- La accesibilidad se ha revisado a mano (foco visible, etiquetas, contraste);
  falta una pasada con lector de pantalla.

## 7. Imprescindible para la demostración de la semana próxima

1. **Decidir el guion**: alumno (5 min) o alumno + administración (10 min). El
   recorrido de administración es el que mejor explica el propósito.
2. **Proyecto Firebase propio** (si se quiere enseñar el login real): crear el
   proyecto, habilitar Authentication, desplegar reglas e índices y rellenar
   `.env.local`. Sin eso, la demo funciona igual con `DEMO_MODE=1`.
3. **Ejecutar las pruebas bloqueadas** en un equipo con acceso al emulador
   (`npm run test:rules`, `npm run test:firestore`, `npm run rehearse:backup` →
   ver `docs/ENTORNO-PRUEBAS.md`). Es lo que separa «interfaz demostrable» de
   «sistema verificado».
4. **Ensayo cronometrado** del guion con la pantalla real, en móvil y en
   ordenador, para ajustar textos.
5. **Decidir si se muestran datos reales**: hoy no hay ninguno cargado y no debe
   haberlos sin autorización expresa.

---

## 8. Hoja de ruta: «Desidentificar y preparar temario» (no implementado)

Función pedida para más adelante. **No se ha empezado** y no debe retrasar la
demostración. Alcance previsto:

1. **Subida**: el administrador sube un PDF al entorno de preparación (nunca
   directamente al curso publicado).
2. **Extracción**: texto e imágenes por página; OCR solo si el PDF no tiene capa
   de texto, con aviso de calidad.
3. **Detección de referencias identificativas**: nombres propios, cargos, unidades,
   sellos, firmas, números de expediente, metadatos del PDF y marcas de agua.
4. **Transformación**: sustitución de entidades por marcadores genéricos
   (conservando coherencia dentro del documento), recorte o difuminado de
   imágenes y eliminación de metadatos.
5. **Revisión**: comparar original y resultado página a página, con lista de
   cambios y avisos de lo que no se ha podido verificar.
6. **Aprobación explícita** del administrador y registro en auditoría; solo
   entonces se genera el material definitivo y se publica como versión.
7. **Pruebas imprescindibles**: ningún dato identificativo sobrevive al paso 4 en
   un conjunto de PDF de muestra; el original nunca se publica; todo cambio queda
   auditado con quién y cuándo.

Requisito técnico: esta función necesita un **servicio de OCR/detección**, que o
bien se ejecuta en local (más trabajo, sin coste) o bien exige un servicio
externo (coste y envío de documentos fuera del entorno). Cualquiera de las dos
opciones se decidirá con autorización explícita, y ninguna es necesaria para la
demostración.
