# 一级页面全部收敛进求职阶段导航

OfferU WebUI 的现有一级页面全部收敛进今日、机会、材料、进展与面试五个阶段入口,不保留与阶段并列的业务模块页面。今日以今日行动队列为主体,并按需展开原 analytics 的统计与趋势;机会承接 jobs 与岗位详情,scraper 降级为机会内的导入入口;材料承接 resume、简历编辑与 studio,optimize 并入简历定制流程而不是独立页面;进展承接 applications 与 calendar,email 收敛为进展内的外部进展信号收件箱而不是并列邮箱模块;面试承接 interview 及其 AI 面试与表达训练房间。档案与设置保持支持入口。独立 agent 页面取消,主 Agent 能力由右侧上下文栏的 OfferU 模式承接;puck-demo 等演示页面删除。收敛只改变导航归属与页面组织,不合并领域事实模型,也不改变 Operation Registry 的能力与权限边界。
