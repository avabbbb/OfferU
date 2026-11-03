// 弹窗里的「列表多选」：读当前标签页列表卡片，勾选后交给后台 SAVE_LIST_JOBS 存成岗位。
// 悬浮抽屉（embed）里拿不到 activeTab，不能读页面，提示改从工具栏图标打开。

import type { Message } from "./types.js";
import { readListCards, type ListCard, type SaveListResult } from "./background/list-jobs.js";

type Show = (text: string, type: "success" | "error" | "info") => void;

function send(message: Message): Promise<SaveListResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp?: SaveListResult) => {
      if (chrome.runtime.lastError || !resp) {
        resolve({ ok: false, message: "后台无响应：" + (chrome.runtime.lastError?.message || "") });
        return;
      }
      resolve(resp);
    });
  });
}

export function initListSelect(show: Show, embed: boolean): void {
  const button = document.getElementById("listSelectBtn") as HTMLButtonElement | null;
  const found = document.getElementById("listSelectPanel") as HTMLDivElement | null;
  if (!button || !found) return;
  const panel: HTMLDivElement = found;

  const close = (): void => {
    panel.classList.add("hidden");
    panel.replaceChildren();
  };

  const render = (cards: ListCard[]): void => {
    panel.replaceChildren();
    const boxes: HTMLInputElement[] = [];
    const all = document.createElement("label");
    all.style.cssText = "display:flex;gap:6px;align-items:center;font-weight:600;padding:4px 0";
    const allBox = document.createElement("input");
    allBox.type = "checkbox";
    allBox.checked = true;
    all.append(allBox, "全选（这一页认出 " + cards.length + " 个）");
    const list = document.createElement("div");
    list.style.cssText = "max-height:240px;overflow:auto;display:flex;flex-direction:column;gap:4px";
    for (const card of cards) {
      const row = document.createElement("label");
      row.style.cssText = "display:flex;gap:6px;align-items:flex-start;font-size:12px;line-height:1.4";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = true;
      boxes.push(box);
      row.append(box, [card.title, card.company].filter(Boolean).join(" · "));
      list.append(row);
    }
    allBox.addEventListener("change", () => boxes.forEach((box) => (box.checked = allBox.checked)));
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn btn-primary";
    save.textContent = "存选中的岗位";
    save.addEventListener("click", async () => {
      const chosen = cards.filter((_, i) => boxes[i].checked);
      if (!chosen.length) {
        show("先勾选要存的岗位", "info");
        return;
      }
      save.disabled = true;
      save.textContent = "存储中...";
      const resp = await send({ type: "SAVE_LIST_JOBS", cards: chosen });
      show(resp.message, resp.ok ? "success" : "error");
      if (resp.ok) close();
      else {
        save.disabled = false;
        save.textContent = "存选中的岗位";
      }
    });
    panel.append(all, list, save);
    panel.classList.remove("hidden");
  };

  button.addEventListener("click", async () => {
    if (embed) {
      show("列表多选要从浏览器工具栏的 OfferU 图标打开", "info");
      return;
    }
    if (!panel.classList.contains("hidden")) {
      close();
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      show("未找到当前标签页", "error");
      return;
    }
    let cards: ListCard[] = [];
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readListCards });
      cards = (injection?.result as ListCard[] | undefined) || [];
    } catch (error) {
      show("这个页面读不了：" + (error instanceof Error ? error.message : String(error)), "error");
      return;
    }
    if (!cards.length) {
      show("这一页没认出岗位卡片：目前支持 BOSS 直聘和小红书的搜索结果页", "info");
      return;
    }
    render(cards);
  });
}
