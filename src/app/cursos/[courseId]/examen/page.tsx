import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { courseViewForLearner } from "@/server/portal";
import { QuizForm } from "../quiz-form";
import { DomainError } from "@/domain/text";

export const dynamic = "force-dynamic";

export default async function FinalExamPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
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

  const pendingTopics = view.topics.filter((topic) => !topic.quizPassed);

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
        / <span>Examen final</span>
      </nav>

      <div>
        <p className="eyebrow">Evaluación final · versión {view.version}</p>
        <h1 className="page-title mt-1">Examen final</h1>
        <p className="muted mt-2 text-sm">
          {view.finalExam.attempts} intento(s) · mejor resultado {view.finalExam.bestScore}%
          {view.finalExam.passed ? " · superado" : ""}
        </p>
      </div>

      {!view.finalExam.unlocked ? (
        <div className="card p-5">
          <h2 className="text-sm font-semibold">Todavía bloqueado</h2>
          <p className="muted mt-2 text-sm leading-relaxed">
            El examen final se abre al superar todos los temas obligatorios.{" "}
            {pendingTopics.length === 1
              ? "Te queda un tema:"
              : `Te quedan ${pendingTopics.length} temas:`}
          </p>
          <ul className="mt-2 list-disc pl-5 text-sm">
            {pendingTopics.map((topic) => (
              <li key={topic.id}>
                <Link
                  href={`/cursos/${courseId}/temas/${topic.id}`}
                  className="underline font-medium"
                >
                  {topic.title}
                </Link>
              </li>
            ))}
          </ul>
          <p className="muted mt-3 text-xs">
            La comprobación se hace en el servidor: no basta con abrir esta dirección.
          </p>
          <Link href={`/cursos/${courseId}`} className="btn btn-secondary mt-4">
            Volver al temario
          </Link>
        </div>
      ) : (
        <QuizForm
          courseId={courseId}
          assessmentType="final"
          questions={view.finalExam.questions}
          submitLabel="Entregar examen"
          passed={view.finalExam.passed}
        />
      )}
    </div>
  );
}
