"use client";

import { useState } from "react";

const REQUIREMENTS = [
  "Mínimo 12 caracteres (máximo 128).",
  "Al menos una minúscula, una mayúscula y un número.",
  "No puede contener tu nombre de usuario.",
];

export function ActivateForm() {
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password !== repeat) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, token, newPassword: password }),
      });

      const data = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;

      if (!response.ok) {
        setError(data?.error?.message ?? "No se ha podido activar la cuenta.");
        setPending(false);
        return;
      }

      setDone(true);
      setPassword("");
      setRepeat("");
      setToken("");
    } catch {
      setError("Error de conexión. Inténtalo de nuevo.");
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-3">
        <p className="rounded-md bg-[var(--accent-soft)] px-3 py-2 text-sm text-[var(--accent)]">
          Cuenta activada. Ya puedes iniciar sesión con tu usuario y tu contraseña.
        </p>
        <a href="/login" className="btn btn-primary w-full">
          Ir a iniciar sesión
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="label" htmlFor="activate-username">
          Usuario
        </label>
        <input
          id="activate-username"
          className="input"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="rol1.garcia"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </div>

      <div>
        <label className="label" htmlFor="activate-token">
          Código de activación
        </label>
        <input
          id="activate-token"
          className="input font-mono"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Código entregado por administración"
          value={token}
          onChange={(event) => setToken(event.target.value.trim())}
          required
        />
        <p className="muted mt-1 text-xs">
          Caduca a los 3 días y solo se puede usar una vez.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="activate-password">
          Contraseña nueva
        </label>
        <input
          id="activate-password"
          type="password"
          className="input"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>

      <div>
        <label className="label" htmlFor="activate-repeat">
          Repite la contraseña
        </label>
        <input
          id="activate-repeat"
          type="password"
          className="input"
          autoComplete="new-password"
          value={repeat}
          onChange={(event) => setRepeat(event.target.value)}
          required
        />
      </div>

      <ul className="muted list-disc space-y-1 pl-5 text-xs">
        {REQUIREMENTS.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      {error ? (
        <p role="alert" className="rounded-md bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Activando…" : "Activar cuenta"}
      </button>
    </form>
  );
}
