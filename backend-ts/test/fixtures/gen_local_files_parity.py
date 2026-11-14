"""Python read_file / find_files on a fixed tree → local-files-parity.json (+ resume.docx).

Run from repo root while the Python backend still exists (needs python-docx):
    OFFERU_DATA_DIR=$(mktemp -d) python3 backend-ts/test/fixtures/gen_local_files_parity.py
The TS test rebuilds the same tree (TREE below, mtimes included) and compares.
"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root / "backend"))
from app.core import tools  # noqa: E402

here = Path(__file__).resolve().parent
docx_path = here / "resume.docx"
import docx  # noqa: E402

d = docx.Document()
d.add_paragraph("张三")
d.add_paragraph("电话 13812345678 · 邮箱 zs@example.com")
d.add_paragraph("")
d.add_paragraph("")
d.add_paragraph("腾讯 · 产品实习生 2025.06-2025.09")
d.add_paragraph("负责 3 个需求 & 上线 <A/B> 实验")
t = d.add_table(rows=2, cols=2)
t.cell(0, 0).text, t.cell(0, 1).text = "技能", "SQL"
t.cell(1, 0).text, t.cell(1, 1).text = "语言", "英语 六级"
d.save(docx_path)

TREE = {
    "简历-2025.md": ("# 张三\n\n\n\n腾讯 产品实习生\n", 1_700_000_300),
    "notes.txt": ("随便记点什么 简历 草稿", 1_700_000_200),
    "photo.png": ("not really a png", 1_700_000_100),
    "老简历.docx": (None, 1_700_000_400),
    "sub/项目经历.txt": ("推荐系统 项目 腾讯 合作", 1_700_000_500),
    "sub/deeper/a/b/too-deep.txt": ("腾讯 深层", 1_700_000_600),
    "sub/deeper/a/three.md": ("腾讯 三层", 1_700_000_550),
    ".hidden/secret.txt": ("腾讯 隐藏", 1_700_000_700),
}

base = Path(tempfile.mkdtemp())
for rel, (text, mtime) in TREE.items():
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    if text is None:
        shutil.copy(docx_path, p)
    else:
        p.write_text(text, encoding="utf-8")
    os.utime(p, (mtime, mtime))


def rel(value):
    if isinstance(value, str):
        return value.replace(str(base), "<ROOT>").replace(os.sep, "/")
    if isinstance(value, list):
        return [rel(v) for v in value]
    if isinstance(value, dict):
        return {k: rel(v) for k, v in value.items() if k != "modified"}
    return value


def run(name, args):
    try:
        return {"ok": rel(tools.call(name, args, actor="agent"))}
    except Exception as exc:  # noqa: BLE001
        return {"error": rel(str(exc))}


cases = []
for args in [
    {"path": str(base / "简历-2025.md")},
    {"path": str(base / "老简历.docx")},
    {"path": str(base / "photo.png")},
    {"path": str(base / "missing.txt")},
]:
    cases.append({"tool": "read_file", "args": rel(args), "result": run("read_file", args)})
for args in [
    {"dir": str(base)},
    {"dir": str(base), "docs_only": False},
    {"dir": str(base), "pattern": "*简历*"},
    {"dir": str(base), "query": "腾讯"},
    {"dir": str(base), "query": "腾讯 项目"},
    {"dir": str(base), "recursive": True, "limit": 2},
    {"dir": str(base), "query": "简历", "recursive": False},
    {"dir": "relative/dir"},
    {"dir": str(base / "nope")},
]:
    cases.append({"tool": "find_files", "args": rel(args), "result": run("find_files", args)})

out = here / "local-files-parity.json"
out.write_text(json.dumps({"tree": {k: [v[0], v[1]] for k, v in TREE.items()}, "cases": cases}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"wrote {out} ({len(cases)} cases)")
