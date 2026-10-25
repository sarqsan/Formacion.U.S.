"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { logout } from "@/lib/firebase/client";
import { PASSWORD_POLICY } from "@/domain/auth/activation";

/**
 * Formulario de cambio de contraseña de la propia cuenta.
 *
 * La comprobación de la contraseña actual y la política se aplican **en el
 * servidor**; aquí solo se evita un viaje inútil (campos vacíos, contraseñas
 * que no coinciden) y se muestran las reglas antes de escribir.
 */
export function PasswordForm({ username }: { username: string | null }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordRepeat, setNewPasswordRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!currentPassword || !newPassword || !newPasswordRepeat) {
      setError("Rellena los tres campos.");
      return;
    }
    if (newPassword !== newPasswordRepeat) {
      setError("Las dos contraseñas nuevas no coinciden.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("La contraseña nueva debe ser distinta de la actual.");
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, newPasswordRepeat }),
      });

      const data = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;

      if (!response.ok) {
        setError(data?.error?.message ?? "No se ha podido cambiar la contraseña.");
        setPending(false);
        return;
      }

      // La sesión está revocada en el servidor: se cierra también en el
      // navegador y se vuelve al acceso con la contraseña nueva.
      await logout();
      router.push("/login?password=cambiada");
      router.refresh();
    } catch {
      setError("No se ha podido contactar con el servidor. Inténtalo de nuevo.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {username ? (
        <p className="muted text-sm">
          Cuenta: <span className="mono">{username}</span>
        </p>
      ) : null}

      <div>
        <label className="label" htmlFor="currentPassword">
          Contraseña actual
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          className="input"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
        />
      </div>

      <div>
        <label className="label" htmlFor="newPassword">
          Contraseña nueva
        </label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          className="input"
          minLength={PASSWORD_POLICY.minLength}
          maxLength={PASSWORD_POLICY.maxLength}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
        />
        <p className="muted mt-1 text-xs">
          Entre {PASSWORD_POLICY.minLength} y {PASSWORD_POLICY.maxLength} caracteres, con una
          minúscula, una mayúscula y un número. No puede ser igual a la actual ni contener tu
          nombre de usuario.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="newPasswordRepeat">
          Repite la contraseña nueva
        </label>
        <input
          id="newPasswordRepeat"
          name="newPasswordRepeat"
          type="password"
          autoComplete="new-password"
          className="input"
          minLength={PASSWORD_POLICY.minLength}
          maxLength={PASSWORD_POLICY.maxLength}
          value={newPasswordRepeat}
          onChange={(event) => setNewPasswordRepeat(event.target.value)}
          required
        />
      </div>

      {error ? (
        <p role="alert" className="alert alert-error text-sm">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Cambiando…" : "Cambiar contraseña"}
        </button>
        <span className="muted text-xs">
          Al cambiarla se cierran las sesiones abiertas y tendrás que entrar de nuevo.
        </span>
      </div>
    </form>
  );
}
