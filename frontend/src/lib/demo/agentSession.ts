import localforage from "localforage";

export type ChatLogItem = {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
};

const chatStore = localforage.createInstance({ name: "offeru-demo-agent", storeName: "chat" });
const CHAT_KEY = "messages:v1";

function isItem(value: unknown): value is ChatLogItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && (item.role === "user" || item.role === "assistant")
    && typeof item.content === "string"
    && typeof item.at === "string";
}

export async function loadAgentChat(): Promise<ChatLogItem[]> {
  const stored = await chatStore.getItem<unknown>(CHAT_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.filter(isItem).slice(-40);
}

export async function saveAgentChat(items: ChatLogItem[]): Promise<void> {
  await chatStore.setItem(CHAT_KEY, items.slice(-40));
}

export async function clearAgentChat(): Promise<void> {
  await chatStore.removeItem(CHAT_KEY);
}
