#!/usr/bin/env node
// =============================================
// 签名并组装远程规则包 bundle（ADR-0050）
// =============================================
// 用法:
//   node scripts/sign-rule-pack.mjs [--packs <dir>] [--bundle-version N] [--out <dir>]
// 产出:
//   dist-rule-packs/bundle.json
//   （首次运行生成 scripts/keys/private.jwk；公钥 JWK 需填入
//     src/rule-packs/remote.ts 的 BUNDLE_PUBLIC_KEY_JWK）
//
// 签名格式与扩展侧约定：
//   canonicalize(递归键排序 JSON) → ECDSA P-256 SHA-256 → IEEE P1363 → base64url
//   （Node 侧用 dsaEncoding:"ieee-p1363" 与 Web Crypto verify 对齐）

import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KEYS_DIR = join(ROOT, "scripts", "keys");
const PRIVATE_KEY_FILE = join(KEYS_DIR, "private.jwk");

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PACKS_DIR = argValue("--packs", join(ROOT, "src", "rule-packs", "packs"));
const BUNDLE_VERSION = Number(argValue("--bundle-version", "1"));
const OUT_DIR = argValue("--out", join(ROOT, "dist-rule-packs"));

// ---- 规范化 JSON（递归键排序），Node 与扩展侧保持一致 ----
export function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function ensureKeyPair() {
  if (existsSync(PRIVATE_KEY_FILE)) {
    return JSON.parse(readFileSync(PRIVATE_KEY_FILE, "utf8"));
  }
  console.error("生成新 P-256 密钥对…（私钥仅存本机；公钥需填入 remote.ts）");
  mkdirSync(KEYS_DIR, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  writeFileSync(PRIVATE_KEY_FILE, JSON.stringify(privateJwk, null, 2));
  console.error("私钥已保存:", PRIVATE_KEY_FILE);
  console.error("公钥 JWK（填入 remote.ts BUNDLE_PUBLIC_KEY_JWK）:");
  console.error(JSON.stringify(publicJwk));
  return privateJwk;
}

function loadPacks() {
  const files = readdirSync(PACKS_DIR).filter((f) => f.endsWith(".json"));
  const packs = files
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(PACKS_DIR, f), "utf8"));
      } catch (error) {
        console.error(`跳过无法解析的包: ${f} (${error.message})`);
        return null;
      }
    })
    .filter(Boolean);
  if (packs.length === 0) {
    throw new Error(`packs 目录无可用包: ${PACKS_DIR}`);
  }
  return packs;
}

// ---- 主流程 ----
const privateJwk = ensureKeyPair();
const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
const packs = loadPacks();

// 一致性自检：bundle 内 pack 必须可被扩展侧 schema 接受（松散检查顶层字段）
for (const pack of packs) {
  if (!pack.id || !pack.schemaVersion || !Array.isArray(pack.pages)) {
    throw new Error(`包缺少必要字段: ${pack.id || "(unknown)"}（id/schemaVersion/pages）`);
  }
}

const payload = {
  schemaVersion: "1",
  bundleVersion: BUNDLE_VERSION,
  packages: packs,
};
const canonicalBytes = Buffer.from(canonicalize(payload), "utf8");
const digest = createHash("sha256").update(canonicalBytes).digest("hex");
const signature = sign(null, canonicalBytes, { key: privateKey, dsaEncoding: "ieee-p1363" });

const bundle = { ...payload, signature: base64url(signature) };
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, "bundle.json"),
  JSON.stringify(bundle, null, 2),
);
console.log(`✅ bundle.json 已生成（${packs.length} 个包, bundleVersion=${BUNDLE_VERSION}）`);
console.log(`   输出: ${join(OUT_DIR, "bundle.json")}`);
console.log(`   sha256: ${digest}`);
console.log(`   签名长度: ${signature.length} 字节 (P1363)`);