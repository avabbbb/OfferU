// 网页一侧的邮箱插件契约（插件那一侧：extension/src/content/mail-bridge.test.ts）。
import { describe, expect, it } from "vitest";

import { createExtensionMail, fileToAttachment, handoffPrompt, type ExtensionMailWindow } from "./extensionMail";

const ORIGIN = "https://offeru.avabbbb.com";
type Ev = Record<string, unknown>;

function fakeWindow(handler?: (msg: Ev, emit: (data: Ev) => void) => void) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const sent: Ev[] = [];
  const win: ExtensionMailWindow = {
    location: { origin: ORIGIN },
    addEventListener: (_t, l) => { listeners.add(l); },
    removeEventListener: (_t, l) => { listeners.delete(l); },
    postMessage: (message) => {
      const msg = message as Ev;
      if (msg.source !== "offeru-page") return;
      sent.push(msg);
      queueMicrotask(() => handler?.(msg, emit));
    },
  };
  function emit(data: Ev) {
    const event = { data: { source: "offeru-ext", ...data }, source: win, origin: ORIGIN } as unknown as MessageEvent;
    [...listeners].forEach((l) => l(event));
  }
  return { win, sent, emit };
}

const CAPS = { protocol: 1, version: "0.1.0", providers: [{ id: "gmail", label: "Gmail" }], provider: "gmail", compose: true, handoff: true };

describe("extension mail contract", () => {
  it("detects the extension and its default webmail; no answer means no extension", async () => {
    const { win } = fakeWindow((msg, emit) => {
      if (msg.type === "mail-hello") emit({ type: "mail-hello-ack", id: msg.id, ok: true, mail: CAPS });
    });
    expect(await createExtensionMail(win, { helloTimeoutMs: 50 }).detect()).toMatchObject({ protocol: 1, provider: "gmail" });
    expect(await createExtensionMail(fakeWindow().win, { helloTimeoutMs: 20 }).detect()).toBeNull();
    const old = fakeWindow((msg, emit) => emit({ type: "mail-hello-ack", id: msg.id, ok: true, mail: { ...CAPS, protocol: 0 } }));
    expect(await createExtensionMail(old.win, { helloTimeoutMs: 50 }).detect()).toBeNull();
  });

  it("sends the compose request in the shape the extension validates and surfaces its error", async () => {
    const { win, sent } = fakeWindow((msg, emit) => {
      const compose = msg.compose as { to: string };
      emit({ type: "mail-compose-ack", id: msg.id, ...(compose.to.includes("@") ? { ok: true, provider: "gmail" } : { ok: false, error: "收件人邮箱不对" }) });
    });
    const mail = createExtensionMail(win, { requestTimeoutMs: 50 });
    const request = { provider: "gmail" as const, to: "hr@example.com", cc: [], subject: "应聘", body: "您好", attachment: { name: "a.pdf", type: "application/pdf", base64: "JVBERg==" } };
    await mail.compose(request);
    expect(sent[0]).toMatchObject({ source: "offeru-page", type: "mail-compose", compose: request });
    await expect(mail.compose({ ...request, to: "bad" })).rejects.toThrow("收件人邮箱不对");
    await expect(createExtensionMail(fakeWindow().win, { requestTimeoutMs: 20 }).compose(request)).rejects.toThrow("插件没有回应");
  });

  it("takes handed-off mail after a mail-incoming ping", async () => {
    const message = { provider: "qq", from: "HR <hr@x.com>", subject: "面试邀请", date: "明天", text: "请参加面试", links: ["https://m.example.com/1"], url: "https://wx.mail.qq.com/" };
    const { win, emit } = fakeWindow((msg, reply) => {
      if (msg.type === "mail-inbox-take") reply({ type: "mail-inbox-ack", id: msg.id, ok: true, messages: [message] });
    });
    const mail = createExtensionMail(win, { requestTimeoutMs: 50 });
    let pinged = 0;
    mail.onIncoming(() => { pinged += 1; });
    emit({ type: "mail-incoming" });
    expect(pinged).toBe(1);
    const [taken] = await mail.takeInbox();
    const prompt = handoffPrompt(taken);
    expect(prompt).toContain("QQ 邮箱");
    expect(prompt).toContain("主题：面试邀请");
    expect(prompt).toContain("- https://m.example.com/1");
  });

  it("turns a picked PDF into base64 and refuses files over 5 MB", async () => {
    const att = await fileToAttachment(new File([new Uint8Array([37, 80, 68, 70])], "简历.pdf", { type: "application/pdf" }));
    expect(att).toEqual({ name: "简历.pdf", type: "application/pdf", base64: "JVBERg==" });
    await expect(fileToAttachment(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.pdf"))).rejects.toThrow("5 MB");
  });
});
