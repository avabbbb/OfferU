import { startWebmail } from "../src/mail/webmail-content";

// 只在这几个邮箱网页运行（和 src/mail/providers 的 hosts 一致，mail-providers.test.ts 校验）。
export default defineContentScript({
  matches: ["https://mail.google.com/*", "https://mail.qq.com/*", "https://wx.mail.qq.com/*", "https://mail.163.com/*"],
  runAt: "document_idle",
  main() {
    try {
      startWebmail(window, {
        send: (message) =>
          new Promise((resolve) => {
            chrome.runtime.sendMessage(message, (response) => {
              void chrome.runtime.lastError;
              resolve(response as Record<string, unknown> | undefined);
            });
          }),
      });
    } catch {
      // extension context gone (reloaded)
    }
  },
});
