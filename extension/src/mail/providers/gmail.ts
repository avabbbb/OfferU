// Gmail（mail.google.com）。写信用 ?view=cm&fs=1 整页写信窗，收件人 / 标题 / 正文由 URL 预填，插件只补附件和漏填的。
// 选择器：Gmail 的 class 是混淆的（.hP / .gD / .a3s 多年未变，但随时可能改），每处都配 aria-label / name 退路。
import type { ComposeRequest } from "../contract.js";
import { composeRoot, findClickableByText, findEditable, findLabeledInput, linksIn, pickFileInput, queryFirst, readableText } from "../dom.js";
import type { WebmailAdapter } from "./types.js";

const SUBJECT = ['input[name="subjectbox"]', 'input[aria-label="Subject"]', 'input[aria-label="主题"]', 'input[placeholder="Subject"]', 'input[placeholder="主题"]'];
const TO = ['input[aria-label^="To"]', 'input[aria-label*="收件人"]', 'textarea[name="to"]', 'input[name="to"]', 'input[peoplekit-id]'];
const CC = ['input[aria-label^="Cc"]', 'input[aria-label*="抄送"]', 'textarea[name="cc"]', 'input[name="cc"]'];
const BODY = ['div[role="textbox"][contenteditable="true"]', 'div.Am.editable[contenteditable="true"]', '[contenteditable="true"][aria-label*="Body"]', '[contenteditable="true"][aria-label*="正文"]'];
const FILE = ['input[type="file"][name="Filedata"]'];

export const gmailAdapter: WebmailAdapter = {
  id: "gmail",
  label: "Gmail",
  hosts: ["mail.google.com"],
  composeUrl(request: ComposeRequest) {
    const params = new URLSearchParams({ view: "cm", fs: "1", tf: "1", to: request.to, su: request.subject, body: request.body });
    if (request.cc.length) params.set("cc", request.cc.join(","));
    return `https://mail.google.com/mail/?${params.toString()}`;
  },
  findCompose(doc) {
    const subject = queryFirst<HTMLInputElement>(doc, SUBJECT);
    if (!subject) return null;
    const root = composeRoot(subject, ["form", "[role=dialog]"]);
    return {
      root,
      subject,
      to: queryFirst<HTMLInputElement>(root, TO) ?? findLabeledInput(root, ["To", "收件人"]),
      cc: queryFirst<HTMLInputElement>(root, CC),
      body: findEditable(root, BODY),
      file: pickFileInput([root, doc], FILE),
    };
  },
  openCompose(doc) {
    const button = queryFirst<HTMLElement>(doc, ['div[gh="cm"]']) ?? findClickableByText(doc, ["Compose", "写邮件"]);
    if (!button) return false;
    button.click();
    return true;
  },
  readOpen(doc) {
    const subject = queryFirst(doc, ["h2.hP", 'h2[data-thread-perm-id]', '[role="main"] h2']);
    const bodies = Array.from(doc.querySelectorAll(".a3s"));
    const body = bodies[bodies.length - 1] ?? null;
    if (!subject || !body) return null;
    const senders = Array.from(doc.querySelectorAll<HTMLElement>(".gD[email], span[email]"));
    const sender = senders[senders.length - 1];
    const name = sender?.getAttribute("name") || sender?.textContent?.trim() || "";
    const email = sender?.getAttribute("email") || "";
    const dates = Array.from(doc.querySelectorAll<HTMLElement>(".g3"));
    const date = dates[dates.length - 1];
    return {
      from: email ? (name && name !== email ? `${name} <${email}>` : email) : name,
      subject: subject.textContent?.trim() ?? "",
      date: date?.getAttribute("title") || date?.textContent?.trim() || "",
      text: readableText(body),
      links: linksIn(body),
    };
  },
};
