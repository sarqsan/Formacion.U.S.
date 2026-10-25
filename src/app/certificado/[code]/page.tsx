import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { certificateRecordFor } from "@/server/portal";
import { certificateVerifyUrl } from "@/server/certificates/file";
import { requestOrigin } from "@/server/certificates/origin";
import { formatCertificateDate } from "@/domain/certificates/certificate";
import { DomainError } from "@/domain/text";
import { DataUnavailable, isUnavailable } from "@/app/components/data-unavailable";

export const dynamic = "force-dynamic";

/**
 * MI CERTIFICADO
 * ==============
 *
 * Ficha del certificado emitido: lo que dice el PDF, en pantalla, más el enlace
 * público de verificación.
 *
 * Solo la ve el titular o administración (lo decide el servicio, no esta
 * página). Si alguien abre el enlace del certificado de otra persona, ve un
 * mensaje claro y **no** el nombre completo ni el botón de descarga.
 */
export default async function CertificatePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const session = await getUiSession();
  if (session.mode === "unconfigured") redirect("/login");
  if (!session.actor) redirect("/login");

  let record: Awaited<ReturnType<typeof certificateRecordFor>> | null = null;
  let failure: string | null = null;
  let forbidden = false;

  try {
    record = await certificateRecordFor(session.actor, code);
  } catch (error) {
    if (isUnavailable(error)) {
      return <DataUnavailable detail={error instanceof Error ? error.message : undefined} />;
    }
    if (error instanceof DomainError) {
      failure = error.message;
      forbidden = error.status === 403;
    } else {
      throw error;
    }
  }

  if (failure || !record) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <nav className="text-xs muted">
          <Link href="/panel" className="underline">
            Mi formación
          </Link>{" "}
          / <span>Certificado</span>
        </nav>
        <div className="card p-6">
          <h1 className="page-title">No se puede abrir este certificado</h1>
          <p className="muted mt-2 text-sm leading-relaxed">{failure}</p>
          <p className="muted mt-3 text-xs leading-relaxed">
            Un certificado pertenece a la persona que lo obtuvo. Si necesitas comprobar uno ajeno,
            usa la página pública de verificación con su código: muestra el curso, la fecha y el
            nombre enmascarado, sin identificarlo.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href={`/verificar/${encodeURIComponent(code)}`} className="btn btn-secondary btn-sm">
              Verificar un código
            </Link>
            {forbidden ? null : (
              <Link href="/panel" className="btn btn-primary btn-sm">
                Volver a mi formación
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  const verifyUrl = certificateVerifyUrl(await requestOrigin(), record.code);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <nav className="text-xs muted">
        <Link href={session.actor.role === "admin" ? "/admin/progreso" : "/panel"} className="underline">
          {session.actor.role === "admin" ? "Progreso" : "Mi formación"}
        </Link>{" "}
        / <span>Certificado</span>
      </nav>

      <article className="card p-6">
        <p className="eyebrow">Formación U.G.–U.S.</p>
        <h1 className="page-title mt-1">Certificado de aprovechamiento</h1>

        <p className="muted mt-4 text-xs uppercase tracking-wide">A nombre de</p>
        <p className="mt-1 text-lg font-semibold">{record.displayName}</p>
        <p className="muted text-xs">
          Usuario <span className="mono">{record.username}</span>
        </p>

        <dl className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="muted text-xs uppercase tracking-wide">Curso</dt>
            <dd className="mt-1 text-sm font-medium">{record.courseTitle}</dd>
          </div>
          <div>
            <dt className="muted text-xs uppercase tracking-wide">Versión cursada</dt>
            <dd className="mt-1 text-sm font-medium">Versión {record.version}</dd>
          </div>
          <div>
            <dt className="muted text-xs uppercase tracking-wide">Fecha de finalización</dt>
            <dd className="mt-1 text-sm font-medium">{formatCertificateDate(record.completedAt)}</dd>
          </div>
          <div>
            <dt className="muted text-xs uppercase tracking-wide">Fecha de emisión</dt>
            <dd className="mt-1 text-sm font-medium">{formatCertificateDate(record.issuedAt)}</dd>
          </div>
        </dl>

        <div className="mt-5 rounded-md bg-[#f4f6f3] p-3">
          <p className="muted text-xs uppercase tracking-wide">Código de verificación</p>
          <p className="mono mt-1 select-all text-sm break-all">{record.code}</p>
          <p className="muted mt-2 break-all text-xs">{verifyUrl}</p>
        </div>

        <p className="muted mt-4 text-xs leading-relaxed">
          El curso y la versión quedaron fijados al emitir el certificado: si el curso se actualiza
          después, este documento sigue diciendo lo que se cursó. No lleva firma manuscrita; su
          autenticidad se comprueba con el código.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <a href={`/api/certificates/${record.code}/file`} className="btn btn-primary btn-sm" download>
            Descargar en PDF
          </a>
          <a
            href={`/verificar/${record.code}`}
            className="btn btn-secondary btn-sm"
            target="_blank"
            rel="noreferrer"
          >
            Ver cómo lo ve un tercero
          </a>
        </div>
      </article>

      {session.mode === "demo" ? (
        <p className="muted text-xs">
          Demostración: el PDF se genera al descargarlo y no se guarda ningún fichero. Al reiniciar
          la demostración, los certificados emitidos desaparecen.
        </p>
      ) : null}
    </div>
  );
}
