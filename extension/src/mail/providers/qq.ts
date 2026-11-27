// QQ 邮箱：新版 wx.mail.qq.com 和旧版 mail.qq.com（读信、写信在同源 iframe#mainFrame 里）。
// 没有能直接打开写信页的公开地址（旧版要 sid），所以先打开首页，再点「写信」。
import type { ComposeRequest } from "../contract.js";
import {
  composeRoot, findClickableByText, findEditable, findLabeledInput, linksIn, pickFileInput, queryFirst, reachableDocuments, readableText,
} from "../dom.js";
import type { WebmailAdapter } from "./types.js";

const SUBJECT = ["input#subject", 'input[name="subject"]', ".compose_subject input", '.xmail-ui-subject input', 'input[placeholder*="主题"]'];
const TO = ["#toAreaCtrl input", 'input[aria-label*="收件人"]', ".compose_receiver input", '[class*="receiver"] input', 'input[placeholder*="收件人"]'];
const CC = ["#ccAreaCtrl input", 'input[aria-label*="抄送"]'];
const BODY = [".compose_editor [contenteditable=true]", ".xmail-editor [contenteditable=true]", 'div[contenteditable="true"][role="textbox"]', "iframe.qmEditorIfrmEditArea"];
const FILE = ['input[type="file"][name="UploadFile"]', '.compose_attach input[type="file"]', '[class*="attach"] input[type="file"]'];

const READ_SUBJECT = [".mail-detail-subject", ".readmail_item_head_subject", "#subject.sub_title", "span#subject"];
const READ_FROM = [".mail-detail-from [title*='@']", ".readmail_item_head_from [title*='@']", "#mainFrom [e]", "span[e*='@']"];
const READ_DATE = [".mail-detail-time", ".readmail_item_head_time", "#local-time-caption"];
const READ_BODY = [".mail-detail-content", ".readmail_content", "#mailContentContainer", "#contentDiv"];

export const qqAdapter: WebmailAdapter = {
  id: "qq",
  label: "QQ 邮箱",
  hosts: ["mail.qq.com", "wx.mail.qq.com"],
  composeUrl(_request: ComposeRequest) {
    return "https://mail.qq.com/";
  },
  findCompose(doc) {
    for (const scope of reachableDocuments(doc)) {
      const subject = queryFirst<HTMLInputElement>(scope, SUBJECT) ?? findLabeledInput(scope, ["主题"]);
      if (!subject) continue;
      const root = composeRoot(subject, ["form", "#composeContainer"]);
      const bodyHit = queryFirst<HTMLElement>(root, BODY);
      const body = bodyHit instanceof HTMLIFrameElement ? (bodyHit.contentDocument?.body ?? null) : bodyHit ?? findEditable(root);
      return {
        root,
        subject,
        to: queryFirst<HTMLInputElement>(root, TO) ?? findLabeledInput(root, ["收件人"]),
        cc: queryFirst<HTMLInputElement>(root, CC),
        body,
        file: pickFileInput([root, scope], FILE),
      };
    }
    return null;
  },
  openCompose(doc) {
    for (const scope of reachableDocuments(doc)) {
      const button = queryFirst<HTMLElement>(scope, ["a#composebtn", '[class*="compose-btn"]', '[class*="write-btn"]']) ?? findClickableByText(scope, ["写信"]);
      if (button) {
        button.click();
        return true;
      }
    }
    return false;
  },
  readOpen(doc) {
    const docs = reachableDocuments(doc);
    const subject = queryFirst(docs, READ_SUBJECT);
    const body = queryFirst(docs, READ_BODY);
    if (!subject || !body) return null;
    const from = queryFirst(docs, READ_FROM);
    const date = queryFirst(docs, READ_DATE);
    const address = from?.getAttribute("e") || from?.getAttribute("title") || "";
    const name = from?.textContent?.trim() || "";
    return {
      from: address && name && !name.includes(address) ? `${name} <${address}>` : address || name,
      subject: subject.textContent?.trim() ?? "",
      date: date?.textContent?.trim() ?? "",
      text: readableText(body),
      links: linksIn(body),
    };
  },
};
