"""Scoring the subscribed regions and sending the alert emails.

After each update (`run`), every region someone follows is scored for the month of the last data
day, with the same method as the dashboard's anomaly card (`app.anomaly`): the month so far,
against the same days of the same month in every other year of the record. During the first
`LOOK_BACK_DAYS` days of a month the month before is scored too, so an anomaly that appeared in its
last days is still reported.

A region triggers an alert when its label reaches `ALERTS_MIN_LABEL` (`anomalous` by default) and,
for a month still in progress, at least `MIN_DAYS` days of it are in the record: a day or two of
fire says little about a month. It also needs at least `MIN_HOTSPOTS` hotspots: in a place that
rarely burns, one or two detections already rank above most years, which is not worth an email.
For each subscriber, an alert is sent at most once per region and month, again only if the label
rises, and at most once per region every `COOLDOWN_DAYS` days. All of a subscriber's alerts from
one run go in one email. An alert is recorded only once its email was sent, so a failed send is
tried again on the next run.

`replay` steps the record through past days as if each were the last data day, with an imaginary
subscriber, and writes the emails that would have gone out: the evidence that the rules fire on
known fire seasons and never twice.
"""

from __future__ import annotations

import calendar
import datetime as dt
import json
import logging
from dataclasses import dataclass, replace
from functools import lru_cache
from urllib.parse import urlencode

import duckdb

from .. import anomaly, config, queries, store as tables
from ..harmonise import weights
from . import LABEL_RANK, Settings, mailer, settings, store

log = logging.getLogger("app.alerts")

LOOK_BACK_DAYS = 3
COOLDOWN_DAYS = 7
MIN_DAYS = 7
MIN_HOTSPOTS = 5.0
MONTHS = [calendar.month_name[m] for m in range(13)]


@lru_cache(maxsize=1)
def areas() -> dict[str, dict]:
    """Every area of the boundary file: id -> {"name", "level", "parent"}."""
    doc = json.loads(config.boundaries_path().read_text(encoding="utf-8"))
    return {f["properties"]["id"]: {"name": f["properties"]["name"], "level": f["properties"]["level"],
                                    "parent": f["properties"].get("parentId")} for f in doc["features"]}


def area_name(region: str) -> str:
    a = areas().get(region)
    if a is None:
        return region
    parent = areas().get(a["parent"] or "")
    return f"{a['name']}, {parent['name']}" if a["level"] == "regency" and parent else a["name"]


@dataclass(frozen=True)
class Finding:
    """One region's score for one month."""

    region: str
    year: int
    month: int
    start: dt.date
    end: dt.date
    provisional: bool
    record: dict

    @property
    def label(self) -> str:
        return self.record["label"]

    @property
    def key(self) -> str:
        return f"{self.region}|{self.year}-{self.month:02d}"


def months_to_score(last: dt.date) -> list[tuple[int, int]]:
    out = [(last.year, last.month)]
    if last.day <= LOOK_BACK_DAYS:
        prev = last.replace(day=1) - dt.timedelta(days=1)
        out.insert(0, (prev.year, prev.month))
    return out


def score(con: duckdb.DuckDBPyConnection, flags: list[tuple], regions: set[str]) -> list[Finding]:
    """Scores of every region for the months to report, from the record in `flags`."""
    by_level: dict[str, list[str]] = {"country": [], "province": [], "regency": []}
    for r in sorted(regions):
        level = "country" if r == "idn" else (areas().get(r) or {}).get("level")
        if level in by_level:
            by_level[level].append(r)
    out = []
    for year, month in months_to_score(flags[-1][0]):
        try:
            b = anomaly.baseline(flags, year, month)
        except ValueError:
            continue
        values: dict[str, dict] = {}
        if by_level["country"]:
            values["idn"] = anomaly.totals(con, b.windows).get(None, {})
        for level, col in (("province", "province_id"), ("regency", "regency_id")):
            ids = by_level[level]
            if ids:
                listing = ", ".join(f"'{i}'" for i in ids)
                found = anomaly.totals(con, b.windows, f"k.{col} IN ({listing})", f"c.{col}")
                values.update({i: found.get(i, {}) for i in ids})
        for region, v in values.items():
            rec = anomaly.record(v, b)
            out.append(Finding(region, year, month, b.target.start, b.target.end, b.provisional, rec))
    return out


def due(findings: list[Finding], sent: dict, s: Settings, at: dt.datetime) -> list[Finding]:
    """The findings to email one subscriber: high enough, not sent for that month at that label or
    higher, and outside the region's cooldown. When two months of a region qualify, the later one."""
    floor = LABEL_RANK[s.min_label]
    picked: dict[str, Finding] = {}
    for f in findings:
        rank = LABEL_RANK.get(f.label, -1)
        if rank < floor or (f.provisional and (f.end - f.start).days + 1 < MIN_DAYS) \
                or f.record.get("activity", 0.0) < MIN_HOTSPOTS:
            continue
        before = sent["alerts"].get(f.key)
        if before and LABEL_RANK.get(before["label"], -1) >= rank:
            continue
        last = sent["last"].get(f.region)
        if last and at - dt.datetime.fromisoformat(last) < dt.timedelta(days=COOLDOWN_DAYS):
            continue
        picked[f.region] = f
    return list(picked.values())


def _ranked_below(f: Finding) -> tuple[int, int]:
    """How many reference years the month beat, and how many there were."""
    n = f.record["history"]["activity"]["n"] or 0
    score_ = f.record.get("activity_score") or 0.0
    at_least = round((1 - score_) * (n + 1) - 1)
    return max(0, n - at_least), n


def _fmt(v: float) -> str:
    return f"{v:,.0f}" if v >= 100 else f"{v:,.1f}"


def paragraph(f: Finding, s: Settings) -> str:
    """The narrative of one finding."""
    rec, name = f.record, area_name(f.region)
    beat, n = _ranked_below(f)
    median = rec["history"]["activity"]["median"] or 0.0
    when = f"{MONTHS[f.month]} {f.year}"
    span = f"{f.start.day}-{f.end.day} {MONTHS[f.month]}" + (", the month is not over yet" if f.provisional else "")
    lines = [
        f"{name}: fire activity in {when} is {rec['label']} ({span}).",
        f"  {_fmt(rec['activity'])} hotspots (Aqua MODIS-equivalent), more than in {beat} of the {n} other years "
        f"on record over the same days of {MONTHS[f.month]} (median {_fmt(median)}).",
        f"  Fire radiative power: {_fmt(rec['frp_mw'])} MW ({rec['frp_label']}).",
    ]
    if rec.get("disclaimer"):
        lines.append(f"  Note: {rec['disclaimer']}")
    query = urlencode({"area": f.region, "from": f.start.isoformat(), "to": f.end.isoformat()})
    lines.append(f"  On the map: {s.public_url}/dashboard/?{query}")
    return "\n".join(lines)


FOOTER = ("How this works: each month is compared with the same days of the same month in every other year "
          "of the NASA FIRMS record since 2002 (MODIS and VIIRS satellites, harmonised). \"Anomalous\" means "
          "the month ranks in the top tenth of the years on record for that month. The thresholds are "
          "provisional, the satellites miss fires under cloud, and this is a record of observed fire, not a "
          "fire danger forecast.")


def compose(f_list: list[Finding], sub: store.Subscriber, s: Settings):
    """The email of one subscriber's findings."""
    if len(f_list) == 1:
        f = f_list[0]
        subject = f"Fire alert: {area_name(f.region)}, {MONTHS[f.month]} {f.year} is {f.label}"
    else:
        subject = f"Fire alerts: unusual fire activity in {len(f_list)} of your regions"
    unsubscribe = f"{s.public_url}/api/alerts/unsubscribe?token={store.sign(s.secret, sub.key, 'unsubscribe')}"
    body = "\n\n".join([
        "Unusual fire activity was detected in the regions you follow.",
        *(paragraph(f, s) for f in sorted(f_list, key=lambda f: area_name(f.region))),
        FOOTER,
        f"You get these emails because you subscribed on {s.public_url}.\nUnsubscribe: {unsubscribe}",
    ])
    return mailer.message(s, sub.email, subject, body, unsubscribe)


def notify(findings: list[Finding], subs: list[store.Subscriber], s: Settings, at: dt.datetime,
           ledger: dict[str, dict] | None = None) -> list[tuple[store.Subscriber, list[Finding], str]]:
    """Sends each subscriber the findings due to them and records them; returns what was sent.
    `ledger` replaces the sent files (the replay keeps it in memory)."""
    out = []
    for sub in subs:
        if not sub.active:
            continue
        mine = [f for f in findings if f.region in sub.regions]
        sent = ledger.setdefault(sub.key, {"alerts": {}, "last": {}}) if ledger is not None else store.load_sent(sub.key)
        todo = due(mine, sent, s, at)
        if not todo:
            continue
        try:
            where = mailer.send(s, compose(todo, sub, s))
        except Exception as exc:  # noqa: BLE001 - one failed address must not stop the others
            log.error("alert email to subscriber %s failed: %s", sub.key[:8], exc)
            continue
        stamp = at.isoformat(timespec="seconds")
        for f in todo:
            sent["alerts"][f.key] = {"label": f.label, "at": stamp}
            sent["last"][f.region] = stamp
        if ledger is None:
            store.save_sent(sub.key, sent)
        out.append((sub, todo, where))
    return out


def run(con: duckdb.DuckDBPyConnection | None = None) -> int:
    """Scores the subscribed regions on the data being served and sends the alerts due; returns
    the number of emails sent. Does nothing when alerts are not set up or nobody follows a region."""
    s = settings()
    if not s.enabled:
        return 0
    store.expire_pending()
    subs = [sub for sub in store.subscribers() if sub.active]
    regions = {r for sub in subs for r in sub.regions}
    if not regions:
        return 0
    con = con or tables.connect(weights.load_params())
    findings = score(con, queries.day_flags(con), regions)
    sent = notify(findings, subs, s, store.now())
    log.info("alerts: %d region(s) scored, %d email(s) sent", len(regions), len(sent))
    return len(sent)


def replay(start: dt.date, end: dt.date, regions: list[str], step_days: int = 1,
           con: duckdb.DuckDBPyConnection | None = None) -> list[dict]:
    """Steps the last data day from `start` to `end` and returns the alerts an imaginary
    subscriber to `regions` would have received, writing each email to the outbox."""
    s = settings()
    s = replace(s, secret=s.secret or "replay", smtp_host="")
    con = con or tables.connect(weights.load_params())
    flags = queries.day_flags(con)
    sub = store.Subscriber(key="0" * 32, email="replay@example.org", regions=regions, created="", confirmed="replay")
    ledger: dict[str, dict] = {}
    out = []
    day = start
    while day <= end:
        upto = [f for f in flags if f[0] <= day]
        if upto:
            at = dt.datetime(day.year, day.month, day.day, 14, tzinfo=dt.timezone.utc)
            for _, found, where in notify(score(con, upto, set(regions)), [sub], s, at, ledger):
                out += [{"day": day.isoformat(), "region": f.region, "month": f"{f.year}-{f.month:02d}",
                         "label": f.label, "activity": f.record["activity"], "email": where} for f in found]
        day += dt.timedelta(days=step_days)
    return out
