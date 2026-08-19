# =============================================
# OfferU - 后端配置
# =============================================
# 集中管理所有环境变量和配置项
# 使用 pydantic-settings 自动从 .env / 环境变量加载
# =============================================

from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """应用全局配置，字段自动绑定同名环境变量"""

    # ---- 数据库 ----
    database_url: str = "sqlite+aiosqlite:///./djm.db"

    # ---- API Keys（多 LLM 提供商） ----
    openai_api_key: str = ""
    deepseek_api_key: str = ""
    qwen_api_key: str = ""
    siliconflow_api_key: str = ""
    gemini_api_key: str = ""
    zhipu_api_key: str = ""
    ollama_base_url: str = "http://localhost:11434"
    apify_api_key: str = ""

    # ---- AI 模型配置 ----
    # llm_provider: openai / deepseek / qwen / siliconflow / gemini / zhipu / ollama / custom
    llm_provider: str = "deepseek"
    llm_model: str = "deepseek-v4-flash"
    active_llm_config_id: str = ""
    active_llm_base_url: str = ""
    active_llm_api_key: str = ""
    # BYOK provider 列表（由 backend/config.json 同步进来；provider 可自由配置，
    # base_url / api_key / model 任意组合，provider_id 不参与行为分支）。
    llm_api_configs: list = []
    # tier → model 自定义映射 (覆盖 llm.py 中的 TIER_MODEL_MAP)
    tier_model_map: dict = {}
    # 禁用的 LLM provider_id 列表（omp disabledProviders 模式：禁用后不可选）
    disabled_llm_providers: list = []

    # ---- 网络 ----
    # ssl_verify=False 仅用于开发环境（如 Clash 代理导致证书主机名不匹配）。
    # 普通用户保持默认 True。
    ssl_verify: bool = True
    # LLM API 全局超时（秒），防止请求挂起
    llm_timeout: int = 60
    # MCP is optional for external coding-agent clients. Keeping it off avoids
    # importing the MCP protocol stack on every desktop cold start.
    offeru_enable_mcp: bool = False

    # ---- 安全 ----
    # 本地单人应用：无登录/会话体系，不设服务端对称密钥。
    cors_origins: str = (
        "http://localhost:3011,"
        "http://127.0.0.1:3011,"
"http://localhost:7410,"
        "http://127.0.0.1:7410,"
        "http://localhost:3000,"
        "http://127.0.0.1:3000,"
        "http://localhost:3001,"
        "http://127.0.0.1:3001,"
        "http://localhost:5140,"
        "http://127.0.0.1:5140"
    )

    # ---- Gmail OAuth ----
    gmail_client_id: str = ""
    gmail_client_secret: str = ""
    gmail_redirect_uri: str = ""  # 自定义回调地址，为空则自动从 cors_origins 推导
    email_sync_interval_seconds: int = 300

    # ---- Coding agent runtime ----
    # 自动选择本地 coding agent CLI 的优先顺序（逗号分隔）
    coding_agent_priority: str = "claude,codex,omp,gemini,pi"

    # ---- 长时记忆 ----
    # memory distiller 后台循环间隔（秒），0 = 关闭
    memory_distill_interval_seconds: int = 1800
    # 工作源自动同步间隔（秒），0 = 关闭（同步会把内容送给 coding agent，默认需手动触发）
    work_source_auto_sync_interval_seconds: int = 0

    # ---- 网页搜索（岗位调研兜底链，无 live-capable CLI runtime 时启用） ----
    # search_provider: auto / bocha / tavily / serper / ddgs
    search_provider: str = "auto"
    bocha_api_key: str = ""
    tavily_api_key: str = ""
    serper_api_key: str = ""

    # ---- 投递进度 ----
    # 邮件信号是否叠加 LLM 分类（关键词规则永远保底执行）
    progress_llm_classify: bool = True

    # Ignore unrelated env vars (for example docker-style db_user/db_password/db_name)
    # so local startup does not fail when extra keys exist.
    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


@lru_cache
def get_settings() -> Settings:
    return Settings()
