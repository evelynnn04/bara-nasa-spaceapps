"""Email alerts: signed links, subscribing, confirming, unsubscribing, detection and no repeats."""

from __future__ import annotations

import datetime as dt
import email
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import store as tables
from app.alerts import api as alerts_api
from app.alerts import detect, mailer, settings, store
from app.main import app

from .conftest import BALI, RIAU, day_row, write_dataset
from .test_anomaly import PARAMS

SECRET = "test-secret"


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Alerts set up, writing emails to an outbox folder; returns the outbox. The repository `.env`
    is ignored, so a developer's SMTP settings never send test emails."""
    monkeypatch.setattr("app.config._secret", lambda var: os.environ.get(var, "").strip())
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("ALERTS_SECRET", SECRET)
    monkeypatch.setenv("ALERTS_OUTBOX", str(tmp_path / "outbox"))
    monkeypatch.setenv("PUBLIC_URL", "https://bara.example")
    monkeypatch.delenv("SMTP_HOST", raising=False)
    alerts_api._recent.clear()
    return tmp_path / "outbox"


def emails(outbox: Path) -> list[email.message.Message]:
    return [email.message_from_bytes(p.read_bytes()) for p in sorted(outbox.glob("*.eml"))] if outbox.is_dir() else []


def link(msg, path: str) -> str:
    body = msg.get_payload(decode=True).decode()
    return next(w for w in body.split() if path in w).split("token=")[1]


# --- signed links ----------------------------------------------------------------------------------


def test_tokens_cannot_be_forged_or_reused_for_another_action():
    key = store.key_of(SECRET, "Someone@Example.org ")
    assert key == store.key_of(SECRET, "someone@example.org")
    token = store.sign(SECRET, key, "confirm")
    assert store.verify(SECRET, token, "confirm") == key
    assert store.verify(SECRET, token, "unsubscribe") is None
    assert store.verify("other-secret", token, "confirm") is None
    assert store.verify(SECRET, token[:-1] + ("0" if token[-1] != "0" else "1"), "confirm") is None
    assert store.verify(SECRET, "nonsense", "confirm") is None


# --- subscribe, confirm, unsubscribe ---------------------------------------------------------------


def subscribe(client, address="person@example.org", regions=("idn-riau",), **extra):
    return client.post("/api/alerts/subscribe", json={"email": address, "regions": list(regions), **extra})


def test_subscribing_sends_only_a_confirmation_until_it_is_used(env):
    client = TestClient(app)
    assert client.get("/api/alerts/status").json() == {"enabled": True, "max_regions": 10}
    r = subscribe(client, regions=["idn-riau", "idn-bali"])
    assert r.status_code == 202 and r.json()["status"] == "check_email"
    [msg] = emails(env)
    assert msg["To"] == "person@example.org" and msg["Subject"] == "Confirm your fire activity alerts"
    assert "Riau" in msg.get_payload(decode=True).decode() and "Bali" in msg.get_payload(decode=True).decode()
    sub = store.load(store.key_of(SECRET, "person@example.org"))
    assert sub is not None and not sub.active
    # Asking again soon after sends no second email; the answer does not reveal the address is known.
    assert subscribe(client).json() == r.json() and len(emails(env)) == 1

    token = link(msg, "/api/alerts/confirm")
    page = client.get(f"/api/alerts/confirm?token={token}")
    assert page.status_code == 200 and 'method="post"' in page.text
    assert not store.load(sub.key).active  # opening the link alone (a mail scanner) confirms nothing
    done = client.post("/api/alerts/confirm", content=f"token={token}",
                       headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert done.status_code == 200 and "Alerts confirmed" in done.text
    sub = store.load(sub.key)
    assert sub.active and sub.regions == ["idn-riau"] and sub.pending is None


def test_bad_requests_bots_and_floods_are_turned_away(env):
    client = TestClient(app)
    assert subscribe(client, address="not-an-address").status_code == 400
    assert subscribe(client, regions=["idn-nowhere"]).status_code == 400
    assert subscribe(client, regions=[]).status_code == 400
    assert subscribe(client, regions=[f"idn-{i}" for i in range(11)]).status_code == 422
    assert subscribe(client, address="bot@example.org", website="http://spam").status_code == 202
    assert store.subscribers() == [] and emails(env) == []
    codes = [subscribe(client, address=f"p{i}@example.org").status_code for i in range(alerts_api.MAX_PER_CLIENT + 1)]
    assert codes[:-1] == [202] * alerts_api.MAX_PER_CLIENT and codes[-1] == 429


def test_unsubscribing_deletes_the_address_from_the_page_or_one_click(env):
    client = TestClient(app)
    for address in ("a@example.org", "b@example.org"):
        subscribe(client, address=address)
        sub = store.load(store.key_of(SECRET, address))
        sub.confirmed = "2026-11-01T00:00:00+00:00"
        store.save(sub)
        store.save_sent(sub.key, {"alerts": {"idn-riau|2026-11": {"label": "anomalous", "at": "x"}}, "last": {}})
    a, b = (store.key_of(SECRET, x) for x in ("a@example.org", "b@example.org"))
    ta, tb = store.sign(SECRET, a, "unsubscribe"), store.sign(SECRET, b, "unsubscribe")
    assert 'method="post"' in client.get(f"/api/alerts/unsubscribe?token={ta}").text and store.load(a)
    client.post("/api/alerts/unsubscribe", content=f"token={ta}", headers={"Content-Type": "application/x-www-form-urlencoded"})
    client.post(f"/api/alerts/unsubscribe?token={tb}", content="List-Unsubscribe=One-Click",
                headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert store.load(a) is None and store.load(b) is None
    assert not store.sent_path(a).exists() and not store.sent_path(b).exists()
    assert client.post("/api/alerts/unsubscribe?token=forged").status_code == 404


def test_alerts_are_off_without_a_secret(env, monkeypatch):
    monkeypatch.delenv("ALERTS_SECRET")
    monkeypatch.setattr("app.config._secret", lambda var: "")
    client = TestClient(app)
    assert client.get("/api/alerts/status").json()["enabled"] is False
    assert subscribe(client).status_code == 503
    assert detect.run() == 0


def test_unconfirmed_sign_ups_expire(env):
    old = store.Subscriber(key="1" * 32, email="old@example.org", regions=["idn-riau"],
                           created=(store.now() - dt.timedelta(hours=49)).isoformat())
    new = store.Subscriber(key="2" * 32, email="new@example.org", regions=["idn-riau"], created=store.now().isoformat())
    for s in (old, new):
        store.save(s)
    assert store.expire_pending() == 1 and [s.key for s in store.subscribers()] == [new.key]


# --- detection and no repeats ----------------------------------------------------------------------


def septembers(years, last: dt.date) -> list[tuple]:
    return [day_row(dt.date(y, 9, 1) + dt.timedelta(days=i)) for y in years for i in range(30)
            if dt.date(y, 9, 1) + dt.timedelta(days=i) <= last]


@pytest.fixture
def fire_record(tmp_path):
    """Septembers 2003-2015: Bali burns a little every year, Riau only in 2015. The record ends on
    20 September 2015, so that month is in progress with 12 earlier Septembers to compare."""
    years, last = range(2003, 2016), dt.date(2015, 9, 20)
    celldays = []
    for y in years:
        for i in range(0, 30, 3):
            d = dt.date(y, 9, 1) + dt.timedelta(days=i)
            if d > last:
                continue
            sensor, platform = ("modis", "Aqua") if y < 2012 else ("viirs", "SNPP")
            celldays.append((sensor, platform, d, BALI[0], BALI[1], 2 + y % 3, 1, 6.0 + y % 3, 3.0))
            if y == 2015:
                celldays.append((sensor, platform, d, RIAU[0], RIAU[1], 20, 5, 200.0, 40.0))
    root = write_dataset(tmp_path / "tables", celldays, septembers(years, last), [RIAU, BALI])
    return tables.connect(PARAMS, root)


def follower(regions, address="person@example.org") -> store.Subscriber:
    sub = store.Subscriber(key=store.key_of(SECRET, address), email=address, regions=regions,
                           created="2026-11-01T00:00:00+00:00", confirmed="2026-11-01T00:00:00+00:00")
    store.save(sub)
    return sub


def test_an_anomaly_sends_one_email_and_never_the_same_again(env, fire_record):
    riau = follower(["idn-riau"])
    follower(["idn-bali"], "bali@example.org")
    assert detect.run(fire_record) == 1
    [msg] = emails(env)
    assert msg["To"] == "person@example.org"
    assert msg["Subject"] == "Fire alert: Riau, September 2015 is anomalous"
    text = msg.get_payload(decode=True).decode()
    assert "1-20 September, the month is not over yet" in text and "more than in 12 of the 12 other years" in text
    assert "area=idn-riau&from=2015-09-01&to=2015-09-20" in text
    assert msg["List-Unsubscribe"].startswith("<https://bara.example/api/alerts/unsubscribe?token=")
    assert msg["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"
    assert store.load_sent(riau.key)["alerts"]["idn-riau|2015-09"]["label"] == "anomalous"
    assert detect.run(fire_record) == 0 and len(emails(env)) == 1


def test_a_failed_send_is_not_recorded_and_is_tried_again(env, fire_record, monkeypatch):
    riau = follower(["idn-riau"])
    real = mailer.send
    monkeypatch.setattr(mailer, "send", lambda s, msg: (_ for _ in ()).throw(OSError("connection refused")))
    assert detect.run(fire_record) == 0 and store.load_sent(riau.key)["alerts"] == {}
    monkeypatch.setattr(mailer, "send", real)
    assert detect.run(fire_record) == 1


def finding(label: str, month: int = 9, days: int = 20, provisional: bool = True, activity: float = 100.0) -> detect.Finding:
    start = dt.date(2026, month, 1)
    return detect.Finding("idn-riau", 2026, month, start, start + dt.timedelta(days=days - 1), provisional,
                          {"label": label, "activity": activity})


def test_due_rules_for_level_rises_cooldown_and_young_months(env):
    s, at = settings(), dt.datetime(2026, 9, 25, tzinfo=dt.timezone.utc)
    empty = {"alerts": {}, "last": {}}
    assert detect.due([finding("elevated")], empty, s, at) == []
    assert detect.due([finding("anomalous", days=5)], empty, s, at) == []
    assert detect.due([finding("anomalous", days=5, provisional=False)], empty, s, at) != []
    assert detect.due([finding("anomalous", activity=0.4)], empty, s, at) == []
    sent = {"alerts": {"idn-riau|2026-09": {"label": "anomalous", "at": "2026-09-10T14:00:00+00:00"}},
            "last": {"idn-riau": "2026-09-10T14:00:00+00:00"}}
    assert detect.due([finding("anomalous")], sent, s, at) == []
    assert detect.due([finding("extreme")], sent, s, at) != []
    sent["last"]["idn-riau"] = "2026-09-22T14:00:00+00:00"
    assert detect.due([finding("extreme")], sent, s, at) == []
    # With two months qualifying (early in a month), the later one is sent.
    both = [finding("anomalous", month=8, provisional=False), finding("anomalous", month=9)]
    assert [f.month for f in detect.due(both, {"alerts": {}, "last": {}}, s, at)] == [9]


def test_replay_finds_the_season_once(env, fire_record):
    found = detect.replay(dt.date(2015, 9, 1), dt.date(2015, 9, 20), ["idn-riau", "idn-bali"], con=fire_record)
    assert [(a["day"], a["region"], a["label"]) for a in found] == [("2015-09-07", "idn-riau", "anomalous")]
