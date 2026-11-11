// Provider config is plaintext; the API key is either in this module's memory
// or encrypted with a non-extractable device key before localforage stores it.
// This protects at-rest IndexedDB only; same-origin script can still use the key.

import localforage from "localforage";

export type AgentConfig = {
  baseUrl: string;
  model: string;
  remember: boolean;
  apiKey: string;
};

type StoredConfig = Omit<AgentConfig, "apiKey"> & { secret?: EncryptedSecret };
type EncryptedSecret = { v: 1; iv: string; data: string };

const configStore = localforage.createInstance({ name: "offeru-demo-agent", storeName: "config" });
const CONFIG_KEY = "provider:v1";
const DB_NAME = "offeru-demo-agent-vault";
const DB_STORE = "keys";
const DEVICE_KEY = "device";

let memoryKey = "";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前浏览器不支持 IndexedDB，无法记住 Key。"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("打开浏览器密钥库失败"));
  });
}

function readDeviceKey(): Promise<CryptoKey | null> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const request = tx.objectStore(DB_STORE).get(DEVICE_KEY);
    request.onsuccess = () => resolve(request.result instanceof CryptoKey ? request.result : null);
    request.onerror = () => reject(request.error ?? new Error("读取设备密钥失败"));
  }));
}

function writeDeviceKey(key: CryptoKey): Promise<void> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(key, DEVICE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("保存设备密钥失败"));
  }));
}

async function deviceKey(): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new Error("当前页面没有 WebCrypto，无法加密记住 Key。");
  const existing = await readDeviceKey();
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await writeDeviceKey(key);
  return key;
}

async function encrypt(apiKey: string): Promise<EncryptedSecret> {
  if (!apiKey) return { v: 1, iv: "", data: "" };
  const key = await deviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, key, encoder.encode(apiKey).buffer as ArrayBuffer);
  return { v: 1, iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ciphertext)) };
}

async function decrypt(secret: EncryptedSecret | undefined): Promise<string> {
  if (!secret?.iv || !secret.data) return "";
  const key = await deviceKey();
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(secret.iv).buffer as ArrayBuffer },
      key,
      base64ToBytes(secret.data).buffer as ArrayBuffer,
    );
    return decoder.decode(plaintext);
  } catch {
    throw new Error("本机保存的 Key 解不开（可能清过站点数据）。请重新填写。");
  }
}

export async function loadAgentConfig(): Promise<AgentConfig | null> {
  const stored = await configStore.getItem<StoredConfig>(CONFIG_KEY);
  if (!stored) return null;
  const apiKey = stored.remember ? await decrypt(stored.secret) : memoryKey;
  return { baseUrl: stored.baseUrl, model: stored.model, remember: stored.remember, apiKey };
}

export async function saveAgentConfig(config: AgentConfig): Promise<AgentConfig> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Base URL 要是 http(s) 地址。");
  if (!config.model.trim()) throw new Error("请填写模型名。");
  if (!config.apiKey.trim()) throw new Error("请填写 API Key。");
  const normalized: AgentConfig = {
    baseUrl,
    model: config.model.trim(),
    remember: config.remember,
    apiKey: config.apiKey.trim(),
  };
  const stored: StoredConfig = {
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    remember: normalized.remember,
    ...(normalized.remember ? { secret: await encrypt(normalized.apiKey) } : {}),
  };
  await configStore.setItem(CONFIG_KEY, stored);
  memoryKey = normalized.remember ? "" : normalized.apiKey;
  return normalized;
}

export async function forgetAgentKey(): Promise<void> {
  memoryKey = "";
  const stored = await configStore.getItem<StoredConfig>(CONFIG_KEY);
  if (stored) {
    const { secret: _secret, ...rest } = stored;
    await configStore.setItem(CONFIG_KEY, { ...rest, remember: false });
  }
}

export async function clearAgentConfig(): Promise<void> {
  memoryKey = "";
  await configStore.removeItem(CONFIG_KEY);
}
