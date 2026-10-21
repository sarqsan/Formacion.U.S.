import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { courseViewForLearner } from "@/server/portal";
import { QuizForm } from "../../quiz-form";
import { DomainError } from "@/domain/text";

export const dynamic = "force-dynamic";

export default async function TopicPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string; topicId: string }>;
  searchParams: Promise<{ lectura?: string }>;
}) {
  const { courseId, topicId } = await params;
  const { lectura } = await searchParams;
  const session = await getUiSession();

  if (session.mode === "unconfigured" || !session.actor) redirect("/login");

  let view;
  try {
    view = await courseViewForLearner(session.actor, courseId);
  } catch (error) {
    if (error instanceof DomainError) {
      return (
        <div className="mx-auto max-w-xl">
          <div className="card p-6">
            <h1 className="page-title">Sin acceso</h1>
            <p className="lead mt-2 text-sm">{error.message}</p>
            <Link href="/panel" className="btn btn-secondary mt-4">
              Volver
            </Link>
          </div>
        </div>
      );
    }
    throw error;
  }

  const topic = view.topics.find((item) => item.id === topicId);

  if (!topic) {
    return (
      <div className="mx-auto max-w-xl">
        <div className="card p-6">
          <h1 className="page-title">Tema no encontrado</h1>
          <p className="lead mt-2 text-sm">Ese tema no pertenece al curso.</p>
          <Link href={`/cursos/${courseId}`} className="btn btn-secondary mt-4">
            Volver al temario
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <nav className="text-xs muted">
        <Link href="/panel" className="underline">
          Mi formación
        </Link>{" "}
        /{" "}
        <Link href={`/cursos/${courseId}`} className="underline">
          Curso
        </Link>{" "}
        / <span>{topic.title}</span>
      </nav>

      <div>
        <p className="eyebrow">Tema {topic.order}</p>
        <h1 className="page-title mt-1">{topic.title}</h1>
        <p className="muted mt-2 text-sm">
          {topic.quizPassed
            ? `Superado el ${new Date(topic.passedAt ?? "").toLocaleDateString("es-ES")} · mejor resultado ${topic.bestScore}% · ${topic.attempts} intento(s)`
            : `Sin superar todavía · ${topic.attempts} intento(s)`}
        </p>
      </div>

      {lectura === "completa" && !topic.quizPassed ? (
        <p className="alert alert-ok">
          Has terminado la lectura del tema. El cuestionario ya está disponible: se repite hasta
          acertar todas las respuestas.
        </p>
      ) : null}

      {!topic.readComplete ? (
        <div className="card p-5">
          <h2 className="text-sm font-semibold">Primero, el temario</h2>
          <p className="muted mt-2 text-sm leading-relaxed">
            El cuestionario se abre cuando has leído todos los documentos del tema. El servidor
            comprueba esta condición antes de corregir nada.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {topic.documents.map((document) => (
              <Link
                key={document.id}
                href={`/cursos/${courseId}/documentos/${document.id}`}
                className="btn btn-primary btn-sm"
              >
                {document.read ? "Repasar" : "Leer"} «{document.title}»
              </Link>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {topic.documents.length > 0 ? (
            <p className="alert alert-ok">
              Lectura completada ({topic.documents.length} documento
              {topic.documents.length === 1 ? "" : "s"}). Ya puedes responder.
            </p>
          ) : null}
          <QuizForm
            courseId={courseId}
            assessmentType="topic"
            topicId={topic.id}
            questions={topic.questions}
            submitLabel="Corregir intento"
            passed={topic.quizPassed}
          />
        </div>
      )}

      <section className="card p-5 text-xs muted">
        <p className="font-semibold text-[var(--foreground)]">Cómo se corrige</p>
        <p className="mt-2 leading-relaxed">
          Hace falta acertar todas las preguntas en el mismo intento. Los intentos se guardan con
          fecha y resultado; los fallidos no penalizan ni bloquean nada.
        </p>
      </section>
    </div>
  );
}
