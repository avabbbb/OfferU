"""Python outputs of backend/app/services/agent_attachments.py → attachments.json + deck.pptx.

Run from repo root while the Python backend still exists (needs python-pptx):
    OFFERU_DATA_DIR=$(mktemp -d) python3 backend-ts/test/fixtures/attachments/gen_attachments.py
Covers _pptx_text (text frames, <a:br/>, tables, groups, notes, empty slide), save_attachment's
validation messages, _display_name, and prepare_message (document inlining, clipping budget, images).
"""
import io
import json
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
root = here.parents[3]
sys.path.insert(0, str(root / "backend"))

from pptx import Presentation  # noqa: E402
from pptx.util import Inches  # noqa: E402

from app.services import agent_attachments as att  # noqa: E402

deck = Presentation()
blank = deck.slide_layouts[6]
s1 = deck.slides.add_slide(deck.slide_layouts[1])
s1.shapes.title.text = "后端实习 & <总结>"
body = s1.placeholders[1].text_frame
body.text = "负责 Python 服务"
p = body.add_paragraph()
p.text = "上线 3 个接口"
p.add_line_break()
r = p.add_run()
r.text = "QPS 提升 40%"
s1.notes_slide.notes_text_frame.text = "讲 STAR"
s2 = deck.slides.add_slide(blank)
table = s2.shapes.add_table(3, 2, Inches(1), Inches(1), Inches(4), Inches(2)).table
table.cell(0, 0).text = "指标"
table.cell(0, 1).text = "结果"
table.cell(2, 0).text = "延迟"
table.cell(2, 1).text = "-30%"
group = s2.shapes.add_group_shape()
box = group.shapes.add_textbox(Inches(1), Inches(4), Inches(2), Inches(1))
box.text_frame.text = "组内文字"
s2.shapes.add_textbox(Inches(5), Inches(5), Inches(1), Inches(1)).text_frame.text = "   "
deck.slides.add_slide(blank)
buffer = io.BytesIO()
deck.save(buffer)
pptx_bytes = buffer.getvalue()
(here / "deck.pptx").write_bytes(pptx_bytes)

out: dict = {"pptx_text": att._pptx_text(pptx_bytes)}

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
cases = {
    "bad_ext": ("a.txt", b"hi"),
    "empty": ("a.png", b""),
    "mismatch": ("a.png", b"GIF89a....."),
    "not_pptx": ("a.pptx", b"PK\x03\x04" + b"\x00" * 30),
    "big_image": ("a.png", PNG + b"\x00" * (8 * 1024 * 1024)),
}
errors = {}
for key, (name, data) in cases.items():
    try:
        att.save_attachment(name, data)
        errors[key] = None
    except att.AttachmentError as exc:
        errors[key] = str(exc)
out["errors"] = errors
out["display_name"] = {n: att._display_name(n) for n in ["C:\\Users\\me\\简历.pdf", "../../x.png", "a\x00b\x1f.png", "", "  ", "x" * 200 + ".png"]}

saved_deck = att.save_attachment("deck.pptx", pptx_bytes)
saved_png = att.save_attachment("shot.png", PNG)
long_text = att.save_attachment("long.pptx", pptx_bytes)
(att._directory() / f"{long_text.id}.txt").write_text("长" * 35000, encoding="utf-8")
prepared = att.prepare_message("  看看这个  ", [saved_deck.id, saved_png.id, long_text.id, saved_deck.id])
out["prepare"] = {
    "model_message": prepared.model_message,
    "history_message": prepared.history_message,
    "attachments": [{**a, "id": {saved_deck.id: "deck", saved_png.id: "png", long_text.id: "long"}[a["id"]]} for a in prepared.attachments],
    "images": len(prepared.image_ids),
}
(here / "attachments.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("ok")
