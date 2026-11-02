import inspect
import json
from pathlib import Path

import pytest

from app.core import resume

# 和前端 richMarkup.test.ts 跑同一份用例：任何一边改了标记规则，两边测试一起红。
ROOT = Path(inspect.currentframe().f_code.co_filename).resolve().parents[2]
CASES = json.loads((ROOT / 'frontend' / 'src' / 'lib' / 'richMarkup.cases.json').read_text(encoding='utf-8'))


@pytest.mark.parametrize('case', CASES['inline'])
def test_inline_matches_frontend(case):
    assert resume._inline(case['in']) == case['html']


@pytest.mark.parametrize('case', CASES['lines'])
def test_parse_line_matches_frontend(case):
    assert resume.parse_line(case['raw']) == case['line']
