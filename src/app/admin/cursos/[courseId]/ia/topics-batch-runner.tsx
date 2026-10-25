"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * PROPUESTA DE TEMAS POR TANDAS
 * =============================
 *
 * El plan gratuito de Groq mide la cuota **por minuto** y una función de Vercel
 * corta a los 300 s, así que un temario largo no cabe en una sola petición. En
 * lugar de rechazar el documento, el trabajo se reparte:
 *
 *   1. `plan`   el servidor extrae el texto y lo parte en tandas (sin IA);
 *   2. `batch`  una petición = una tanda = una llamada al modelo;
 *   3. `save`   cuando están todas, se guarda el plan completo de una vez.
 *
 * La espera entre tandas la hace este componente, no el servidor: así ninguna
 * función se queda dormida y el administrador ve el avance real.
 *
 * Nada se escribe en el borrador hasta el último paso: si se cierra la pestaña
 * a mitad, lo único que se pierde es el avance (que además se guarda en
 * `sessionStorage` para poder continuar sin repetir lo ya gastado).
 */

interface Batch {
  index: number;
  from: number;
  to: number;
  pages: number[];
  tokens: number;
}

interface Plan {
  totalPages: number;
  estimatedSeconds: number;
  tokensPerMinute: number;
  batches: Batch[];
}

interface Topic {
  title: string;
  pages: number[];
  summary: string | null;
}

interface StoredProgress {
  version: number;
  completed: Record<number, Topic[]>;
  notes: string[];
}

function storageKey(courseId: string): string {
  return `formacionus:ai-topics:${courseId}`;
}

function minutes(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  return `${Math.round(seconds / 60)} min`;
}

export function TopicsBatchRunner({
  courseId,
  version,
  revision,
  disabled,
}: {
  courseId: string;
  version: number;
  /** Revisión del borrador que tenía la pantalla al pintarse. */
  revision: number;
  disabled: boolean;
}) {
  const router = useRouter();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [done, setDone] = useState(0);
  const [status, setStatus] = useState<"idle" | "planning" | "running" | "saving" | "error" | "cancelled">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [currentLabel, setCurrentLabel] = useState<string | null>(null);
  const [resumeOffset, setResumeOffset] = useState(0);

  const topicsRef = useRef<Topic[]>([]);
  const notesRef = useRef<string[]>([]);
  const completedRef = useRef<Record<number, Topic[]>>({});
  const cancelRef = useRef(false);

  const persist = useCallback(() => {
    try {
      const payload: StoredProgress = {
        version,
        completed: completedRef.current,
        notes: notesRef.current,
      };
      window.sessionStorage.setItem(storageKey(courseId), JSON.stringify(payload));
    } catch {
      // Sin almacenamiento (modo privado agresivo): se sigue sin poder reanudar.
    }
  }, [courseId, version]);

  /*
   * Al montar, se mira si quedó una propuesta a medias de este mismo borrador.
   *
   * Va en un efecto a propósito: `sessionStorage` solo existe en el navegador,
   * y leerlo durante el render rompería la hidratación (el HTML del servidor
   * nunca puede saber si hay avance guardado). Es una lectura única al montar,
   * no un estado que se recalcule.
   */
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(storageKey(courseId));
      if (!raw) return;
      const stored = JSON.parse(raw) as StoredProgress;
      if (stored.version !== version) return;
      const completed = stored.completed ?? {};
      if (Object.keys(completed).length === 0) return;

      topicsRef.current = Object.values(completed).flat();
      notesRef.current = stored.notes ?? [];
      completedRef.current = completed;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restauración única al montar (ver comentario)
      setDone(Object.keys(completed).length);
      setResumeOffset(Object.keys(completed).length);
      setMessage(
        `Hay una propuesta a medias de este borrador (${Object.keys(completed).length} tanda(s) ya procesadas). Puedes continuar sin repetirlas.`,
      );
      setStatus("cancelled");
    } catch {
      // Datos viejos o corruptos: se ignoran.
    }
  }, [courseId, version]);

  const post = useCallback(async <T,>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`/api/admin/courses/${encodeURIComponent(courseId)}/ai/topics/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: { message?: string }; [key: string]: unknown }
      | null;

    if (!response.ok || payload?.ok === false) {
      const message =
        (payload?.error?.message as string | undefined) ??
        `La petición falló (HTTP ${response.status}).`;
      throw new Error(message);
    }
    return payload as T;
  }, [courseId]);

  const save = useCallback(async () => {
    setStatus("saving");
    setCurrentLabel("Guardando los temas en el borrador…");

    const notes = notesRef.current.join(" ").slice(0, 800);
    const saved = await post<{ topics: Topic[]; revision: number }>("save", {
      version,
      expectedRevision: revision,
      topics: topicsRef.current,
      notes: notes === "" ? null : notes,
    });

    try {
      window.sessionStorage.removeItem(storageKey(courseId));
    } catch {
      // Irrelevante: sin almacenamiento no hay nada que limpiar.
    }

    setStatus("idle");
    setCurrentLabel(null);
    const base = `/admin/cursos/${encodeURIComponent(courseId)}/ia`;
    const query = new URLSearchParams({
      v: String(version),
      paso: "2",
      ok: `temas-${saved.topics.length}`,
    });
    if (notes !== "") query.set("nota", notes);
    router.push(`${base}?${query.toString()}`);
    router.refresh();
  }, [courseId, post, revision, router, version]);

  const run = useCallback(async () => {
    cancelRef.current = false;
    setStatus("planning");
    setMessage(null);
    setCurrentLabel("Preparando el temario…");

    try {
      const planned = await post<Plan>("plan", { version });
      setPlan(planned);

      const pending = planned.batches.filter((batch) => !(batch.index in completedRef.current));
      if (pending.length === 0) {
        await save();
        return;
      }

      setStatus("running");

      for (const batch of pending) {
        if (cancelRef.current) {
          setStatus("cancelled");
          setMessage("Detenido. Lo ya procesado queda guardado para continuar más tarde.");
          return;
        }

        setCurrentLabel(
          `Tanda ${batch.index + 1} de ${planned.batches.length} · páginas ${batch.from}–${batch.to}`,
        );

        const result = await post<{ topics: Topic[]; notes: string | null; nextDelayMs: number }>(
          "batch",
          { version, from: batch.from, to: batch.to },
        );

        completedRef.current[batch.index] = result.topics;
        topicsRef.current = Object.values(completedRef.current).flat();
        if (result.notes) notesRef.current.push(result.notes);
        setDone(Object.keys(completedRef.current).length);
        persist();

        const isLast = batch.index === pending[pending.length - 1].index;
        if (!isLast && result.nextDelayMs > 0) {
          setCurrentLabel(
            `Tanda ${batch.index + 1} de ${planned.batches.length} hecha · esperando ${Math.ceil(
              result.nextDelayMs / 1000,
            )} s por la cuota del plan gratuito`,
          );
          await new Promise((resolve) => setTimeout(resolve, result.nextDelayMs));
        }
      }

      await save();
    } catch (error) {
      setStatus("error");
      setCurrentLabel(null);
      setMessage(error instanceof Error ? error.message : "No se pudo completar la propuesta.");
    }
  }, [persist, post, save, version]);

  const total = plan?.batches.length ?? resumeOffset;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const remaining = plan ? Math.round((plan.estimatedSeconds * Math.max(0, total - done)) / Math.max(1, total)) : 0;
  const busy = status === "planning" || status === "running" || status === "saving";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={disabled || busy}
          onClick={() => void run()}
        >
          {busy ? "Trabajando…" : done > 0 && status === "cancelled" ? "Continuar la propuesta" : "Proponer temas con IA"}
        </button>

        {busy ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              cancelRef.current = true;
            }}
          >
            Detener
          </button>
        ) : null}

        {plan ? (
          <span className="muted text-xs">
            {plan.totalPages} páginas · {total} tanda(s) · {done} hecha(s)
            {remaining > 0 ? ` · ~${minutes(remaining)} restantes` : ""}
          </span>
        ) : null}
      </div>

      {busy ? (
        <div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-[#e6ebe4]"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full rounded-full bg-[var(--accent)] transition-all" style={{ width: `${percent}%` }} />
          </div>
          <p className="muted mt-1 text-xs">{currentLabel}</p>
        </div>
      ) : null}

      {message ? (
        <p className={`text-xs leading-relaxed ${status === "error" ? "alert alert-error" : "alert alert-info"}`}>
          {message}
        </p>
      ) : null}

      <p className="muted text-xs leading-relaxed">
        El PDF se parte en tandas de una llamada cada una: así cabe un temario de cualquier tamaño, aunque
        tarde más. Nada se guarda hasta el final, y el avance se conserva si cierras la pestaña.
      </p>
    </div>
  );
}
