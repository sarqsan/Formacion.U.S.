# Qué pasa con el temario cuando se usa «Crear con IA»

> **Actualizado el 25-10-2026.** La aplicación ya no manda el temario a Google:
> desde el cambio de proveedor (apartado 6) lo manda a **Groq**, cuyo acuerdo de
> servicio **prohíbe** usar lo enviado para entrenar modelos, en el tramo
> gratuito y en el de pago. Lo que sigue se conserva porque explica por qué se
> cambió y qué habría que asumir al volver a Gemini.

Respuesta corta: **Google no lo publica en ningún sitio**, pero **sí puede
usarlo para mejorar sus productos y sí puede leerlo una persona** si el proyecto
de Gemini está en la cuota **gratuita**. Con **facturación activa** (cuota de
pago) no se usa para mejorar sus productos, y además es **lo único permitido**
para una aplicación que se ofrece a usuarios de la Unión Europea.

Este documento transcribe lo que dicen los términos oficiales, con enlace, para
que no dependa de mi palabra.

---

## 1. Qué se envía exactamente y cuándo

Solo al pulsar «generar» en el asistente:

| Qué | Cómo viaja |
| --- | --- |
| El PDF del temario | En la propia petición, codificado en base64 (`inlineData`), a `generativelanguage.googleapis.com` |
| Las instrucciones (papel y tarea) | Texto en la misma petición |
| La respuesta | Vuelve a nuestro servidor y se guarda **en nuestro Firestore**, no en Google |

Detalles que importan:

- **No se usa la «File API»**: no dejamos un fichero alojado en Google. El PDF
  viaja en la petición y no queda como objeto en su almacenamiento.
- El asistente **solo se ejecuta cuando alguien de administración pulsa el
  botón**. El alumnado nunca habla con Gemini: recibe contenido ya guardado por
  nosotros.
- Si no se usa el asistente, **el PDF no sale de nuestra infraestructura**.

---

## 2. Lo que dicen los términos, textualmente

Fuente: [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms)
(vigentes desde el 23 de marzo de 2026).

### 2.1 Cuota gratuita («Unpaid Services»)

> «When you use Unpaid Services, including, for example, Google AI Studio and the
> unpaid quota on Gemini API, Google uses the content you submit to the Services
> and any generated responses to provide, improve, and develop Google products
> and services and machine learning technologies, including Google's enterprise
> features, products, and services»
>
> «To help with quality and improve our products, **human reviewers may read,
> annotate, and process your API input and output**. Google takes steps to
> protect your privacy as part of this process. This includes disconnecting this
> data from your Google Account, API key, and Cloud project before reviewers see
> or annotate it. **Do not submit sensitive, confidential, or personal
> information to the Unpaid Services.**»

Traducido: en la cuota gratuita, **sí** se usa para mejorar sus productos
(«machine learning technologies») y **sí** puede leerlo un revisor humano, aunque
lo vean sin saber de quién es. Google pide expresamente no enviar ahí
información confidencial.

### 2.2 Cuota de pago («Paid Services»)

> «When you use Paid Services, including, for example, the paid quota of the
> Gemini API, **Google doesn't use your prompts (including associated system
> instructions, cached content, and files such as images, videos, or documents)
> or responses to improve our products**, and will process your prompts and
> responses in accordance with the Data Processing Addendum for Products Where
> Google is a Data Processor. For Paid Services, Google logs prompts and
> responses for a limited period of time, solely for detecting and preventing
> violations of the Prohibited Use Policy […] and any required legal or
> regulatory disclosures.»

Traducido: con facturación, **no** se usa para mejorar sus productos (menciona
expresamente «files such as […] documents»), se trata como **encargado del
tratamiento** —con el contrato de protección de datos de Google— y solo se
registra un tiempo limitado para detectar abusos y por obligación legal.

Y cuando un proyecto es «de pago»:

> «Your access to Gemini API is a "Paid Service" **only when accessing the API
> through a Cloud Project associated with an active billing account**.»

Es decir: lo que decide no es la clave, es **si el proyecto de Google Cloud al
que pertenece la clave tiene una cuenta de facturación activa**.

### 2.3 La cláusula decisiva para España

En «Use Restrictions»:

> «**You may use only Paid Services when making API Clients available to users
> in the European Economic Area, Switzerland, or the United Kingdom.**»

Traducido: si la aplicación se ofrece a personas de la Unión Europea —es el
caso—, **solo se puede usar la cuota de pago**. No es una recomendación.

Además, para quien esté en la Unión Europea hay un alivio:

> «If you're in the European Economic Area, Switzerland, or the United Kingdom,
> the terms under "How Google uses Your Data" in "Paid Services" apply to all
> Services, including Google AI Studio and unpaid quota in the Gemini API, even
> though they are offered free of charge.»

Esto protege a quien **usa** la API desde Europa; la cláusula 2.3 sigue exigiendo
cuota de pago para **ofrecérsela a usuarios** europeos. Si hay duda, la lectura
prudente es la de 2.3: **facturación activa**.

---

## 3. ¿Lo publica en algún sitio? ¿Aparece en una búsqueda?

**No.** En los términos no hay ninguna cesión para publicar, y el contenido de
una API no se indexa ni se muestra al público. Lo que sí ocurre, según lo
transcrito:

| | Cuota gratuita | Cuota de pago |
| --- | --- | --- |
| ¿Se usa para mejorar sus modelos? | **Sí** | **No** |
| ¿Puede leerlo una persona? | **Sí** (revisores, sin saber de quién es) | Solo para detectar abusos |
| ¿Se publica en Internet? | **No** | **No** |
| ¿Cuánto tiempo se guarda? | Sin plazo indicado en los términos | «Tiempo limitado»; 55 días para la monitorización de abusos |
| ¿Dónde se guarda? | No se indica | «Puede almacenarse o cachearse en cualquier país donde Google tenga instalaciones» |

Dos matices que conviene saber aunque no afecten al temario:

- **La monitorización de abusos retiene 55 días** las peticiones, el contexto y
  las respuestas, en las dos cuotas ([documentación de abuse
  monitoring](https://ai.google.dev/gemini-api/docs/usage-policies)).
- **El contenido generado puede parecerse a otro**: los términos dicen que
  Google «may generate the same or similar content for others». Afecta a los
  temas y preguntas que produce la IA, no a tu PDF.

---

## 4. Qué hacer, en orden

1. **Comprueba si el proyecto tiene facturación activa.** En Google Cloud
   Console → *Facturación* → el proyecto de la clave; o en
   [aistudio.google.com/apikey](https://aistudio.google.com/apikey), que indica
   el proyecto de cada clave. Si no tiene cuenta de facturación, es cuota
   gratuita **y hay que cambiarlo**: por la cláusula 2.3 y porque el temario es
   material de trabajo.
2. **Al crear la cuenta de facturación, la cuota sigue siendo baratísima** para
   este uso: el asistente hace unas pocas llamadas por curso, con un PDF de
   decenas de páginas. No es un gasto que vaya a notarse; lo que cambia es el
   contrato.
3. **No subas al asistente documentos con datos personales** (nombre, DNI,
   dirección, salud). El asistente está para temarios. Si un temario los lleva,
   quítalos antes.
4. **Deja constancia interna** de que el temario se envía a Google para generar
   el curso, y de que con facturación activa no se usa para entrenar.
5. **Rotar la clave** si alguna vez se ha pegado en un chat o un correo. Se rota
   en AI Studio y se cambia solo en Vercel.

---

## 5. Qué NO cambia esto

- El PDF guardado en la aplicación sigue igual de protegido: fuera del asistente,
  **no sale de nuestra infraestructura**, y solo lo lee quien tiene matrícula
  activa (ver `docs/AUDITORIA-2026-10-25.md` §2).
- El alumnado nunca habla con Google. Recibe el contenido ya generado y
  revisado.
- El asistente no se ejecuta solo ni en segundo plano: siempre es una acción de
  administración.

---

## 6. Cambio de proveedor: Groq (25-10-2026)

### 6.1 Por qué

Se descartó activar facturación en Google. La alternativa elegida es Groq, que
tiene tramo gratuito y, a diferencia de Gemini, **no tiene la cláusula europea**
(«solo servicios de pago para usuarios del EEE»). Lo que se gana y lo que se
pierde:

| | Gemini (antes) | Groq (ahora) |
| --- | --- | --- |
| Coste | Cuota gratuita | Cuota gratuita |
| ¿Entrena con lo enviado? | **Sí** en la cuota gratuita | **No**: lo prohíbe el acuerdo de servicio |
| ¿Puede leerlo una persona? | Sí, revisores | Solo investigación de abusos (30 días); se puede apagar con retención cero |
| ¿Lee el PDF? | **Sí** | **No**: hay que extraer el texto |
| Dónde se procesa | EE. UU. | EE. UU. |
| Cuota | Diaria por modelo | 8 000 tokens/minuto y 200 000/día |
| Calidad de redacción | Mejor | Algo menor: más revisión manual |

Fuente del compromiso de Groq: *Groq Services Agreement* §4.2 — «Groq is not
permitted to use Inputs or Outputs for training or fine-tuning any AI Model
Services or other models» — y `console.groq.com/docs/your-data`, que añade que
por defecto no retiene las peticiones y que **cualquier** cuenta puede activar
retención cero en *Data Controls*.

### 6.2 Cómo funciona ahora, por dentro

1. **Extracción de texto.** El servidor abre el PDF y saca el texto de cada
   página con su número (`src/server/ai/text.ts`). Un escaneo sin letras se
   rechaza con un mensaje claro: no hay nada que leer.
2. **Troceado y espera.** El temario se manda por tandas de unas 6 páginas,
   esperando lo necesario para no pasar de 8 000 tokens por minuto
   (`src/server/ai/pacing.ts`). Un curso tarda **minutos**, no segundos.
3. **Menos documento por llamada.** Las pantallas y los cuestionarios de un
   tema envían **solo las páginas de ese tema**, y el examen final envía el
   resumen ya generado. Gasta menos y cita mejor.
4. **Validación intacta.** El JSON que devuelve Groq pasa por los mismos
   controles que el de Gemini: si no cumple, no se escribe nada.

### 6.3 Cómo se enciende y cómo se apaga

| Variable | Efecto |
| --- | --- |
| `GROQ_API_KEY` | La clave. **Solo en el servidor**: nunca en el chat, ni en un log, ni en el código. |
| `AI_PROVIDER` | `groq` o `gemini`. Si no está puesta: **Groq si existe `GROQ_API_KEY`**; Gemini si no. |
| `GROQ_MODEL` | Por defecto `openai/gpt-oss-120b`. |
| `GROQ_TPM` | Tokens por minuto del plan. Por defecto 8 000 (tramo gratuito). |
| `GROQ_TIMEOUT_MS` | Tiempo máximo por llamada. Por defecto 90 000 ms. |

Para volver a Gemini: `AI_PROVIDER=gemini` (y la clave de Google sigue donde
estaba). No hay que tocar código ni desplegar otra rama.

**Si la pantalla dice «Conexión con Google Gemini»**: mira la línea de
diagnóstico que hay debajo de la tarjeta. Dice qué claves ve el servidor, sin
mostrar su valor. Si `Groq: no`, la variable no ha llegado al entorno de
producción: en Vercel hay que marcarla también en **Production**, no solo en
Preview/Development, y volver a desplegar. `/api/health` publica lo mismo en
`ai.diagnostics`.

### 6.4 Límites que hay que conocer

- **8 000 tokens por minuto.** Es el límite que manda de verdad, mucho antes que
  el tamaño del fichero. Medido con el ajuste actual (páginas de ~2 500
  caracteres):

  | Páginas | Tandas | Tiempo estimado | Resultado |
  | --- | --- | --- | --- |
  | 10 | 1 | ~60 s | entra |
  | 20 | 2 | ~114 s | entra |
  | 30 | 3 | ~171 s | entra |
  | 40 | 4 | ~228 s | entra (justo) |
  | 50 | 5 | ~285 s | se niega |
  | 120 | 12 | ~11 min | se niega |

  Por encima de **260 s** estimados la aplicación se niega **antes de empezar**
  (`AI_DOCUMENT_TOO_LONG`) y pide dividir el PDF: una función de Vercel corta a
  los 300 s y el resto del margen es para la subida y el guardado.
- **200 000 tokens al día.** Salen unos **6-8 cursos diarios**. Si se agota, la
  pantalla lo dice y el borrador queda intacto.
- **PDF escaneado: no vale.** No hay OCR gratuito; haría falta otro servicio.
- **Tamaño del fichero, por sitio:** el asistente admite **4 MiB** en una sola
  petición (el despliegue corta los cuerpos a 4,5 MB y el formulario va entero);
  el editor admite **8 MiB** porque sube el PDF por partes de 768 KiB. Un temario
  de texto de 30 páginas suele ocupar 150-800 KiB: el tamaño casi nunca es el
  problema, el texto sí.
- **Todo se procesa en EE. UU.** Para temarios sin datos personales no hay
  problema; con datos de alumnos habría que firmar el acuerdo de tratamiento y
  valorar la transferencia internacional.

### 6.5 Comprobarlo sin gastar cuota

`/api/health` publica `ai.provider`, el modelo y si la cuenta responde (una
llamada al catálogo de modelos, sin tokens). La pantalla del asistente tiene el
botón «Comprobar conexión» con el mismo resultado. Eso confirma la clave, **no**
que la generación funcione: eso exige generar un curso de verdad.
