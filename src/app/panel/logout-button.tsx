"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { logout } from "@/lib/firebase/client";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      className="btn btn-secondary"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await logout();
        router.push("/login");
        router.refresh();
      }}
    >
      {pending ? "Saliendo…" : "Cerrar sesión"}
    </button>
  );
}
