import { redirect } from "next/navigation";
import { isCertificateCode } from "@/domain/certificates/certificate";

export const dynamic = "force-dynamic";

/**
 * VERIFICAR UN CERTIFICADO
 * ========================
 *
 * Formulario público: se pega el código del certificado y se comprueba si
 * existe. No hay sesión ni contraseña, y no se puede listar nada: cada código
 * solo responde por sí mismo.
 *
 * La comprobación de forma va aquí (y en el servicio) porque evita una consulta
 * inútil a la base de datos y da un mensaje útil al momento.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ codigo?: string }>;
}) {
  const { codigo } = await searchParams;
  const clean = (codigo ?? "").trim().toLowerCase();

  if (clean) {
    if (isCertificateCode(clean)) redirect(`/verificar/${clean}`);
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <div className="card p-6">
          <h1 className="page-title">Verificar un certificado</h1>
          <p className="alert alert-warn mt-3 text-sm">
            Ese código no tiene la forma correcta. Son 20 caracteres: solo números del 0 al 9 y
            letras de la a a la f.
          </p>
          <form action="/verificar" method="get" className="mt-4 flex flex-wrap items-end gap-2">
            <label className="flex-1">
              <span className="muted text-xs uppercase tracking-wide">Código del certificado</span>
              <input
                name="codigo"
                defaultValue={codigo ?? ""}
                className="input mono mt-1"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </label>
            <button type="submit" className="btn btn-primary">
              Verificar
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="card p-6">
        <p className="eyebrow">Comprobación pública</p>
        <h1 className="page-title mt-1">Verificar un certificado</h1>
        <p className="muted mt-2 text-sm leading-relaxed">
          Pega el código que aparece al pie del certificado (20 caracteres, sin espacios). Se
          mostrarán el curso, la versión, las fechas y el nombre enmascarado de la persona: lo
          justo para comprobar que el documento es auténtico sin identificarla.
        </p>

        <form action="/verificar" method="get" className="mt-4 flex flex-wrap items-end gap-2">
          <label className="flex-1">
            <span className="muted text-xs uppercase tracking-wide">Código del certificado</span>
            <input
              name="codigo"
              className="input mono mt-1"
              placeholder="p. ej. 4f1c0a9b7e2d6538ac41"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
          <button type="submit" className="btn btn-primary">
            Verificar
          </button>
        </form>

        <p className="muted mt-4 text-xs leading-relaxed">
          Esta página no guarda lo que buscas ni permite ver certificados de otras personas: cada
          código responde solo por sí mismo. Si eres el titular del certificado y quieres el PDF,
          entra en «Mi formación» con tu cuenta.
        </p>
      </div>
    </div>
  );
}
