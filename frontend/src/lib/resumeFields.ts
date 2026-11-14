// 右栏条目表单（参考 offershow：学历下拉、开始 / 结束时间、结束不填即「至今」）和 doc.resume 字段之间的换算。
// 不加新字段：时间仍是一串 item.date（「2021.09 – 2024.06」），学历仍拼在 item.subtitle 里（「公共卫生 · 硕士」），
// 后端 resume_model、PDF 模板、Agent 读写的格式都不变。认不出的旧写法原样放进「开始时间」，不丢字。

export const DEGREES = ["大专", "本科", "硕士", "博士", "MBA", "高中", "其他"] as const;
export const PRESENT = "至今";

// 年月：2021.09 / 2021-9 / 2021/09 / 2021年9月 → 2021.09
const MONTH = /^(\d{4})\s*[.\-/年]\s*(\d{1,2})\s*月?$/;
const RANGE = /^(.*?)\s*(?:[–—~～]|\s-\s|-(?=\s*(?:\d{4}|至今|今|现在))|至(?!今))\s*(.*)$/;

/** 能认出年月就规范成 2021.09；只有年份或别的写法原样留着。 */
export function normMonth(raw: string): string {
  const s = raw.trim();
  const m = MONTH.exec(s);
  return m ? m[1] + "." + m[2].padStart(2, "0") : s;
}

/** item.date → 开始 / 结束。结束是「至今 / 今 / 现在」或空都返回空（表单上就是「不填即为至今」）。 */
export function splitDate(date: string): { start: string; end: string } {
  const s = date.trim();
  if (!s) return { start: "", end: "" };
  const m = RANGE.exec(s);
  if (!m) return { start: normMonth(s), end: "" };
  const end = m[2].trim();
  return { start: normMonth(m[1]), end: /^(至今|今|现在|present|now)$/i.test(end) ? "" : normMonth(end) };
}

/** 开始 / 结束 → item.date。只有开始 → 「开始 – 至今」；只有结束 → 只写结束；都空 → 空。 */
export function joinDate(start: string, end: string): string {
  const a = normMonth(start), b = normMonth(end);
  if (!a) return b;
  return a + " – " + (b || PRESENT);
}

/** <input type="month"> 的值（2021-09）和简历里的写法（2021.09）互转；认不出的返回空，交给文本框。 */
export const toMonthInput = (v: string) => (/^\d{4}\.\d{2}$/.test(v) ? v.replace(".", "-") : "");
export const fromMonthInput = (v: string) => (/^\d{4}-\d{2}$/.test(v) ? v.replace("-", ".") : v);

const SEP = /\s*[·|｜/]\s*/;

/** 教育经历的 subtitle「专业 · 学历」→ 专业 / 学历。最后一段是认得的学历才拆出来。 */
export function splitDegree(subtitle: string): { major: string; degree: string } {
  const parts = subtitle.split(SEP).map((p) => p.trim()).filter(Boolean);
  const last = parts.at(-1) ?? "";
  if ((DEGREES as readonly string[]).includes(last)) return { major: parts.slice(0, -1).join(" · "), degree: last };
  return { major: subtitle.trim(), degree: "" };
}

export const joinDegree = (major: string, degree: string) => [major.trim(), degree.trim()].filter(Boolean).join(" · ");
