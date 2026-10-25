# Qué pasa con el temario cuando se usa «Crear con IA»

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
