"""AI guide endpoint (guide.py, UI plan U7). Offline: the Anthropic client is always faked.

./.venv/bin/python -m pytest -q tests/test_guide.py
"""
import asyncio
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import guide  # noqa: E402
import main  # noqa: E402

client = TestClient(main.app)
WEB_SRC = Path(__file__).resolve().parents[2] / "web" / "src"

BODY = {
    "trigger": "object",
    "target": {"id": "sky:barnard", "name": "Barnard's Star"},
    "state": {"view": "sky", "band": 40, "mode": "single", "op": "none", "fov": 0.5},
    "facts": {"preset_note": "The fastest-moving star on our sky, about 10.4 arcsec per year."},
    "commands": ["set_band", "set_op", "fly_to", "toggle_tools"],
    "ids": ["sky:barnard", "band-ribbon", "band-d6"],
}

GOOD = {
    "steps": [
        {"say": "This is Barnard's Star.", "actions": [
            {"type": "circle", "id": "sky:barnard", "to": "", "label": "", "cmd": "", "args": ""},
        ]},
        {"say": "Here is a long wavelength band.", "actions": [
            {"type": "cmd", "id": "", "to": "", "label": "", "cmd": "set_band", "args": "{\"band\": 93}"},
            {"type": "point", "id": "band-d6", "to": "", "label": "Longest waves", "cmd": "", "args": ""},
        ]},
    ]
}


class FakeMessages:
    def __init__(self, reply=None, delay=0.0, exc=None, stop_reason="end_turn"):
        self.reply, self.delay, self.exc, self.stop_reason = reply, delay, exc, stop_reason
        self.calls = []

    async def create(self, **kw):
        self.calls.append(kw)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc:
            raise self.exc
        text = self.reply if isinstance(self.reply, str) else json.dumps(self.reply)
        return SimpleNamespace(stop_reason=self.stop_reason, content=[SimpleNamespace(type="text", text=text)])


@pytest.fixture
def fake(monkeypatch):
    """Install a fake client and a key; returns the fake's messages (set .reply etc. on it)."""
    guide.reset()
    msgs = FakeMessages(reply=GOOD)
    monkeypatch.setattr(guide, "make_client", lambda: SimpleNamespace(messages=msgs))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.delenv("GUIDE_MODEL", raising=False)
    yield msgs
    guide.reset()


def post(body=BODY):
    r = client.post("/api/guide", json=body)
    assert r.status_code == 200
    return r.json()


def test_valid_reply_becomes_a_u5_script(fake):
    out = post()
    assert out.get("fallback") is None and out["source"] == "claude" and out["cached"] is False
    assert out["model"] == "claude-haiku-5-5"
    assert out["steps"] == [
        {"say": "This is Barnard's Star.", "actions": [{"circle": "sky:barnard"}]},
        {"say": "Here is a long wavelength band.", "actions": [
            {"cmd": "set_band", "args": {"band": 93}},
            {"point": "band-d6", "label": "Longest waves"},
        ]},
    ]
    call = fake.calls[0]
    assert call["model"] == "claude-haiku-5-5"
    assert call["output_config"]["format"]["type"] == "json_schema"
    sent = json.loads(call["messages"][0]["content"])
    # whitelist = static allow-list ∩ what the browser has (toggle_tools is not guide-relevant)
    assert [c["name"] for c in sent["commands"]] == ["fly_to", "set_band", "set_op"]
    assert sent["facts"] == BODY["facts"] and sent["target"]["id"] == "sky:barnard"


def test_model_is_overridable(fake, monkeypatch):
    monkeypatch.setenv("GUIDE_MODEL", "claude-sonnet-5-5")
    assert post()["model"] == "claude-sonnet-5-5"
    assert fake.calls[0]["model"] == "claude-sonnet-5-5"


def test_invalid_json_falls_back(fake):
    fake.reply = "Sure! Here is a script: {steps: oops"
    out = post()
    assert out == {"steps": [], "fallback": True, "reason": "invalid reply"}


def test_schema_failure_falls_back(fake):
    fake.reply = {"steps": [{"say": "", "actions": []}]}
    assert post()["fallback"] is True
    fake.reply = {"nope": 1}
    guide.reset()
    assert post()["fallback"] is True


def test_refusal_or_truncation_falls_back(fake):
    fake.stop_reason = "max_tokens"
    assert post()["reason"] == "invalid reply"


def test_timeout_falls_back(fake, monkeypatch):
    monkeypatch.setattr(guide, "TIMEOUT_S", 0.05)
    fake.delay = 2.0
    assert post() == {"steps": [], "fallback": True, "reason": "timeout"}


def test_model_error_falls_back(fake):
    fake.exc = ConnectionError("network down")
    out = post()
    assert out["fallback"] is True and "ConnectionError" in out["reason"]


def test_non_whitelisted_command_and_unknown_ids_are_dropped(fake):
    fake.reply = {"steps": [
        {"say": "One.", "actions": [
            {"type": "cmd", "id": "", "to": "", "label": "", "cmd": "toggle_tools", "args": "{}"},      # not guide-relevant
            {"type": "cmd", "id": "", "to": "", "label": "", "cmd": "go_preset", "args": "{\"id\":\"barnard\"}"},  # browser lacks it
            {"type": "cmd", "id": "", "to": "", "label": "", "cmd": "set_band", "args": "{\"colour\": 3}"},  # unknown arg
            {"type": "cmd", "id": "", "to": "", "label": "", "cmd": "set_band", "args": "not json"},
            {"type": "circle", "id": "sky:nowhere", "to": "", "label": "", "cmd": "", "args": ""},       # id not in the page
            {"type": "trail", "id": "sky:barnard", "to": "band-d6", "label": "", "cmd": "", "args": ""},  # ok
        ]},
        {"say": "Two.", "actions": [{"type": "cmd", "id": "", "to": "", "label": "", "cmd": "set_op", "args": "{\"op\":\"trail\"}"}]},
    ]}
    out = post()
    assert out["steps"] == [
        {"say": "One.", "actions": [{"trail": ["sky:barnard", "band-d6"]}]},
        {"say": "Two.", "actions": [{"cmd": "set_op", "args": {"op": "trail"}}]},
    ]


def test_missing_key_falls_back_without_calling(fake, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    out = post()
    assert out == {"steps": [], "fallback": True, "reason": "no API key on the server"}
    assert fake.calls == []


def test_every_trigger_without_key_returns_the_marker(monkeypatch):
    guide.reset()
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    for trigger in ("object", "change", "colours", "colors"):
        assert post({"trigger": trigger})["fallback"] is True
    assert client.post("/api/guide", json={"trigger": "nope"}).status_code == 422


def test_rate_limit_falls_back(fake, monkeypatch):
    monkeypatch.setattr(guide, "RATE_LIMIT", 2)
    for i in range(2):
        assert post({**BODY, "state": {**BODY["state"], "band": 10 + i}}).get("fallback") is None
    out = post({**BODY, "state": {**BODY["state"], "band": 30}})
    assert out == {"steps": [], "fallback": True, "reason": "rate limited"}
    assert len(fake.calls) == 2
    # a cached answer is still served when rate limited (it costs nothing)
    assert post({**BODY, "state": {**BODY["state"], "band": 10}})["cached"] is True


def test_cache_hit(fake):
    first = post()
    again = post()
    assert len(fake.calls) == 1
    assert again["cached"] is True and again["steps"] == first["steps"]
    # another state is another key
    post({**BODY, "state": {**BODY["state"], "frameIndex": 2}})
    assert len(fake.calls) == 2


def test_cached_reply_is_refiltered_for_the_new_page(fake):
    post()
    out = post({**BODY, "ids": ["sky:barnard"]})  # band-d6 no longer on screen
    assert out["cached"] is True
    assert out["steps"][1]["actions"] == [{"cmd": "set_band", "args": {"band": 93}}]


def test_failures_are_not_cached(fake):
    fake.reply = "garbage"
    assert post()["fallback"] is True
    fake.reply = GOOD
    assert post().get("fallback") is None
    assert len(fake.calls) == 2


def test_huge_context_falls_back(fake):
    out = post({**BODY, "facts": {"x": "a" * 9000}})
    assert out["reason"] == "context too large" and fake.calls == []


def test_allow_list_matches_the_browser_commands():
    """Every guide command and arg in guide.py is still registered in web/src (kept in sync)."""
    src = "\n".join(p.read_text() for p in WEB_SRC.rglob("*.js"))
    blocks = {}
    for m in re.finditer(r"register\(\s*'([a-z_0-9]+)'", src):
        end = src.find("register(", m.end())
        blocks.setdefault(m.group(1), []).append(src[m.end(): end if end > 0 else None])
    for name, args in guide.GUIDE_COMMANDS.items():
        assert name in blocks, f"{name} is no longer a command in web/src"
        for arg in args:
            assert any(re.search(rf"\b{arg}\s*:", b) for b in blocks[name]), f"{name}: arg {arg} not in its spec"


def test_click_actions_only_press_buttons_on_this_page():
    ids = {"band-d6", "op-trail", "sky:barnard"}
    assert guide.convert_action({"type": "click", "id": "band-d6"}, {}, ids) == ({"click": "band-d6"}, "")
    assert guide.convert_action({"type": "click", "id": "sky:barnard"}, {}, ids)[0] is None  # a sky object has no button
    assert guide.convert_action({"type": "click", "id": "not-here"}, {}, ids)[0] is None


def test_step_titles_are_kept():
    steps = guide.parse_reply(json.dumps({"steps": [{"title": "D6", "say": "Longest.", "actions": []}, {"title": "", "say": "Two.", "actions": []}]}))
    assert steps[0]["title"] == "D6" and "title" not in steps[1]
