from app.core.resume import _text_html


def test_text_keeps_indent_align_and_lists():
    out = "".join(_text_html("{center} 标题\n  - 甲\n  - **乙**\n1. 一\n2. 二\n\n 普通\n{right} ", "p"))
    assert out == ('<p data-path="p" style="text-align:center">标题</p>'
                   '<ul data-path="p"><li style="margin-left:2em">甲</li><li style="margin-left:2em"><strong>乙</strong></li></ul>'
                   '<ol data-path="p"><li>一</li><li>二</li></ol>'
                   '<p data-path="p">普通</p>')
