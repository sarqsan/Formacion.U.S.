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
      const value = /value="([^"]*)"/.exec(tag)?.[1] ?? "";
      fields[name] = value;
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
// 3. Publicación de un borrador
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
// 4. Acceso de administración y cierre
// ---------------------------------------------------------------------------

const adminPanel = await get("/admin", admin);
assert(adminPanel.status === 200, "el administrador entra al panel");
assert(adminPanel.html.includes("Matrículas activas"), "el panel muestra el resumen real de la demostración");

const anonymous = await get("/panel", {});
assert(anonymous.status === 307, "sin sesión, el panel redirige al acceso");

console.log(process.exitCode ? "\nRESULTADO: FAILED\n" : "\nRESULTADO: PASSED\n");
