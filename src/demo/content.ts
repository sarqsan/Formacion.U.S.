import type { CourseVersionDefinition } from "@/domain/courses/content";
import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";
import type { AccountRole, AccountStatus, PersonRol } from "@/domain/roles";

/**
 * CONTENIDO DE LA DEMOSTRACIÓN (100 % sintético)
 * =============================================
 *
 * Todo lo de este fichero es **inventado**: los cursos, los textos, las
 * preguntas, las personas y los identificadores. No procede de ningún
 * documento real, ni describe procedimientos reales, ni contiene datos de
 * personas.
 *
 * Se usa solo cuando `DEMO_MODE=1`. En ese modo la aplicación no habla con
 * Firebase: los datos viven en memoria y se reinician al reiniciar el
 * servidor (ver `src/demo/store.ts`).
 */

export interface DemoScreen {
  title: string;
  body: string[];
}

/** Pantallas conocidas, por id de documento del curso. */
const SCREEN_CONTENT: Record<string, DemoScreen[]> = {
  "doc-riesgos": [
    {
      title: "Qué es un riesgo laboral",
      body: [
        "Un riesgo laboral es la posibilidad de que una persona sufra un daño mientras trabaja. No es lo mismo que el peligro: el peligro es la fuente (una escalera, un cable suelto, una carga pesada) y el riesgo es la probabilidad de que ese peligro cause un daño.",
        "En esta unidad de demostración se trabaja con ejemplos genéricos de oficina y almacén. El objetivo es reconocer la secuencia: identificar el peligro, valorar el riesgo y decidir una medida.",
      ],
    },
    {
      title: "Cómo se identifica un riesgo",
      body: [
        "Primero se observa el puesto: suelo, iluminación, cables, altura de las estanterías, peso de lo que se manipula. Después se pregunta a quien realiza la tarea, porque conoce detalles que no se ven en una visita rápida.",
        "Una lista breve ayuda más que una lista larga: tres riesgos bien descritos se corrigen; treinta mal descritos se archivan.",
      ],
    },
    {
      title: "Qué hacer cuando se detecta",
      body: [
        "El primer paso es comunicarlo por el cauce establecido y dejar constancia por escrito. No se debe corregir por cuenta propia una instalación que no corresponde a su puesto: se informa y se espera la medida.",
        "Si el riesgo es inmediato, se interrumpe la tarea y se avisa. Ninguna tarea urgente justifica trabajar sobre un riesgo grave sin control.",
      ],
    },
  ],
  "doc-emergencias": [
    {
      title: "Los primeros treinta segundos",
      body: [
        "Ante una emergencia, lo primero es avisar y no convertirse en una segunda víctima. Se comprueba el entorno antes de acercarse: humo, cables, tráfico o una superficie inestable pueden hacer que quien ayuda acabe necesitando ayuda.",
        "Después se sigue el protocolo del centro: quién avisa, por qué medio y a quién. Este curso de demostración no sustituye a la formación presencial de su organización.",
      ],
    },
    {
      title: "Evacuación ordenada",
      body: [
        "Se usa la vía de evacuación señalizada más cercana y se mantiene la calma. No se vuelve a recoger objetos personales y no se usan ascensores.",
        "En el punto de reunión se informa a la persona responsable de quién ha salido y quién falta, con datos concretos y sin suposiciones.",
      ],
    },
  ],
  "doc-datos": [
    {
      title: "Qué es un dato personal",
      body: [
        "Un dato personal es cualquier información que permite identificar a una persona: nombre, correo, teléfono, imagen, número de empleado o incluso una combinación de datos que, juntos, la identifican.",
        "En esta demostración todos los nombres y correos son inventados y usan el dominio `example.invalid`, reservado para ejemplos.",
      ],
    },
    {
      title: "Principios prácticos",
      body: [
        "Se recogen solo los datos necesarios para la finalidad prevista, se guardan el tiempo imprescindible y se accede a ellos solo si el trabajo lo exige.",
        "Antes de enviar una lista de personas por correo, se comprueba el destinatario y se evita el envío masivo con direcciones visibles.",
      ],
    },
  ],
  "doc-soporte": [
    {
      title: "Soportes y dispositivos",
      body: [
        "Un soporte es cualquier lugar donde vive la información: un ordenador, una memoria USB, una impresora o una carpeta compartida. Cada soporte necesita una persona responsable.",
        "Los dispositivos extraíbles se usan solo si están autorizados y se revisan antes de conectarlos.",
      ],
    },
  ],
};

/** Pantalla genérica para contenido que se cree desde el editor de demostración. */
function generatedScreen(documentTitle: string, page: number, pageCount: number): DemoScreen {
  return {
    title: `${documentTitle} · pantalla ${page}`,
    body: [
      `Pantalla ${page} de ${pageCount} del documento «${documentTitle}».`,
      "Este texto se ha generado como relleno para la demostración: no es contenido de formación real. Sirve para comprobar que la lectura avanza pantalla a pantalla y que el cuestionario permanece cerrado hasta terminar el documento.",
      "En producción, cada pantalla corresponde a una página del PDF cargado por administración; aquí el contenido es texto inventado para poder recorrer la interfaz sin documentos reales.",
    ],
  };
}

/**
 * Pantallas de un documento. Si el documento no tiene texto propio (por
 * ejemplo, uno añadido desde el editor), se genera relleno claramente marcado.
 */
export function screensForDocument(
  documentId: string,
  pageCount: number,
  documentTitle: string,
): DemoScreen[] {
  const known = SCREEN_CONTENT[documentId];
  const total = Math.max(1, pageCount);

  return Array.from({ length: total }, (_, index) => {
    const page = index + 1;
    const screen = known?.[index];
    return screen ?? generatedScreen(documentTitle, page, total);
  });
}

// ---------------------------------------------------------------------------
// Cursos
// ---------------------------------------------------------------------------

function question(
  id: string,
  prompt: string,
  options: Array<[string, string]>,
  correct: string[],
  type: QuizQuestionDefinition["type"] = "single_choice",
): QuizQuestionDefinition {
  return {
    id,
    type,
    prompt,
    optionIds: options.map(([optionId]) => optionId),
    optionLabels: Object.fromEntries(options),
    correctOptionIds: correct,
  };
}

export const COURSE_RISKS_ID = "curso-prevencion-riesgos";
export const COURSE_DATA_ID = "curso-proteccion-datos";

/** Versión 1 publicada del curso de prevención de riesgos. */
const risksV1: CourseVersionDefinition = {
  courseId: COURSE_RISKS_ID,
  version: 1,
  title: "Prevención de riesgos en el puesto de trabajo",
  description:
    "Curso de demostración con dos temas: identificar riesgos y actuar ante una emergencia. Contenido inventado, sin procedimientos reales.",
  topics: [
    {
      id: "riesgos",
      title: "Identificación de riesgos",
      order: 1,
      mandatory: true,
      documents: [{ id: "doc-riesgos", title: "Guía breve de identificación", pageCount: 3 }],
      quiz: [
        question(
          "q-riesgos-1",
          "¿Cuál es el primer paso al detectar un riesgo en el puesto de trabajo?",
          [
            ["a", "Comunicarlo por el cauce establecido y dejarlo por escrito"],
            ["b", "Corregirlo uno mismo aunque no corresponda a su puesto"],
            ["c", "Esperar a que lo detecte otra persona"],
          ],
          ["a"],
        ),
        question(
          "q-riesgos-2",
          "¿Qué elementos ayudan a describir un riesgo de forma útil?",
          [
            ["a", "Dónde ocurre y en qué tarea"],
            ["b", "Quién lo sufre y con qué frecuencia"],
            ["c", "El nombre de quien lo detectó"],
          ],
          ["a", "b"],
          "multi_choice",
        ),
      ],
    },
    {
      id: "emergencias",
      title: "Actuación ante emergencias",
      order: 2,
      mandatory: true,
      documents: [{ id: "doc-emergencias", title: "Primeros pasos y evacuación", pageCount: 2 }],
      quiz: [
        question(
          "q-emergencias-1",
          "Antes de acercarse a una persona accidentada hay que…",
          [
            ["a", "Comprobar que el entorno es seguro"],
            ["b", "Moverla inmediatamente"],
            ["c", "Grabar la situación con el móvil"],
          ],
          ["a"],
        ),
        question(
          "q-emergencias-2",
          "Durante una evacuación, ¿qué está permitido?",
          [
            ["a", "Usar la vía señalizada más cercana"],
            ["b", "Volver a por objetos personales"],
            ["c", "Usar el ascensor si está libre"],
          ],
          ["a"],
        ),
      ],
    },
  ],
  finalExam: [
    question(
      "q-final-1",
      "Un riesgo inmediato y grave obliga a…",
      [
        ["a", "Interrumpir la tarea y avisar"],
        ["b", "Terminar la tarea cuanto antes"],
        ["c", "Documentarlo al día siguiente"],
      ],
      ["a"],
    ),
    question(
      "q-final-2",
      "El punto de reunión sirve para…",
      [
        ["a", "Saber quién ha salido y quién falta"],
        ["b", "Guardar los equipos de trabajo"],
        ["c", "Esperar instrucciones por escrito"],
      ],
      ["a"],
    ),
    question(
      "q-final-3",
      "¿Qué dos pasos forman el ciclo básico de la prevención?",
      [
        ["a", "Identificar el peligro"],
        ["b", "Valorar el riesgo y decidir una medida"],
        ["c", "Archivar el informe sin revisarlo"],
      ],
      ["a", "b"],
      "multi_choice",
    ),
  ],
};

/** Versión 1 publicada del curso de protección de datos. */
const dataV1: CourseVersionDefinition = {
  courseId: COURSE_DATA_ID,
  version: 1,
  title: "Protección de datos y confidencialidad",
  description:
    "Curso de demostración sobre datos personales y buenas prácticas. Contenido inventado con fines de presentación.",
  topics: [
    {
      id: "datos-basicos",
      title: "Datos personales: principios básicos",
      order: 1,
      mandatory: true,
      documents: [{ id: "doc-datos", title: "Datos personales en el día a día", pageCount: 2 }],
      quiz: [
        question(
          "q-datos-1",
          "¿Cuál de estos es un dato personal?",
          [
            ["a", "El número de empleado de una persona"],
            ["b", "La previsión meteorológica de mañana"],
            ["c", "El horario de apertura de una oficina"],
          ],
          ["a"],
        ),
      ],
    },
  ],
  finalExam: [
    question(
      "q-final-datos-1",
      "Antes de enviar una lista de personas por correo hay que…",
      [
        ["a", "Comprobar el destinatario y evitar direcciones visibles"],
        ["b", "Adjuntarla también en copia oculta a todo el mundo"],
        ["c", "Enviarla sin asunto para que pase desapercibida"],
      ],
      ["a"],
    ),
    question(
      "q-final-datos-2",
      "Los datos se conservan…",
      [
        ["a", "Solo el tiempo necesario para la finalidad"],
        ["b", "Siempre, por si acaso"],
        ["c", "Hasta que alguien pida borrarlos"],
      ],
      ["a"],
    ),
  ],
};

/** Borrador v2 (solo de demostración) con un tema nuevo, listo para publicar. */
const dataV2Draft: CourseVersionDefinition = {
  ...dataV1,
  version: 2,
  description:
    "Segunda versión (borrador) que añade el tema de soportes y dispositivos. Al publicarla, el curso debe repetirse desde cero.",
  topics: [
    ...dataV1.topics,
    {
      id: "soportes",
      title: "Soportes y dispositivos",
      order: 2,
      mandatory: true,
      documents: [{ id: "doc-soporte", title: "Soportes de información", pageCount: 1 }],
      quiz: [
        question(
          "q-soportes-1",
          "Un dispositivo extraíble se conecta…",
          [
            ["a", "Solo si está autorizado y revisado"],
            ["b", "Siempre que tenga espacio libre"],
            ["c", "Cuando lo pida un compañero"],
          ],
          ["a"],
        ),
      ],
    },
  ],
  finalExam: [
    ...dataV1.finalExam,
    question(
      "q-final-datos-3",
      "¿Quién debe ser responsable de un soporte de información?",
      [
        ["a", "Una persona designada explícitamente"],
        ["b", "Nadie, si está en una carpeta compartida"],
        ["c", "El proveedor de informática"],
      ],
      ["a"],
    ),
  ],
};

/** Definiciones que se cargan al arrancar el modo demostración. */
export const DEMO_COURSES: Array<{
  definition: CourseVersionDefinition;
  published: boolean;
}> = [
  { definition: risksV1, published: true },
  { definition: dataV1, published: true },
  { definition: dataV2Draft, published: false },
];

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export interface DemoAccount {
  uid: string;
  username: string;
  displayName: string;
  personRol: PersonRol;
  role: AccountRole;
  status: AccountStatus;
  /**
   * Versión de las claims. Se incrementa al activar, deshabilitar y reactivar:
   * un token con la versión anterior deja de valer. Es el mismo campo que en
   * Firestore, para que la demostración no se comporte «de mentira».
   */
  claimsVersion: number;
  createdAt: string;
  /** Fecha de la deshabilitación; `null` en los demás estados. */
  disabledAt: string | null;
}

/**
 * Cuentas de demostración. Los usuarios se generan con el mismo patrón que la
 * importación de Excel (`rol1.apellido`), pero son inventados.
 */
export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    uid: "demo-admin",
    username: "admin.demo",
    displayName: "Administración de demostración",
    personRol: "ROL 1",
    role: "admin",
    status: "active",
    claimsVersion: 1,
    createdAt: "2026-01-05T08:00:00.000Z",
    disabledAt: null,
  },
  {
    uid: "demo-alumno-1",
    username: "rol1.ejemplo",
    displayName: "Alumno de demostración (ROL 1)",
    personRol: "ROL 1",
    role: "learner",
    status: "active",
    claimsVersion: 1,
    createdAt: "2026-01-06T08:00:00.000Z",
    disabledAt: null,
  },
  {
    uid: "demo-alumno-2",
    username: "rol2.ejemplo",
    displayName: "Alumna de demostración (ROL 2)",
    personRol: "ROL 2",
    role: "learner",
    status: "active",
    claimsVersion: 1,
    createdAt: "2026-01-06T08:05:00.000Z",
    disabledAt: null,
  },
  {
    /*
      Alumna con el curso ya terminado.
      Existe para que se pueda ver el certificado sin recorrer antes un curso
      entero: es el único caso en el que aparece el botón «Obtener
      certificado». Su nombre es inventado, pero tiene forma de nombre real
      para que se vea cómo se enmascara en la página pública de verificación.
    */
    uid: "demo-alumno-3",
    username: "rol2.completado",
    displayName: "Persona con curso completado (demostración)",
    personRol: "ROL 2",
    role: "learner",
    status: "active",
    claimsVersion: 1,
    createdAt: "2026-01-06T08:07:00.000Z",
    disabledAt: null,
  },
  {
    uid: "demo-pendiente",
    username: "rol2.pendiente",
    displayName: "Cuenta pendiente de activación",
    personRol: "ROL 2",
    role: "learner",
    status: "pending_activation",
    claimsVersion: 1,
    createdAt: "2026-01-06T08:10:00.000Z",
    disabledAt: null,
  },
];

/** Matrículas iniciales: el primer alumno solo ve el curso de riesgos. */
export const DEMO_ENROLLMENTS: Array<{ uid: string; courseId: string; enrolledAt: string }> = [
  { uid: "demo-alumno-1", courseId: COURSE_RISKS_ID, enrolledAt: "2026-01-07T09:00:00.000Z" },
  { uid: "demo-alumno-2", courseId: COURSE_RISKS_ID, enrolledAt: "2026-01-07T09:30:00.000Z" },
  { uid: "demo-alumno-3", courseId: COURSE_RISKS_ID, enrolledAt: "2026-01-07T10:00:00.000Z" },
];

/** Filas de ejemplo para la demostración de importación desde Excel. */
export const DEMO_IMPORT_ROWS: Array<{ rol: string; apellido: string }> = [
  { rol: "ROL 1", apellido: "Ejemplo" },
  { rol: "ROL 2", apellido: "Ejemplo" },
  { rol: "ROL 1", apellido: "Muestra" },
  { rol: "ROL 3", apellido: "Incorrecta" },
];
