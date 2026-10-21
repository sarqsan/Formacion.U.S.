import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { DomainError } from "@/domain/text";

/**
 * CIFRADO DE LA COPIA DE SEGURIDAD
 * ================================
 *
 * La copia contiene todo lo necesario para reconstruir la aplicación: cuentas
 * (con nombres), claves de corrección de los cuestionarios y los PDF. En disco
 * **no puede quedar nada legible**.
 *
 * Diseño:
 *   · AES-256-GCM (cifra + autentica: detecta cualquier manipulación);
 *   · clave derivada de una contraseña con scrypt (N=32768, r=8, p=1);
 *   · sal e IV aleatorios por colección, guardados junto al texto cifrado;
 *   · SHA-256 del texto plano para comprobar la integridad del contenido ya
 *     descifrado;
 *   · ninguna contraseña ni clave se escribe en el fichero ni en los logs.
 *
 * Lo que esto **no** hace: proteger la copia de alguien que conozca la
 * contraseña, ni sustituir el cifrado del disco o del transporte.
 */

export const KDF = { name: "scrypt", N: 32768, r: 8, p: 1, keyLen: 32 } as const;
export const CIPHER = "aes-256-gcm" as const;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const MIN_PASSPHRASE_LENGTH = 12;

export interface CryptoSettings {
  salt: string;
  iv: string;
  tag: string;
  sha256: string;
}

export function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new DomainError(
      "BACKUP_PASSPHRASE_WEAK",
      `La contraseña de la copia debe tener al menos ${MIN_PASSPHRASE_LENGTH} caracteres (variable BACKUP_PASSPHRASE).`,
      400,
    );
  }
}

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // `maxmem` explícito: con N=32768 el cálculo necesita ~32 MiB.
  return scryptSync(passphrase.normalize("NFKC"), salt, KDF.keyLen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 64 * 1024 * 1024,
  });
}

export interface Encryptor {
  update(chunk: Buffer): Buffer;
  /** Cierra el cifrado y devuelve el resto de texto cifrado, la etiqueta y la huella. */
  final(): { trailing: Buffer; tag: Buffer; sha256: string; plainBytes: number };
}

/**
 * Una sola sal y una sola clave por archivo: el coste de scrypt (~100 ms) se
 * paga una vez, no una por colección. Cada bloque lleva su propio IV aleatorio,
 * que es lo que exige GCM para no reutilizar nunca el par clave/IV.
 */
export function newSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/** Cifrador incremental (un bloque por colección, para no cargar 500 MiB en RAM). */
export function createEncryptor(key: Buffer): {
  encryptor: Encryptor;
  settings: { iv: string };
} {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  const hash = createHash("sha256");
  let plainBytes = 0;

  return {
    settings: { iv: iv.toString("base64") },
    encryptor: {
      update(chunk: Buffer) {
        hash.update(chunk);
        plainBytes += chunk.length;
        return cipher.update(chunk);
      },
      final() {
        const trailing = cipher.final();
        return {
          trailing,
          tag: cipher.getAuthTag(),
          sha256: hash.digest("hex"),
          plainBytes,
        };
      },
    },
  };
}

export interface Decryptor {
  update(chunk: Buffer): Buffer;
  final(): { sha256: string };
}

export function createDecryptor(
  key: Buffer,
  settings: Pick<CryptoSettings, "iv" | "tag">,
): Decryptor {
  const iv = Buffer.from(settings.iv, "base64");
  const tag = Buffer.from(settings.tag, "base64");

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DomainError("BACKUP_CORRUPT", "La copia tiene parámetros de cifrado no válidos.", 422);
  }

  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(tag);
  const hash = createHash("sha256");

  return {
    update(chunk: Buffer) {
      const output = decipher.update(chunk);
      hash.update(output);
      return output;
    },
    final() {
      // Lanza si la autenticación falla: contraseña incorrecta o copia alterada.
      const last = decipher.final();
      if (last.length > 0) hash.update(last);
      return { sha256: hash.digest("hex") };
    },
  };
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
