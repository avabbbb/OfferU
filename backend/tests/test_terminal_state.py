from app.services.embedded_agent_host import _dangling_reference


def test_dangling_reference_flags_missing_body():
    # full-a7：只有英文元话，正文缺失
    assert _dangling_reference("Ranked: 示例科技 first.\n\nThe reply for your client is below.")
    assert _dangling_reference("三个岗位我比较完了，结果如下：")
    assert _dangling_reference("以下是三个岗位的比较：")


def test_dangling_reference_allows_complete_reply():
    assert not _dangling_reference("以下是比较：\n1. 示例科技：优先投，证据是 GMV 周报。")
    assert not _dangling_reference("投递包已存到岗位下，都没有发出。")
    assert not _dangling_reference("你先按练习任务重答第 1 题，完成标准见复盘文档。")
