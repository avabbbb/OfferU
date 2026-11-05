from app.core.job_intake import hire_from_url


def test_hire_from_url():
    """链接路径段定招聘类型：只认整段，实习优先；认不出来留空。"""
    assert hire_from_url("https://talent.baidu.com/jobs/detail/SOCIAL/dd58c0d0") == "社招"
    assert hire_from_url("https://jobs.bytedance.com/experienced/position/123/detail") == "社招"
    assert hire_from_url("https://jobs.bytedance.com/campus/position/123") == "校招"
    assert hire_from_url("https://talent.baidu.com/jobs/detail/INTERN/abc") == "实习"
    assert hire_from_url("https://example.com/campus/intern/1") == "实习"
    assert hire_from_url("https://example.com/socialmedia-manager") == ""
    assert hire_from_url(None) == ""
