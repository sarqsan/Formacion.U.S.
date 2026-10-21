"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { logout } from "@/lib/firebase/client";
import { exitDemoSession } from "@/app/actions/demo";

/**
 * Cierre de sesión. En modo demostración se borra la cookie de demostración;
 * en modo real se cierra la sesión de Firebase y se llama a la API de sesión.
 */
export function SessionControls({ mode }: { mode: "demo" | "firebase" | "unconfigured" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  if (mode === "unconfigured") return null;

  async function signOut() {
    setPending(true);
    if (mode === "demo") {
      await exitDemoSession();
      return;
    }

    await logout();
    router.push("/login");
    router.refresh();
  }

  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={signOut} disabled={pending}>
      {pending ? "Saliendo…" : "Salir"}
    </button>
  );
}
