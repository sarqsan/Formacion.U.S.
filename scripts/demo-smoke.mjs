/**
 * Recorrido real por HTTP de la demostración: envía los formularios del
 * servidor (progressive enhancement, sin JavaScript) y comprueba el resultado.
 *
 *   node scripts/demo-smoke.mjs [http://127.0.0.1:3000]
 */

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const COURSE = "curso-prevencion-riesgos";

function cookieFor(uid) {
  // El origen es obligatorio: Next rechaza las acciones de servidor si no
  // coincide con el host (protección CSRF).
  return { cookie: `formacion_demo=${uid}`, origin: BASE };
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

      const value = /value="([^"]*)"/.exec(tag)?.[1] ?? "";
      fields[name] = value;
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
  assert(after.html.includes("Versión publicada"), "la versión 2 queda publicada");

  const panel = await get("/panel", learner);
  assert(
    panel.html.includes("Versión 2") || panel.html.includes("curso-proteccion-datos"),
    "el alumno ve la versión nueva en su panel",
  );
}

// ---------------------------------------------------------------------------
// 5. Acceso de administración y cierre
// ---------------------------------------------------------------------------

const adminPanel = await get("/admin", admin);
assert(adminPanel.status === 200, "el administrador entra al panel");
assert(adminPanel.html.includes("Matrículas activas"), "el panel muestra el resumen real de la demostración");

const anonymous = await get("/panel", {});
assert(anonymous.status === 307, "sin sesión, el panel redirige al acceso");

console.log(process.exitCode ? "\nRESULTADO: FAILED\n" : "\nRESULTADO: PASSED\n");
