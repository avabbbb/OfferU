import pytest


def test_consent_gate(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFERU_DATA_DIR", str(tmp_path))
    from app.core import consent

    st = consent.status()
    assert st["agreed"] is False and st["risks"] and "你负责" in st["duties"]
    with pytest.raises(ValueError):
        consent.require()
    with pytest.raises(ValueError):
        consent.agree("1999-01-01")
    st = consent.agree(consent.VERSION)
    assert st["agreed"] and st["agreed_version"] == consent.VERSION and st["agreed_at"]
    consent.require()
    monkeypatch.setattr(consent, "VERSION", "2099-01-01")
    assert consent.status()["agreed"] is False
    with pytest.raises(ValueError):
        consent.require()
    monkeypatch.setattr(consent, "VERSION", st["version"])
    assert consent.revoke()["agreed"] is False
    assert not (tmp_path / "platform-consent.json").exists()
