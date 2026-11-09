"""改写和审稿 prompt 的写法规则：不拔高、岗位信息锁死、关键词不堆砌、反 AI 味句式。删掉任何一条都会变红。"""

from app.core import tailor


def test_draft_prompt_locks_role_strength_and_keywords():
    p = tailor.PROMPT
    assert "不拔高" in p and "「负责」「主导」「独立完成」" in p and "「熟练」「精通」" in p
    assert "课程或个人项目不写成公司项目" in p
    assert "不为贴 JD 改职位名" in p
    assert "同一个词全文出现一两次就够" in p


def test_review_prompt_checks_inflation_density_and_tone():
    p = tailor.REVIEW_PROMPT
    assert "拔高也算没出处" in p
    assert "公司名、职位名、部门、起止时间和事实来源不一样" in p
    assert "同一个 JD 词全文出现超过 2 次" in p
    assert "9. tone" in p and "同一个句式" in p and "感悟总结句" in p
    assert "只换说法，不加事实" in p
