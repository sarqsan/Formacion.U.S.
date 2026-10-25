# Crear cursos desde Excel y desde la guía en PDF

> **Estado: propuesta, sin desarrollar.** Escrito el 25 de octubre de 2026 tras
> revisar el código existente. Nada de este documento está implementado: lo que
> dice «hoy» es lo que hay; lo que dice «propuesta» es lo que se haría.

Este documento responde a una petición concreta: *subir uno o varios Excel y la
guía en PDF para que el curso se monte solo, con un test al final de cada tema,
sin poder pasar al siguiente hasta acertarlo entero, y con datos de cuántas
veces lo intenta cada persona y cuánto tiempo dedica*.

---

## 1. Cómo se crea un curso hoy (verificado en el código)

No hay ninguna importación de cursos. El recorrido es manual y en cinco sitios
distintos:

| Paso | Dónde | Qué hace |
| --- | --- | --- |
| 1 | `/admin/cursos/nuevo` | Crea solo la ficha: identificador, título y descripción. Sin contenido y sin publicar. |
| 2 | `/admin/cursos/<id>` | «Preparar la siguiente versión en borrador» → abre la versión 1. |
| 3 | `/admin/cursos/<id>/editar` → Temas | Un tema a la vez: identificador, título y casilla «obligatorio». |
| 4 | Misma pantalla → Documentos PDF | Sube el PDF **por tema**, troceado en Firestore y verificado con SHA-256. **El número de páginas lo declara el administrador**: la interfaz avisa de que el sistema *no interpreta el PDF*. |
| 5 | Misma pantalla → Cuestionarios | Preguntas a mano: enunciado, tipo (única/múltiple), opciones y cuál es la correcta. Una batería por tema y una de examen final. |
| 6 | Ficha del curso | «Publicar», solo si hay temas, un obligatorio con cuestionario, examen final con preguntas y todos los PDF completos. Lo publicado es inmutable; cambiarlo exige versión nueva. |
| 7 | `/admin/matriculas` | Matriculación individual o en bloque. |

El único Excel que existe es el de **personas** (rol + apellido), para crear
cuentas. No toca cursos.

**Límites actuales que condicionan el diseño** (`src/domain/storage/pdf-chunks.ts`):

- 8 MiB por PDF, 768 KiB por fragmento, hasta 5000 páginas declaradas;
- presupuesto total de PDF 512 MiB por defecto, con techo de 1 GiB menos reserva;
- la versión de curso tampoco puede pasar de ~800 KiB de documento.

---

## 2. Lo que ya está resuelto (no hay que construirlo)

La parte de evaluación que se pide **ya funciona así**:

- **todo o nada**: un tema o el examen final solo se supera si **todas** las
  respuestas son correctas en el mismo intento
  (`src/domain/assessments/scoring.ts`); no hay nota parcial aprobatoria;
- **intentos ilimitados**: fallar no resta, no bloquea y no penaliza; cada
  intento queda registrado;
- **antes del test hay que leer el tema completo** (se comprueba en servidor);
- **el examen final está cerrado** hasta aprobar todos los temas obligatorios;
- **las respuestas correctas nunca viajan al navegador**: se guardan en
  `answerKeys`, solo-servidor, y se corrigen en el servidor.

Datos ya guardados por intento (`attempts`): quién, curso, versión, tema, qué
opciones marcó, aprobado, aciertos, total, porcentaje, fecha y que lo corrigió el
servidor.

---

## 3. Los tres huecos reales

### 3.1 La secuencia entre temas es solo visual

`/cursos/<id>` pinta los temas no alcanzados como «bloqueado», pero **el
servidor no lo impide**: con el enlace directo, alguien puede abrir el PDF del
tema 3 y responder su test sin haber aprobado el 1. El desbloqueo del examen
final sí es real; el de los temas, no.

### 3.2 No se mide el tiempo

No se guarda nada de tiempo: solo la fecha de cada intento y `updatedAt` del
documento de progreso. Con los datos actuales se puede calcular «días entre el
primer y el último intento», no «cuánto tiempo dedicó a este tema».

### 3.3 La aplicación no lee los PDF

Cero extracción de texto, cero detección de páginas, cero OCR. De ahí que pida el
número de páginas a mano. Todo lo de «sacar los temas de la guía» es módulo
nuevo.

---

## 4. Decisiones que propongo (y por qué)

Tomadas por defecto para poder avanzar; se cambian si dices lo contrario.

| Tema | Propuesta | Motivo |
| --- | --- | --- |
| **Excel** | **Dos hojas** en un mismo fichero: `Temas` y `Preguntas`. Formato fijo y plantilla descargable. | Una sola subida deja el curso completo; el formato fijo permite señalar el error por fila, igual que la importación de personas. |
| **Qué hace el Excel** | Rellena un **borrador**. Nunca publica ni sobrescribe lo publicado. | Mismo principio que ya rige el editor: publicar es una decisión aparte. |
| **Guía en PDF** | **Un PDF por tema**, cortado por la aplicación tras proponer un índice que el administrador corrige. | El progreso, el test y el informe son *por tema*; un único fichero con rangos deja el visor y el progreso a medias. |
| **Número de páginas** | Lo calcula la aplicación al cortar el PDF. | Hoy, un número mal declarado descuadra el progreso sin avisar. |
| **IA para las preguntas** | **No por ahora.** Las preguntas entran por Excel o en el panel. | Un apto mal dado en formación oficial es un daño real; además enviar la guía fuera exige autorización (ADR-019). |
| **Tiempo** | «Tiempo activo estimado»: solo con la pestaña visible, sin contar pausas de más de 2 minutos, con tope por pantalla. Se guarda al pulsar «Leído, continuar», una escritura que ya se hace. | No encarece nada y es honesto: nadie puede saber si alguien está mirando. Se dirá «estimado» en pantalla. |
| **Secuencia** | Se impone **en servidor**: el tema *n+1* no se abre ni se evalúa sin el *n* aprobado. Aplicado a la versión publicada en el momento de la matrícula. | Es la regla que se pide; si solo se pinta, no existe. |
| **Informe** | Pantalla y CSV **por persona y por tema**: intentos, tiempo estimado, primer y último intento y las preguntas que más se fallan. | Los datos ya se guardan; solo hay que agregarlos. |

---

## 5. Formato de Excel propuesto

### Hoja `Temas`

| curso | tema_id | titulo | orden | obligatorio | pdf |
| --- | --- | --- | --- | --- | --- |
| prevencion-riesgos | riesgos | Qué es un riesgo laboral | 1 | sí | guia-01-riesgos.pdf |
| prevencion-riesgos | emergencias | Actuación en emergencias | 2 | sí | guia-02-emergencias.pdf |

- `tema_id`: minúsculas, números y guiones (la misma regla que ya usa el editor).
- `orden`: 1..n, sin huecos.
- `pdf`: nombre de un fichero subido en el mismo envío (opcional; también se
  puede subir después desde el panel).

### Hoja `Preguntas`

| tema_id | pregunta_id | enunciado | tipo | opcion_a | opcion_b | opcion_c | opcion_d | correctas |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| riesgos | q-riesgos-1 | ¿Qué es un riesgo laboral? | unica | La probabilidad de sufrir un daño | La fuente del peligro | Un accidente ya ocurrido | | a |
| riesgos | q-riesgos-2 | ¿Qué hacer al detectar un riesgo grave? | multiple | Comunicarlo | Parar la tarea | Corregirlo uno mismo | | a,b |

- `tema_id` = `final` para el examen final.
- `tipo`: `unica` o `multiple`.
- `correctas`: letras separadas por comas. En `unica`, exactamente una.

### Cómo se sube (mismo patrón que la importación de personas)

1. **Subir** el `.xlsx` (y los PDF, si van en el mismo envío).
2. **Vista previa**: tabla con cada fila, los errores marcados en su fila
   (identificador repetido, orden con hueco, pregunta sin respuesta correcta,
   PDF que falta…) y un resumen de lo que se creará.
3. **Confirmar**: se escribe el borrador. Si algo falla, no se escribe nada.
4. **Revisar en el editor** y **publicar** aparte, como hoy.

---

## 6. Hoja de ruta, por orden de entrega

| # | Entrega | Tamaño | Depende de |
| --- | --- | --- | --- |
| 1 | **Excel del temario → borrador**, con vista previa por filas y plantilla descargable. | 1 sesión | Formato acordado |
| 2 | **Excel del banco de preguntas → cuestionarios** (un test por tema + examen final), validando opciones y respuestas correctas. | 1 sesión | 1 |
| 3 | **Guía en PDF → propuesta de temas**: extraer texto, detectar encabezados, pantalla para corregir el índice y cortar en un PDF por tema calculando las páginas. Aviso explícito si el PDF es un escaneo. | 1–2 sesiones | — |
| 4 | **Secuencia real en servidor** entre temas, con sus pruebas. | 1 sesión | — |
| 5 | **Tiempo activo por pantalla y por tema**, con aviso de «estimado» y tope de inactividad. | 1 sesión | — |
| 6 | **Informe por persona y por tema** en pantalla y en CSV, incluidas las preguntas más falladas. | 1 sesión | 5 |
| 7 | *Opcional:* preguntas propuestas por IA, **solo como borrador a revisar**. | 2 sesiones + coste | Autorización |
| 8 | *Opcional:* desglose de tiempo como «recibo de formación» junto al certificado. | 1 sesión | 5 |

Orden recomendado: **1 y 2** (curso completo desde Excel, sin IA ni sorpresas),
luego **3** (la guía) y en paralelo **4**, que es pequeña pero cambia una regla
del sistema y merece su propia prueba.

---

## 7. Límites que conviene decir antes

- **PDF escaneado**: sin capa de texto no hay nada que extraer. Hace falta OCR,
  que hoy no existe; se detectaría y se diría, no se simularía.
- **8 MiB por PDF** y 512 MiB de presupuesto: una guía grande con imágenes hay
  que comprimirla o revisar el presupuesto con cuidado.
- **La lectura pantalla a pantalla es un control de la aplicación**, no una
  protección del fichero: el visor del navegador enseña el PDF completo. El
  progreso se registra página a página, pero nadie impide ir rápido.
- **El tiempo es una estimación.** No se puede saber si la persona está mirando
  la pantalla. Se presentará como «tiempo estimado», nunca como control horario.

---

## 8. Defecto encontrado por el camino (pendiente, pequeño)

En `/cursos/<id>`, un tema **sin ningún documento** rompe el botón «Estudiar»:
accede a `topic.documents[0]` sin comprobar que exista. Hoy no ocurre porque todo
se crea a mano; con importación automática pasará. Se arregla en el mismo paso
que la importación (un tema debe tener documento, o el botón no se pinta).
