from app.core import tools

P = {"name": "林知远"}
J = {"title": "数据分析师"}


def test_attachment_name_follows_jd_rule():
    name, todo = tools.attachment_name("邮件标题格式「姓名-学校-岗位」，附件为 PDF，命名「姓名-岗位」。", P, J)
    assert name == "林知远-数据分析师"
    assert not todo


def test_attachment_name_empty_without_rule():
    name, _ = tools.attachment_name("简历发送至 a@b.com", P, J)
    assert name == ""


def test_mail_subject_keeps_unknown_fields_as_todo():
    subject, todo = tools.mail_subject("邮件标题格式「姓名-学校-岗位-最快到岗时间」", P, J)
    assert subject.startswith("林知远-")
    assert "数据分析师" in subject
    assert set(todo) == {"学校", "最快到岗时间"}


def test_export_stem_keeps_spaces_and_drops_illegal_chars():
    from app.core.resume import safe_stem
    assert safe_stem("林知远-数据分析师（2026 届校招）") == "林知远-数据分析师（2026 届校招）"
    assert safe_stem("林知远-A/B 测试:岗\t位") == "林知远-A_B 测试_岗 位"
    assert safe_stem("  ??  ") == ""
