(() => {
  const globalState = globalThis;
  if (globalState.__offeruOffscreenClipboardReady) {
    return;
  }
  globalState.__offeruOffscreenClipboardReady = true;

  async function sendResult(requestId, ok, error) {
    await chrome.runtime.sendMessage({
      type: "OFFSCREEN_WRITE_IMAGE_RESULT",
      requestId,
      ok,
      error,
    });
  }

  async function writeImageToClipboard(imageUrl) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("当前环境不支持图片写入剪贴板");
    }

    const response = await fetch(imageUrl, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const pngBlob = blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "OFFSCREEN_WRITE_IMAGE") {
      return;
    }

    const requestId = String(message.requestId || "");
    const imageUrl = String(message.imageUrl || "");

    void (async () => {
      if (!requestId) {
        return;
      }

      try {
        await writeImageToClipboard(imageUrl);
        await sendResult(requestId, true);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await sendResult(requestId, false, detail || "离屏复制失败");
      }
    })();

    sendResponse({ ok: true });
    return true;
  });
})();
