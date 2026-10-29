from types import SimpleNamespace

from app.agents.llm import _active_provider_config
from app.run_options import RunOptions, use_run_options


def test_chosen_config_overrides_active_only_inside_run():
    settings = SimpleNamespace(
        llm_api_configs=[{"id": "a", "is_active": True}, {"id": "b"}],
        active_llm_config_id="a",
    )
    assert _active_provider_config(settings)["id"] == "a"
    with use_run_options(RunOptions(llm_config_id="b")):
        assert _active_provider_config(settings)["id"] == "b"
    assert _active_provider_config(settings)["id"] == "a"


def test_unknown_chosen_config_falls_back_to_active():
    settings = SimpleNamespace(llm_api_configs=[{"id": "a", "is_active": True}], active_llm_config_id="a")
    with use_run_options(RunOptions(llm_config_id="gone")):
        assert _active_provider_config(settings)["id"] == "a"
