// End-to-end encryption for the sync repository.
// passphrase --PBKDF2-SHA256(salt, iterations)--> 64 bytes
//   bytes 0..31  -> AES-256-GCM key (object bodies, snapshots)
//   bytes 32..63 -> HMAC-SHA256 key (object names)
// Object names are HMAC(content), so equal content dedupes across devices but
// the bucket never sees a plain content hash (no guessing known plaintexts).

import { CoreError } from "../types";
import { ab, concat, fromBase64, fromUtf8, hex, randomId, subtle, toBase64, utf8, type WebCryptoKey } from "./bytes";

export const DEFAULT_KDF_ITERATIONS = 310_000;
const FORMAT_BYTE = 0x01;
const CHECK_TEXT = "offeru-sync-check-v1";

export type RepoKeyFile = {
  format: "offeru-sync/1";
  kdf: { name: "PBKDF2-SHA256"; iterations: number; salt: string };
  /** AES-GCM(CHECK_TEXT): lets a device tell a wrong passphrase from corrupt data. */
  check: string;
  created_at: string;
};

export class RepoKeys {
  private constructor(private readonly aes: WebCryptoKey, private readonly mac: WebCryptoKey) {}

  static async derive(passphrase: string, salt: Uint8Array, iterations: number): Promise<RepoKeys> {
    if (!passphrase) throw new CoreError("没填同步口令", "invalid");
    const base = await subtle().importKey("raw", ab(utf8(passphrase)), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: ab(salt), iterations }, base, 512));
    const aes = await subtle().importKey("raw", ab(bits.subarray(0, 32)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const mac = await subtle().importKey("raw", ab(bits.subarray(32, 64)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    bits.fill(0);
    return new RepoKeys(aes, mac);
  }

  /** New repository key file + keys for it. */
  static async create(passphrase: string, iterations = DEFAULT_KDF_ITERATIONS, now = new Date().toISOString()): Promise<{ file: RepoKeyFile; keys: RepoKeys }> {
    const salt = new Uint8Array(16);
    globalThis.crypto.getRandomValues(salt);
    const keys = await RepoKeys.derive(passphrase, salt, iterations);
    const file: RepoKeyFile = {
      format: "offeru-sync/1",
      kdf: { name: "PBKDF2-SHA256", iterations, salt: toBase64(salt) },
      check: toBase64(await keys.encrypt(utf8(CHECK_TEXT))),
      created_at: now,
    };
    return { file, keys };
  }

  /** Keys for an existing repository; CoreError("forbidden") on a wrong passphrase. */
  static async open(passphrase: string, file: RepoKeyFile): Promise<RepoKeys> {
    if (file?.format !== "offeru-sync/1" || file.kdf?.name !== "PBKDF2-SHA256") {
      throw new CoreError("远端同步仓库格式不认识（可能是更新版本的 OfferU 建的）", "unsupported");
    }
    const keys = await RepoKeys.derive(passphrase, fromBase64(file.kdf.salt), file.kdf.iterations);
    let text = "";
    try {
      text = fromUtf8(await keys.decrypt(fromBase64(file.check)));
    } catch { /* wrong key */ }
    if (text !== CHECK_TEXT) throw new CoreError("同步口令不对：和建这个同步仓库时用的口令不一致", "forbidden");
    return keys;
  }

  async encrypt(plain: Uint8Array): Promise<Uint8Array> {
    const iv = new Uint8Array(12);
    globalThis.crypto.getRandomValues(iv);
    const sealed = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: ab(iv) }, this.aes, ab(plain)));
    return concat(Uint8Array.of(FORMAT_BYTE), iv, sealed);
  }

  /** Throws on tampering / wrong key (AES-GCM tag check). */
  async decrypt(sealed: Uint8Array): Promise<Uint8Array> {
    if (sealed[0] !== FORMAT_BYTE || sealed.length < 1 + 12 + 16) throw new Error("bad sealed object");
    const iv = sealed.subarray(1, 13);
    return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: ab(iv) }, this.aes, ab(sealed.subarray(13))));
  }

  /** Content address: hex HMAC of the plaintext. */
  async objectId(plain: Uint8Array): Promise<string> {
    return hex(await subtle().sign("HMAC", this.mac, ab(plain)));
  }
}

export { randomId };
