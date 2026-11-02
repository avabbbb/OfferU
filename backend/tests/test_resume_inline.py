from app.core import resume


def test_resume_inline_marks_and_text_lists():
    got = resume._inline("**甲** *乙* [丙](https://x.dev) <b>")
    assert got == '<strong>甲</strong> <em>乙</em> <a href="https://x.dev">丙</a> &lt;b&gt;'
    body = "".join(resume._text_html("开头\n- 一\n- 二\n1. 三", "p"))
    assert body == '<p data-path="p">开头</p><ul data-path="p"><li>一</li><li>二</li></ul><ol data-path="p"><li>三</li></ol>'
