/**
 * Recorrido real por HTTP de la demostración: envía los formularios del
 * servidor (progressive enhancement, sin JavaScript) y comprueba el resultado.
 *
 *   node scripts/demo-smoke.mjs [http://127.0.0.1:3000]
 */

import { createHash } from "node:crypto";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const COURSE = "curso-prevencion-riesgos";

function cookieFor(uid) {
  // El origen es obligatorio: Next rechaza las acciones de servidor si no
  // coincide con el host (protección CSRF).
  return { cookie: `formacion_demo=${uid}`, origin: BASE };
}

/** Deshace las entidades HTML que un navegador interpretaría al enviar. */
function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Extrae los campos de cada formulario del HTML, incluido el input oculto
 * `$ACTION_ID_…` que Next usa para las acciones de servidor sin JavaScript.
 */
function forms(html) {
  const result = [];
  const formRegex = /<form[^>]*>([\s\S]*?)<\/form>/g;
  let match;
  while ((match = formRegex.exec(html)) !== null) {
    const inner = match[1];
    const fields = {};
    const inputRegex = /<input\b[^>]*>/g;
    let input;
    while ((input = inputRegex.exec(inner)) !== null) {
      const tag = input[0];
      const name = /name="([^"]+)"/.exec(tag)?.[1];
      if (!name) continue;

      // Un navegador no envía una casilla sin marcar. El guion debe imitarlo:
      // si no, un guardado «real» borraría las respuestas correctas.
      const isCheckbox = /type="(checkbox|radio)"/.test(tag);
      if (isCheckbox) {
        if (/\schecked(=|\s|>)/.test(tag)) {
          fields[name] = /value="([^"]*)"/.exec(tag)?.[1] ?? "on";
        }
        continue;
      }

      // Un navegador **descodifica** las entidades del HTML antes de enviar el
      // campo. Hace falta para los formularios con estado (`useActionState`),
      // cuyos campos ocultos llevan JSON con comillas escapadas; sin esto el
      // servidor recibe `&quot;` y responde 400.
      fields[name] = decodeEntities(/value="([^"]*)"/.exec(tag)?.[1] ?? "");
    }

    // Los desplegables también viajan en el formulario: se envía la opción
    // marcada como `selected` o, si ninguna lo está, la primera (lo que haría
    // el navegador).
    const selectRegex = /<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g;
    let select;
    while ((select = selectRegex.exec(inner)) !== null) {
      const [, name, options] = select;
      const optionRegex = /<option\b([^>]*)>/g;
      const values = [];
      let option;
      while ((option = optionRegex.exec(options)) !== null) {
        const attrs = option[1];
        values.push({
          value: /value="([^"]*)"/.exec(attrs)?.[1] ?? "",
          selected: /\sselected(=|\s|$)/.test(attrs),
        });
      }
      const chosen = values.find((item) => item.selected) ?? values[0];
      if (chosen) fields[name] = chosen.value;
    }

    result.push({ fields, inner });
  }
  return result;
}

async function get(path, headers) {
  const response = await fetch(`${BASE}${path}`, { headers, redirect: "manual" });
  return { status: response.status, location: response.headers.get("location"), html: await response.text() };
}

async function getFile(path, headers) {
  const response = await fetch(`${BASE}${path}`, { headers, redirect: "manual" });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    disposition: response.headers.get("content-disposition"),
    body,
  };
}

async function postForm(path, headers, fields) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  });
  const text = await response.text();
  return { status: response.status, location: response.headers.get("location"), html: text };
}

function assert(condition, message) {
  if (!condition) {
    console.error(`✖ ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${message}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Lectura en orden
// ---------------------------------------------------------------------------

// Estado limpio: se usa el botón «Reiniciar datos» de la propia cabecera.
const home = await get("/", cookieFor("demo-alumno-1"));
const resetForm = forms(home.html).find((form) => form.inner.includes("Reiniciar datos"));
assert(Boolean(resetForm), "encuentra el botón de reinicio de la demostración");
if (resetForm) {
  const result = await postForm("/", cookieFor("demo-alumno-1"), resetForm.fields);
  assert(result.status === 303, `reinicia los datos de la demostración (HTTP ${result.status})`);
}

const learner = cookieFor("demo-alumno-1");
let page = "/cursos/" + COURSE + "/documentos/doc-riesgos";
const doc = await get(page, learner);
assert(doc.status === 200, "abre el documento de demostración");

const readForm = forms(doc.html).find((form) => form.fields.page);
assert(Boolean(readForm), "encuentra el formulario de lectura");
if (!readForm) process.exit(1);

let current = { ...readForm.fields };

for (let step = 1; step <= 3; step += 1) {
  const result = await postForm(page, learner, current);
  assert(result.status === 303 || result.status === 200, `lee la pantalla ${step} (HTTP ${result.status})`);
  if (result.location) page = result.location;
  if (step < 3) {
    const next = await get(page, learner);
    const form = forms(next.html).find((item) => item.fields.page);
    if (!form) {
      assert(false, `no encuentra el formulario en ${page}`);
      break;
    }
    current = { ...form.fields };
  }
}

const topicPage = await get(`/cursos/${COURSE}/temas/riesgos?lectura=completa`, learner);
assert(
  topicPage.html.includes("Lectura completada") || topicPage.html.includes("Corregir intento"),
  "el cuestionario se abre al terminar la lectura",
);

// ---------------------------------------------------------------------------
// 1 bis. Visor PDF privado (bloque 07): la puerta del alumnado
// ---------------------------------------------------------------------------

const pdfPage = await get(`/cursos/${COURSE}/documentos/doc-riesgos`, learner);
assert(
  pdfPage.html.includes(`/api/documents/doc-riesgos/file`),
  "la página del documento ofrece abrir el PDF con el visor del navegador",
);

const seededPdf = await getFile("/api/documents/doc-riesgos/file", learner);
assert(seededPdf.status === 200, `el alumno matriculado descarga el PDF (HTTP ${seededPdf.status})`);
assert(
  seededPdf.contentType?.includes("application/pdf"),
  `el PDF se sirve como application/pdf (${seededPdf.contentType})`,
);
assert(
  seededPdf.body.subarray(0, 5).toString("latin1") === "%PDF-",
  "lo descargado es un PDF completo, no un fragmento",
);
assert(
  seededPdf.cacheControl?.includes("no-store") && seededPdf.cacheControl?.includes("private"),
  `la respuesta privada no se cachea (${seededPdf.cacheControl})`,
);
assert(
  seededPdf.disposition?.startsWith("inline"),
  `la disposición permite abrirlo en el navegador (${seededPdf.disposition})`,
);
assert(
  !seededPdf.body.toString("latin1").includes("pdfChunks"),
  "la respuesta no expone rutas ni metadatos internos del almacén",
);

const anonymousPdf = await getFile("/api/documents/doc-riesgos/file", {});
assert(anonymousPdf.status === 401, `sin sesión no hay PDF (HTTP ${anonymousPdf.status})`);

const pendingPdf = await getFile("/api/documents/doc-riesgos/file", cookieFor("demo-pendiente"));
assert(
  pendingPdf.status === 401 || pendingPdf.status === 403,
  `una cuenta pendiente no descarga el PDF (HTTP ${pendingPdf.status})`,
);

// Curso en el que este alumno todavía no está matriculado.
const otherCoursePdf = await getFile("/api/documents/doc-datos/file", learner);
assert(
  otherCoursePdf.status === 403,
  `sin matrícula el PDF de otro curso queda cerrado (HTTP ${otherCoursePdf.status})`,
);

const forgedPdf = await getFile("/api/documents/no-existe/file", learner);
assert(forgedPdf.status === 404, `un identificador inventado no devuelve nada (HTTP ${forgedPdf.status})`);

const traversalPdf = await getFile("/api/documents/..%2F..%2Fetc%2Fpasswd/file", learner);
assert(
  traversalPdf.status === 404,
  `una ruta manipulada no devuelve nada (HTTP ${traversalPdf.status})`,
);

// ---------------------------------------------------------------------------
// 2. Matrícula desde administración
// ---------------------------------------------------------------------------

const admin = cookieFor("demo-admin");
const enrollPage = await get("/admin/matriculas", admin);
const enrollForm = forms(enrollPage.html).find((form) => form.inner.includes("<select"));
assert(Boolean(enrollForm), "encuentra el formulario de matrícula");

if (enrollForm) {
  const result = await postForm("/admin/matriculas", admin, {
    ...enrollForm.fields,
    uid: "demo-alumno-1",
    courseId: "curso-proteccion-datos",
  });
  assert(result.status === 303, `matricula a la alumna (HTTP ${result.status})`);
  assert(
    !result.location?.includes("error="),
    `la matrícula no devuelve error (${result.location ?? "sin redirección"})`,
  );

  const panel = await get("/panel", learner);
  assert(panel.html.includes("Protección de datos"), "el curso matriculado aparece en su panel");
}

// ---------------------------------------------------------------------------
// 3. Editor de estructura del borrador (bloque 04)
// ---------------------------------------------------------------------------

const EDIT_COURSE = "curso-prevencion-riesgos";
const DRAFT_TITLE = "Borrador no publicado de prevención";

const editDetail = await get(`/admin/cursos/${EDIT_COURSE}`, admin);
const startDraftForm = forms(editDetail.html).find((form) =>
  form.inner.includes("Nueva versión en borrador"),
);
assert(Boolean(startDraftForm), "encuentra el botón para preparar un borrador");

let editorPath = null;
if (startDraftForm) {
  const created = await postForm(`/admin/cursos/${EDIT_COURSE}`, admin, startDraftForm.fields);
  assert(created.status === 303, `crea el borrador (HTTP ${created.status})`);
  editorPath = created.location;
  assert(
    Boolean(editorPath?.includes("/editar?v=2") && editorPath?.includes("ok=borrador")),
    `el borrador nuevo abre el editor de la versión 2 (${editorPath})`,
  );
}

if (editorPath) {
  // URL del editor con la revisión vigente: se actualiza tras cada guardado.
  let editorUrl = editorPath;
  const editor = await get(editorPath, admin);
  assert(editor.status === 200, "el editor de estructura carga");
  assert(editor.html.includes("Guardar borrador"), "el editor tiene el formulario de guardado");

  const saveForm = forms(editor.html).find((form) => form.inner.includes("Guardar borrador"));
  assert(Boolean(saveForm), "encuentra los campos del borrador");

  if (saveForm) {
    const staleRevision = saveForm.fields.expectedRevision;
    const saved = await postForm(editorPath, admin, {
      ...saveForm.fields,
      title: DRAFT_TITLE,
      description: "Descripción que no debe ver el alumnado",
      newTopicId: "tema-borrador",
      newTopicTitle: "Tema del borrador",
      newTopicMandatory: "on",
    });
    assert(saved.status === 303, `guarda el borrador (HTTP ${saved.status})`);
    assert(
      Boolean(saved.location?.includes("ok=guardado")),
      `el guardado confirmado se anuncia como tal (${saved.location})`,
    );

    editorUrl = saved.location ?? editorPath;
    const reloaded = await get(editorUrl, admin);
    assert(reloaded.html.includes(DRAFT_TITLE), "el borrador guardado se recupera al reabrir");
    assert(reloaded.html.includes("Tema del borrador"), "el tema nuevo persiste");
    assert(
      !reloaded.html.includes(`expectedRevision" value="${staleRevision}"`) ||
        reloaded.html.includes(`expectedRevision" value="${Number(staleRevision) + 1}"`),
      "la revisión del editor avanza tras guardar",
    );

    // Guardar con la revisión vieja (otra pestaña) no debe decir «guardado».
    const stale = await postForm(saved.location ?? editorPath, admin, {
      ...saveForm.fields,
      title: "Escritura de una pestaña antigua",
    });
    assert(stale.status === 303, `rechaza un guardado obsoleto (HTTP ${stale.status})`);
    assert(
      Boolean(stale.location?.includes("error=")),
      `el guardado obsoleto devuelve error (${stale.location})`,
    );
    assert(
      !stale.location?.includes("ok=guardado"),
      "el guardado obsoleto no se anuncia como guardado",
    );

    editorUrl = stale.location ?? editorUrl;
    const afterStale = await get(editorUrl, admin);
    assert(afterStale.html.includes(DRAFT_TITLE), "el contenido bueno no se ha pisado");
    assert(
      !afterStale.html.includes("Escritura de una pestaña antigua"),
      "la escritura obsoleta no llega al almacén",
    );
  }

  // --- Cuestionarios y examen final (bloque 05) ---------------------------

  const quizPage = await get(editorUrl, admin);
  const quizForm = forms(quizPage.html).find((form) =>
    form.inner.includes("Guardar cuestionarios y examen final"),
  );
  assert(Boolean(quizForm), "el editor incluye el formulario de cuestionarios");

  if (quizForm) {
    const questionText = "Pregunta del recorrido automático";
    const finalText = "Pregunta final del recorrido automático";

    const quizSaved = await postForm(editorUrl, admin, {
      ...quizForm.fields,
      "quiz:tema-borrador:newQuestionId": "pregunta-smoke",
      "quiz:tema-borrador:newQuestionPrompt": questionText,
      "quiz:tema-borrador:newQuestionType": "single_choice",
      "quiz:tema-borrador:newOption1Id": "si",
      "quiz:tema-borrador:newOption1Label": "Sí",
      "quiz:tema-borrador:newOption1Correct": "on",
      "quiz:tema-borrador:newOption2Id": "no",
      "quiz:tema-borrador:newOption2Label": "No",
      "quiz:final:newQuestionId": "final-smoke",
      "quiz:final:newQuestionPrompt": finalText,
      "quiz:final:newQuestionType": "single_choice",
      "quiz:final:newOption1Id": "correcta",
      "quiz:final:newOption1Label": "Correcta",
      "quiz:final:newOption1Correct": "on",
      "quiz:final:newOption2Id": "incorrecta",
      "quiz:final:newOption2Label": "Incorrecta",
    });

    assert(quizSaved.status === 303, `guarda los cuestionarios (HTTP ${quizSaved.status})`);
    assert(
      Boolean(quizSaved.location?.includes("ok=cuestionarios")),
      `el guardado de cuestionarios se anuncia como tal (${quizSaved.location})`,
    );

    editorUrl = quizSaved.location ?? editorUrl;
    const quizReloaded = await get(editorUrl, admin);
    assert(quizReloaded.html.includes(questionText), "la pregunta del tema se recupera al reabrir");
    assert(quizReloaded.html.includes(finalText), "la pregunta del examen final se recupera");
    assert(
      quizReloaded.html.includes("pregunta(s) en los temas") &&
        quizReloaded.html.includes("en el examen final"),
      "el editor cuenta las preguntas guardadas",
    );

    // Un guardado con la revisión vieja no pisa el cuestionario.
    const quizStale = await postForm(editorUrl, admin, {
      ...quizForm.fields,
      "quiz:tema-borrador:newQuestionId": "pregunta-vieja",
      "quiz:tema-borrador:newQuestionPrompt": "Escritura obsoleta del cuestionario",
      "quiz:tema-borrador:newOption1Id": "a",
      "quiz:tema-borrador:newOption1Label": "A",
      "quiz:tema-borrador:newOption1Correct": "on",
      "quiz:tema-borrador:newOption2Id": "b",
      "quiz:tema-borrador:newOption2Label": "B",
    });
    assert(
      Boolean(quizStale.location?.includes("error=")),
      `el cuestionario obsoleto devuelve error (${quizStale.location})`,
    );
    assert(
      !quizStale.location?.includes("ok="),
      "el cuestionario obsoleto no se anuncia como guardado",
    );

    editorUrl = quizStale.location ?? editorUrl;
    const quizAfterStale = await get(editorUrl, admin);
    assert(
      quizAfterStale.html.includes(questionText) &&
        !quizAfterStale.html.includes("Escritura obsoleta del cuestionario"),
      "la escritura obsoleta no llega al cuestionario",
    );

    const learnerWithQuiz = await get("/panel", learner);
    assert(
      !learnerWithQuiz.html.includes(questionText) &&
        !learnerWithQuiz.html.includes(finalText),
      "el alumnado no ve las preguntas del borrador",
    );
  }

  // --- Documentos PDF: subida por partes, cuota y asociación (bloque 06) ---

  const pdfEditor = await get(editorUrl, admin);
  assert(
    pdfEditor.html.includes("Documentos PDF de esta versión"),
    "el editor incluye la sección de documentos PDF",
  );
  assert(
    pdfEditor.html.includes("no verifica") && pdfEditor.html.includes("Confirmo que el documento"),
    "el editor pide confirmar las páginas y avisa de que no se verifican",
  );
  assert(
    pdfEditor.html.includes("Cuota de PDF:"),
    "el editor muestra el estado de la cuota de PDF",
  );

  const revisionMatch = /expectedRevision" value="(\d+)"/.exec(pdfEditor.html);
  assert(Boolean(revisionMatch), "el editor expone la revisión vigente del borrador");

  if (revisionMatch) {
    const revision = Number(revisionMatch[1]);
    const pdfBytes = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(2048, 0x41),
    ]);
    const digest = createHash("sha256").update(pdfBytes).digest("hex");

    const createResponse = await fetch(`${BASE}/api/admin/documents/uploads`, {
      method: "POST",
      headers: { ...admin, "Content-Type": "application/json" },
      body: JSON.stringify({
        courseId: EDIT_COURSE,
        version: 2,
        topicId: "tema-borrador",
        title: "PDF del recorrido automático",
        pageCount: 2,
        bytes: pdfBytes.length,
        sha256: digest,
      }),
    });
    const createdUpload = await createResponse.json();
    assert(
      createResponse.status === 201 && createdUpload.upload?.state === "pending",
      `abre la subida pendiente (HTTP ${createResponse.status})`,
    );

    const documentId = createdUpload.upload?.documentId;
    assert(
      typeof documentId === "string" && documentId.startsWith("doc_"),
      "el servidor asigna el identificador del documento",
    );

    // El cliente no elige el identificador: si lo manda, la petición se rechaza.
    const forged = await fetch(`${BASE}/api/admin/documents/uploads`, {
      method: "POST",
      headers: { ...admin, "Content-Type": "application/json" },
      body: JSON.stringify({
        courseId: EDIT_COURSE,
        version: 2,
        topicId: "tema-borrador",
        title: "Intento de identificador propio",
        pageCount: 2,
        bytes: pdfBytes.length,
        sha256: digest,
        documentId: "doc_elegido_por_el_cliente",
      }),
    });
    assert(forged.status === 400, `rechaza un identificador elegido por el cliente (HTTP ${forged.status})`);

    // Una parte que no es un PDF se rechaza y la subida no avanza.
    const notPdf = Buffer.from("<html>no soy un pdf</html>");
    const badPart = await fetch(
      `${BASE}/api/admin/documents/uploads/${documentId}/parts/0`,
      {
        method: "PUT",
        headers: { ...admin, "Content-Type": "application/octet-stream" },
        body: notPdf,
      },
    );
    assert(badPart.status === 400, `rechaza una parte que no es PDF (HTTP ${badPart.status})`);

    // Finalizar antes de tiempo no activa nada.
    const early = await fetch(`${BASE}/api/admin/documents/uploads/${documentId}/finalize`, {
      method: "POST",
      headers: admin,
    });
    assert(early.status === 409, `no finaliza con partes ausentes (HTTP ${early.status})`);

    const putPart = await fetch(`${BASE}/api/admin/documents/uploads/${documentId}/parts/0`, {
      method: "PUT",
      headers: { ...admin, "Content-Type": "application/octet-stream" },
      body: pdfBytes,
    });
    assert(putPart.status === 200, `guarda la parte 0 (HTTP ${putPart.status})`);

    const pendingEditor = await get(editorUrl, admin);
    assert(
      pendingEditor.html.includes("Subidas pendientes") &&
        pendingEditor.html.includes(documentId),
      "la subida pendiente aparece en el editor, marcada como pendiente",
    );
    assert(
      !pendingEditor.html.includes("PDF del recorrido automático · 2 página"),
      "un pendiente no se lista como documento asociado",
    );

    const finalized = await fetch(`${BASE}/api/admin/documents/uploads/${documentId}/finalize`, {
      method: "POST",
      headers: admin,
    });
    const finalizedBody = await finalized.json();
    assert(finalized.status === 200, `finaliza y verifica la huella (HTTP ${finalized.status})`);
    assert(
      finalizedBody.upload?.state === "active" && finalizedBody.usage?.usedBytes >= pdfBytes.length,
      "el documento queda activo y cuenta en la cuota",
    );

    const attach = await fetch(`${BASE}/api/admin/documents/${documentId}/attach`, {
      method: "POST",
      headers: { ...admin, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: revision }),
    });
    const attachBody = await attach.json();
    assert(attach.status === 200 && attachBody.attached === true, `asocia el PDF al tema (HTTP ${attach.status})`);

    const attachedEditor = await get(editorUrl, admin);
    assert(
      attachedEditor.html.includes("PDF del recorrido automático"),
      "el documento asociado aparece en el tema del borrador",
    );

    // Asociar dos veces no duplica.
    const attachAgain = await fetch(`${BASE}/api/admin/documents/${documentId}/attach`, {
      method: "POST",
      headers: { ...admin, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: revision + 1 }),
    });
    const attachAgainBody = await attachAgain.json();
    assert(
      attachAgain.status === 200 && attachAgainBody.attached === false,
      "reasociar el mismo documento no lo duplica",
    );

    // Cancelar una subida incompleta libera la cuota reservada.
    const secondBytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(1024, 0x42)]);
    const secondDigest = createHash("sha256").update(secondBytes).digest("hex");
    const secondCreate = await fetch(`${BASE}/api/admin/documents/uploads`, {
      method: "POST",
      headers: { ...admin, "Content-Type": "application/json" },
      body: JSON.stringify({
        courseId: EDIT_COURSE,
        version: 2,
        topicId: "tema-borrador",
        title: "Subida que se cancela",
        pageCount: 1,
        bytes: secondBytes.length,
        sha256: secondDigest,
      }),
    });
    const secondBody = await secondCreate.json();
    const secondId = secondBody.upload?.documentId;
    assert(secondCreate.status === 201, "abre una segunda subida para cancelarla");

    const usageWithReserve = await (await fetch(`${BASE}/api/admin/documents`, { headers: admin })).json();
    assert(
      usageWithReserve.reservedBytes >= secondBytes.length,
      "la subida pendiente reserva cuota antes de recibir bytes",
    );

    const aborted = await fetch(`${BASE}/api/admin/documents/uploads/${secondId}/abort`, {
      method: "POST",
      headers: admin,
    });
    const abortedBody = await aborted.json();
    assert(aborted.status === 200, `cancela la subida incompleta (HTTP ${aborted.status})`);
    assert(
      abortedBody.releasedBytes === secondBytes.length,
      "la cancelación libera exactamente lo reservado",
    );

    const usageAfterAbort = await (await fetch(`${BASE}/api/admin/documents`, { headers: admin })).json();
    assert(usageAfterAbort.reservedBytes === 0, "no queda cuota reservada tras cancelar");

    // El alumnado no ve el documento del borrador ni puede leerlo.
    const learnerDoc = await get(
      `/cursos/${EDIT_COURSE}/documentos/${documentId}`,
      learner,
    );
    assert(
      learnerDoc.status !== 200 || !learnerDoc.html.includes("PDF del recorrido automático"),
      `el pendiente/borrador no se sirve al alumnado (HTTP ${learnerDoc.status})`,
    );
  }

  // La versión publicada y el alumnado no cambian.
  const published = await get(`/admin/cursos/${EDIT_COURSE}?v=1`, admin);
  assert(published.html.includes("Publicada"), "la versión 1 sigue publicada");
  assert(!published.html.includes(DRAFT_TITLE), "la publicada no lleva el título del borrador");

  const learnerPanel = await get("/panel", learner);
  assert(
    !learnerPanel.html.includes(DRAFT_TITLE) &&
      !learnerPanel.html.includes("Descripción que no debe ver el alumnado"),
    "el alumnado no ve el borrador en su panel",
  );
}

// ---------------------------------------------------------------------------
// 3 bis. Curso nuevo: primer borrador vacío
// ---------------------------------------------------------------------------

const NEW_COURSE = "curso-smoke-b04";
const newPage = await get("/admin/cursos/nuevo", admin);
const createForm = forms(newPage.html).find((form) => form.fields.courseId !== undefined);
assert(Boolean(createForm), "encuentra el formulario de alta de curso");

if (createForm) {
  const created = await postForm("/admin/cursos/nuevo", admin, {
    ...createForm.fields,
    courseId: NEW_COURSE,
    title: "Curso del recorrido automático",
    description: "",
  });
  assert(created.status === 303, `crea el curso vacío (HTTP ${created.status})`);

  const emptyDetail = await get(`/admin/cursos/${NEW_COURSE}`, admin);
  assert(
    emptyDetail.html.includes("Este curso no tiene versiones"),
    "el curso nuevo no tiene versiones",
  );

  const firstDraft = forms(emptyDetail.html).find((form) =>
    form.inner.includes("Preparar el primer borrador"),
  );
  assert(Boolean(firstDraft), "ofrece preparar el primer borrador");

  if (firstDraft) {
    const opened = await postForm(`/admin/cursos/${NEW_COURSE}`, admin, firstDraft.fields);
    assert(
      Boolean(opened.location?.includes("/editar?v=1") && opened.location?.includes("ok=borrador")),
      `el primer borrador es la versión 1 (${opened.location})`,
    );

    const emptyEditor = await get(opened.location ?? `/admin/cursos/${NEW_COURSE}`, admin);
    assert(emptyEditor.html.includes("Todavía no hay ninguno"), "el borrador nace sin temas");

    const emptySaveForm = forms(emptyEditor.html).find((form) =>
      form.inner.includes("Guardar borrador"),
    );
    if (emptySaveForm) {
      const saved = await postForm(opened.location, admin, {
        ...emptySaveForm.fields,
        title: "Curso del recorrido automático",
        description: "",
      });
      assert(
        Boolean(saved.location?.includes("ok=guardado")),
        `un borrador vacío se guarda (${saved.location})`,
      );
    }

    const learnerPanel = await get("/panel", learner);
    assert(
      !learnerPanel.html.includes(NEW_COURSE) &&
        !learnerPanel.html.includes("Curso del recorrido automático"),
      "un curso con solo borrador no aparece al alumnado",
    );

    // -----------------------------------------------------------------------
    // 3 quater. La publicación se valida en el SERVIDOR (bloque 08)
    // -----------------------------------------------------------------------

    // El botón «Publicar» está desactivado en el HTML, pero una acción de
    // servidor se puede enviar sin pasar por el navegador: se envía igual y el
    // servidor tiene que rechazarla por sí mismo.
    const emptyDetailPage = await get(`/admin/cursos/${NEW_COURSE}?v=1`, admin);
    const emptyPublish = forms(emptyDetailPage.html).find(
      (form) => form.fields.courseId === NEW_COURSE && form.fields.version === "1",
    );
    assert(Boolean(emptyPublish), "el borrador vacío ofrece el formulario de publicar");

    if (emptyPublish) {
      const refused = await postForm(
        `/admin/cursos/${NEW_COURSE}?v=1`,
        admin,
        emptyPublish.fields,
      );
      assert(
        refused.status === 303 && Boolean(refused.location?.includes("error=")),
        `el servidor rechaza publicar un curso vacío (${refused.location})`,
      );
      assert(
        !Boolean(refused.location?.includes("ok=publicada")),
        "el rechazo no se anuncia como publicación",
      );

      const stillDraft = await get(`/admin/cursos/${NEW_COURSE}?v=1`, admin);
      assert(
        stillDraft.html.includes("Borrador") && !stillDraft.html.includes("Publicada el"),
        "el curso sigue en borrador después del intento",
      );

      const learnerAfterAttempt = await get("/panel", learner);
      assert(
        !learnerAfterAttempt.html.includes("Curso del recorrido automático"),
        "un curso rechazado al publicar no aparece al alumnado",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3 ter. PDF subido al borrador y abierto tras publicar (bloques 06 y 07)
// ---------------------------------------------------------------------------

const DATA_COURSE = "curso-proteccion-datos";
const uploadEditor = await get(`/admin/cursos/${DATA_COURSE}/editar?v=2`, admin);
const revisionMatch = /expectedRevision" value="(\d+)"/.exec(uploadEditor.html);
assert(Boolean(revisionMatch), "el editor del borrador expone su revisión");
assert(
  uploadEditor.html.includes("Documentos PDF de esta versión") &&
    uploadEditor.html.includes("Cuota de PDF:"),
  "el editor muestra la sección de PDF y la cuota",
);

let uploadedDocumentId = null;
if (revisionMatch) {
  const revision = Number(revisionMatch[1]);
  // Se sube un PDF real: los bytes del PDF de ejemplo ya descargado.
  const pdfBytes = seededPdf.body;
  const sha256 = createHash("sha256").update(pdfBytes).digest("hex");

  const created = await fetch(`${BASE}/api/admin/documents/uploads`, {
    method: "POST",
    headers: { ...admin, "Content-Type": "application/json" },
    body: JSON.stringify({
      courseId: DATA_COURSE,
      version: 2,
      topicId: "soportes",
      title: "PDF del recorrido automático",
      pageCount: 3,
      bytes: pdfBytes.length,
      sha256,
    }),
  });
  const createdBody = await created.json();
  uploadedDocumentId = createdBody.upload?.documentId ?? null;
  assert(created.status === 201, `abre la subida del PDF (HTTP ${created.status})`);
  assert(Boolean(uploadedDocumentId), "el servidor asigna el identificador del documento");

  if (uploadedDocumentId) {
    const put = await fetch(
      `${BASE}/api/admin/documents/uploads/${uploadedDocumentId}/parts/0`,
      {
        method: "PUT",
        headers: { ...admin, "Content-Type": "application/octet-stream" },
        body: pdfBytes,
      },
    );
    assert(put.status === 200, `sube la parte 0 (HTTP ${put.status})`);

    // Antes de finalizar, el PDF no se sirve a nadie.
    const beforeFinalize = await getFile(
      `/api/documents/${uploadedDocumentId}/file`,
      learner,
    );
    assert(
      beforeFinalize.status === 404,
      `un documento pendiente no se entrega (HTTP ${beforeFinalize.status})`,
    );

    const finalized = await fetch(
      `${BASE}/api/admin/documents/uploads/${uploadedDocumentId}/finalize`,
      { method: "POST", headers: admin },
    );
    assert(finalized.status === 200, `finaliza y verifica la huella (HTTP ${finalized.status})`);

    // Activo pero aún no asociado: tampoco está en la versión publicada.
    const notAttached = await getFile(`/api/documents/${uploadedDocumentId}/file`, learner);
    assert(
      notAttached.status === 404,
      `un activo sin asociar no se sirve por el portal (HTTP ${notAttached.status})`,
    );

    const attached = await fetch(`${BASE}/api/admin/documents/${uploadedDocumentId}/attach`, {
      method: "POST",
      headers: { ...admin, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: revision }),
    });
    assert(attached.status === 200, `asocia el PDF al tema del borrador (HTTP ${attached.status})`);

    const draftStillClosed = await getFile(`/api/documents/${uploadedDocumentId}/file`, learner);
    assert(
      draftStillClosed.status === 404,
      `mientras el borrador no se publica, el alumnado no lo recibe (HTTP ${draftStillClosed.status})`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Publicación de un borrador
// ---------------------------------------------------------------------------

const detail = await get("/admin/cursos/curso-proteccion-datos?v=2", admin);
const publishForm = forms(detail.html).find(
  (form) => form.fields.courseId && form.fields.version && !form.fields.title,
);
assert(Boolean(publishForm), "encuentra el botón de publicar del borrador");

if (publishForm) {
  const result = await postForm("/admin/cursos/curso-proteccion-datos?v=2", admin, publishForm.fields);
  assert(result.status === 303, `publica la versión 2 (HTTP ${result.status})`);

  const after = await get(result.location ?? "/admin/cursos/curso-proteccion-datos?v=2", admin);
  assert(
    after.html.includes("Versión publicada"),
    `la versión 2 queda publicada (${result.location})`,
  );

  const panel = await get("/panel", learner);
  assert(
    panel.html.includes("Versión 2") || panel.html.includes("curso-proteccion-datos"),
    "el alumno ve la versión nueva en su panel",
  );

  if (uploadedDocumentId) {
    const publishedPdf = await getFile(`/api/documents/${uploadedDocumentId}/file`, learner);
    assert(
      publishedPdf.status === 200,
      `tras publicar, el alumno abre el PDF del curso (HTTP ${publishedPdf.status})`,
    );
    assert(
      publishedPdf.body.equals(seededPdf.body),
      "los bytes entregados son exactamente los que se subieron",
    );

    const documentPage = await get(
      `/cursos/${DATA_COURSE}/documentos/${uploadedDocumentId}`,
      learner,
    );
    assert(
      documentPage.html.includes(`/api/documents/${uploadedDocumentId}/file`),
      "la página del curso ofrece abrir ese PDF en el visor",
    );
  }
}

// ---------------------------------------------------------------------------
// 4 bis. Personas y cuentas (bloque 09)
// ---------------------------------------------------------------------------

const people = await get("/admin/personas", admin);
assert(people.status === 200, `administración abre la lista de personas (HTTP ${people.status})`);
assert(
  people.html.includes("demo-pendiente") && people.html.includes("Pendiente de activación"),
  "la lista muestra el estado real de las cuentas",
);

const learnerPeople = await get("/admin/personas", learner);
assert(learnerPeople.status === 307, `un alumno no entra en personas (HTTP ${learnerPeople.status})`);

const missingPerson = await get("/admin/personas/no-existe", admin);
assert(missingPerson.status === 404, `una cuenta inexistente da 404 (HTTP ${missingPerson.status})`);

const lastAdmin = await get("/admin/personas/demo-admin", admin);
assert(
  lastAdmin.html.includes("único administrador activo"),
  "la ficha avisa de que no se puede deshabilitar al último administrador",
);
assert(
  !lastAdmin.html.includes("Deshabilitar cuenta"),
  "el único administrador no ofrece el botón de deshabilitar",
);

// Deshabilitar a la segunda alumna desde su ficha.
const personBefore = await get("/admin/personas/demo-alumno-2", admin);
const disableForm = forms(personBefore.html).find((form) =>
  form.inner.includes("Deshabilitar cuenta"),
);
assert(Boolean(disableForm), "la ficha ofrece deshabilitar la cuenta");

if (disableForm) {
  const disabled = await postForm("/admin/personas/demo-alumno-2", admin, {
    ...disableForm.fields,
    reason: "Recorrido automático",
  });
  assert(
    Boolean(disabled.location?.includes("ok=deshabilitada")),
    `la cuenta queda deshabilitada (${disabled.location})`,
  );

  const afterDisable = await get("/admin/personas/demo-alumno-2", admin);
  assert(afterDisable.html.includes("Deshabilitada"), "la ficha muestra el estado deshabilitado");

  // La sesión de esa persona muere en la petición siguiente.
  const closed = await get("/panel", cookieFor("demo-alumno-2"));
  assert(closed.status === 307, `una cuenta deshabilitada pierde la sesión (HTTP ${closed.status})`);

  const disabledList = await get("/admin/personas?estado=disabled", admin);
  assert(
    disabledList.html.includes("demo-alumno-2") && !disabledList.html.includes("demo-alumno-1"),
    "el filtro por estado separa las cuentas deshabilitadas",
  );

  // Y se puede reactivar.
  const reopen = await get("/admin/personas/demo-alumno-2", admin);
  const enableForm = forms(reopen.html).find((form) => form.inner.includes("Reactivar cuenta"));
  assert(Boolean(enableForm), "la ficha ofrece reactivar la cuenta");

  if (enableForm) {
    const enabled = await postForm("/admin/personas/demo-alumno-2", admin, enableForm.fields);
    assert(
      Boolean(enabled.location?.includes("ok=reactivada")),
      `la cuenta vuelve a estar activa (${enabled.location})`,
    );
    const back = await get("/panel", cookieFor("demo-alumno-2"));
    assert(back.status === 200, `la alumna reactivada vuelve a entrar (HTTP ${back.status})`);
  }
}

// Reemitir el código de la cuenta pendiente: el token se ve una sola vez.
const pendingPage = await get("/admin/personas/demo-pendiente", admin);
const reissueForm = forms(pendingPage.html).find((form) =>
  form.inner.includes("Reemitir código"),
);
assert(Boolean(reissueForm), "la ficha de la cuenta pendiente ofrece reemitir el código");

const activationTokens = (html) =>
  new Set(html.match(/[A-Za-z0-9_-]{43}/g) ?? []);

if (reissueForm) {
  const first = await postForm("/admin/personas/demo-pendiente", admin, reissueForm.fields);
  assert(first.status === 200, `emite un código nuevo (HTTP ${first.status})`);
  assert(
    first.html.includes("Código nuevo emitido") && first.html.includes("activation-token"),
    "el código se muestra una sola vez en la respuesta",
  );
  assert(
    !first.location,
    "el código no viaja en la URL (no queda en el historial)",
  );

  const second = await postForm("/admin/personas/demo-pendiente", admin, reissueForm.fields);
  assert(
    second.html.includes("se anularon 1 anterior"),
    "reemitir anula el código anterior",
  );
  const firstTokens = activationTokens(first.html);
  const secondTokens = activationTokens(second.html);
  assert(
    firstTokens.size > 0 && secondTokens.size > 0,
    "cada emisión devuelve un código utilizable",
  );
  assert(
    [...secondTokens].some((token) => !firstTokens.has(token)),
    "el código nuevo es distinto del anterior",
  );

  const stillPending = await get("/admin/personas/demo-pendiente", admin);
  assert(
    stillPending.html.includes("Pendiente de activación"),
    "reemitir no activa la cuenta por su cuenta",
  );
}

// Una cuenta activa no necesita código y una deshabilitada tampoco lo admite.
const activePerson = await get("/admin/personas/demo-alumno-1", admin);
assert(
  activePerson.html.includes("La cuenta ya está activa") &&
    !activePerson.html.includes("Reemitir código de activación"),
  "una cuenta activa no ofrece reemitir el código",
);

// ---------------------------------------------------------------------------
// 5. Acceso de administración y cierre
// ---------------------------------------------------------------------------

const adminPanel = await get("/admin", admin);
assert(adminPanel.status === 200, "el administrador entra al panel");
assert(adminPanel.html.includes("Matrículas activas"), "el panel muestra el resumen real de la demostración");

const anonymous = await get("/panel", {});
assert(anonymous.status === 307, "sin sesión, el panel redirige al acceso");

console.log(process.exitCode ? "\nRESULTADO: FAILED\n" : "\nRESULTADO: PASSED\n");
