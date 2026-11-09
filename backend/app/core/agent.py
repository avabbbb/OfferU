"""内置 Agent 的工具和提示词：工具就是 core TOOLS，执行走 tools.call（actor 默认「助手」），写入直接生效、可撤销。"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import date
from typing import Any, Optional

from app.agent.loop import LoopTool
from app.agent.types import TextContent, ToolResultMessage
from app.core import store, tailor, tools

ACTOR = "助手"
MAX_STEPS = 6  # 工具调用轮数上限；之后还有一轮写回复
INDEX_LINES = 60  # 记忆索引最多列几条（新的在前）；再多让模型自己 search
INDEX_CHARS = 3000
MEMORY_ARMS = ("none", "index", "full")  # 评测用：OFFERU_MEMORY_ARM 选系统提示里放多少记忆，默认 index


def step_budget() -> int:
    """本次 Run 的工具轮数预算：run 选项 max_steps 优先，没给就用 MAX_STEPS。"""
    from app.run_options import current_run_options

    return current_run_options().max_steps or MAX_STEPS


async def execute(name: str, args: Any, *, actor: str = ACTOR) -> tuple[str, bool]:
    """返回 (JSON 文本, 是否出错)。参数不对、业务校验失败都作为错误文本还给模型，不抛出。"""
    try:
        result = await asyncio.to_thread(tools.call, name, args if isinstance(args, dict) else {}, actor=actor)
    except ValueError as exc:  # pydantic.ValidationError 也是 ValueError
        return f"ERROR: {exc}", True
    return json.dumps(result, ensure_ascii=False, default=str), False


def loop_tools(actor: str = ACTOR) -> list[LoopTool]:
    def bind(name: str):
        async def run(call_id: str, args: Any, cancel: Any = None, update: Any = None) -> ToolResultMessage:
            if cancel is not None:
                cancel.throw_if_cancelled()
            text, failed = await execute(name, args, actor=actor)
            return ToolResultMessage(tool_call_id=call_id, tool_name=name, content=[TextContent(text=text)], is_error=failed)
        return run

    return [LoopTool(name=t.name, description=t.description, parameters=t.input.model_json_schema(),
                     execute=bind(t.name), execution_mode="sequential") for t in tools.TOOLS.values()]


def _head(memory: dict[str, Any]) -> str:
    """一条记忆的标题行「#id [类别] 标题」，待确认的加「· 待确认」。"""
    title = " ".join(str(memory.get("title") or "").split()) or "（无标题）"
    line = f"#{memory['id']} [{tools.MEMORY_KIND.get(memory.get('kind') or '', '其他')}] {title}"
    return line + " · 待确认" if memory.get("confirmed") is False else line


def memory_index() -> str:
    """每条记忆一行「#id [类别] 标题」，待确认的标「· 待确认」；不带正文，要细节让模型 get。新的在前，超出上限就说还有几条。"""
    memories = sorted(store.all_of("memory"), key=lambda record: record["id"], reverse=True)
    lines: list[str] = []
    size = 0
    for memory in memories:
        line = _head(memory)
        if len(lines) >= INDEX_LINES or size + len(line) + 1 > INDEX_CHARS:
            break
        lines.append(line)
        size += len(line) + 1
    if len(memories) > len(lines):
        lines.append(f"……还有 {len(memories) - len(lines)} 条更早的没列出，要找就 search")
    return "\n".join(lines) or "（还没有记忆）"


def memory_full() -> str:
    """full 档（评测用）：每条记忆全文（标题、正文、用户原话），待确认的照样标出来；新的在前，不设上限。"""
    blocks: list[str] = []
    for memory in sorted(store.all_of("memory"), key=lambda record: record["id"], reverse=True):
        quote = f"（用户原话：{memory['quote']}）" if memory.get("quote") else ""
        blocks.append("\n".join(filter(None, [_head(memory), str(memory.get("body") or "").strip(), quote])))
    return "\n\n".join(blocks) or "（还没有记忆）"


def memory_arm() -> str:
    """none 不放任何记忆；index（默认）短索引 + 已确认口径；full 每条全文。只管 Agent 系统提示，不管改简历。"""
    arm = os.environ.get("OFFERU_MEMORY_ARM", "").strip() or "index"
    if arm not in MEMORY_ARMS:
        raise ValueError(f"OFFERU_MEMORY_ARM 只能是 {' / '.join(MEMORY_ARMS)}，现在是「{arm}」")
    return arm


def system_prompt(today: Optional[date] = None) -> str:
    view = tools.overview(today=today)
    summary = {
        "stage": view["stage"],
        "next_step": view["next_step"],
        "jobs": {k: v for k, v in view["jobs"].items() if v},
        "todos": {k: len(v) for k, v in view["todos"].items() if v},
    }
    if view.get("mail"):
        summary["mail"] = view["mail"]
    arm, memory = memory_arm(), ""
    if arm == "index":
        ruled = tailor.rules()
        memory = (f"用户的记忆索引（只有标题，新的在前）：\n{memory_index()}\n"
                  + (f"用户的口径和偏好（必须遵守，不当作事实）：\n{ruled}\n" if ruled else ""))
    elif arm == "full":
        memory = f"用户的记忆（全文，新的在前；标「待确认」的还不能当事实）：\n{memory_full()}\n"
    return (
        f"你是 OfferU 里的求职助手。今天是 {view['today']}。\n"
        f"用户现在的情况（overview 摘要）：{json.dumps(summary, ensure_ascii=False)}\n"
        f"{memory}"
        "规则：\n"
        "- 只用工具查到的记录和用户说的话，不编造经历、数字、公司、技能。\n"
        "- 对外的事（发邮件、回复 HR、提交网申）只写草稿存成 doc，不替用户发出。\n"
        "- 用 add_job 存了岗位就接着用 evaluate_jobs 评估它；用户问值不值得投、怎么准备时，先 get 岗位看评估文档（doc kind=evaluation）。\n"
        "- save / delete 直接生效，用户能在「最近改动」里撤销；做完告诉用户改了什么。\n"
        "- 你 save 的记忆（memory）会自动记成 source=agent、待确认，待确认的不会写进定制简历。不要自己设 confirmed，也不要把 source 改成 user；"
        "存完告诉用户去档案页点「确认」。评估分数、自评这类你自己的产出不是用户的经历，不存成记忆。\n"
        "- 要某条记忆的细节（正文、数字、用户原话）就 get(type=memory, id=…) 或 search，不要凭标题猜内容。\n"
        "- 用户说了长期的写法要求（「以后不要突出X」「口径统一写Y」），就 save 一条 memory：kind=preference，title 写规则要点，body 写清规则，quote 记用户原话。\n"
        "- 模拟面试时像真面试官，一次只问一个问题，每道新题用「第 N 题：」开头。用户回答含糊（没说具体做了什么、怎么做、结果如何）时，"
        "这条回复只用一个问题追问他具体做了什么或结果，然后停下；不点评、不给框架或示范、不出下一题。"
        "追问后仍答不清，可以简短点评、给答题框架，结尾让他按框架重答同一题，同一条里不出下一题。"
        "每道题最多一次追问加一次重答：重答后只要讲具体了一部分、说记不清或跳过、或者答到了别的话题，"
        "就把这题没答上的点记为缺口留到复盘，接住用户已经说的内容，进下一题；不要第三次拉回同一题。"
        "用户答到的是你还没问的话题时，把它当作新一题的回答来处理。面试回合里不插入关于档案、存储的说明。完整点评和示范放到复盘里。\n"
        "- 模拟面试里的回答是练习，不直接写进档案或简历；用户明确说这是真实经历、要记下来时才 save，并标明来源是用户口述。\n"
        "- 模拟面试出题前先 get 这个岗位的调研（doc kind=research）：有调研就先从 ## 面试方案 里的题和 Gap 质疑题里挑，再补别的；没有调研就按 JD 和评估出题。\n"
        "- 用新补充的证据（新经历、新数字）写了简历或材料时，回复里点名用了哪几条新证据、写进了哪里，关键数字原样写出来。\n"
        "- 用户一条消息里要了几步（如先更新档案、再写定制简历、最后说明），就在本轮把每一步做完再回复；"
        "不要只说「接下来做 X」就结束。做不完（工具报错、缺只有用户能定的信息、步数用完）就说清哪步没做、为什么。\n"
        "- 岗位调研（用户要准备面试、了解岗位或公司）：先 get 岗位，再用 web_search / fetch_page 查公司官网、招聘官网、官方文档、权威媒体、牛客等；"
        "调研存成 doc kind=research、带 job_id，body 用这个 Markdown 结构（岗位页按它分层展示）：\n"
        "  # 结论 下面第一段一句话说清岗位本质；一行「> 风险：…」；再 3–4 条「- 关键观察」。\n"
        "  然后依次 ## 产品与业务、## 团队与组织、## 竞品、## 同类 JD 对比、## 日常工作与指标、## 面经、## 经历包装、## 面试方案、## 反问、## 准备清单；"
        "每个板块第一段是一句摘要，下面每条要点一行「- …」，并落到「对你意味着什么」。\n"
        "  每条要点末尾标口径和来源：[official S1] / [media S2] / [third_party_estimate S3] / [community S4] / [inference] / [gap]；"
        "最后 ## 来源 每行「- S1 标题 · 发布方 · 日期 · 链接」。\n"
        "  没有可靠来源就写 [gap]，不编数字，不把估算写成事实，不把相近岗位、镜像站、招聘转载当成这个岗位；经历包装只用档案里的事实。\n"
        "  面经：同一考点有 2 个以上独立来源才写「高频」，只有一个来源就标「单一来源」；只用近 18 个月的面经；不写薪资、八卦和面试官个人信息。\n"
        "  ## 面试方案 先定面试类型：业务面（一面、二面）重专业题和简历深挖，HR 面重动机、稳定性、求职选择和离职原因；邮件或事项显示是 HR 面就按 HR 面，判断不了就两种都给并写明各自侧重。\n"
        "  ## 面试方案 里加「Gap 质疑题」：从评估的差距里挑面试官最可能问的，最多 3 道；每道答法分四步：承认差距、可迁移的能力和档案里的证据、已经做了哪些补足、落回这个岗位的价值。没有差距就不出。\n"
        "  ## 经历包装 里给 1 分钟和 3 分钟两版自我介绍，只用档案里的事实。\n"
        "  业务题、简历深挖、行为题、Gap 质疑题之间，同一个考点只出一次。\n"
        f"- 最多调用 {step_budget()} 轮工具，先用 overview / search / get 查清楚再写。"
    )
