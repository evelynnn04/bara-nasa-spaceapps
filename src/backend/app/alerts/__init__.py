"""Email alerts: people subscribe to provinces or cities/regencies and get an email when a month's
fire activity there becomes unusual (see docs/alerts.md).

- `store`: subscriptions and the log of what was sent, as small files under `data/alerts/`;
- `mailer`: sending through any SMTP provider, or writing the emails to a folder;
- `detect`: scoring the subscribed regions after each update and composing the emails;
- `api`: subscribe, confirm and unsubscribe.

Settings, from the environment or `.env`:

| Setting | Meaning |
|---|---|
| `ALERTS_SECRET` | Signs the confirm and unsubscribe links. Alerts are off without it |
| `ALERTS_FROM` | Sender, for example `Bara fire alerts <alerts@example.org>` |
| `PUBLIC_URL` | Address of the website, for the links in the emails |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | The provider's SMTP server (port 587 with STARTTLS, or 465 with TLS) |
| `ALERTS_OUTBOX` | Folder the emails are written to instead, when no SMTP server is set (default `data/alerts/outbox`) |
| `ALERTS_MIN_LABEL` | Lowest label that triggers an email: `anomalous` (default) or `elevated` |
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .. import config

#: Labels in the order of the anomaly scores (see `app.anomaly`).
LABEL_RANK = {"normal": 0, "elevated": 1, "anomalous": 2, "extreme": 3}


@dataclass(frozen=True)
class Settings:
    secret: str
    sender: str
    public_url: str
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str
    outbox: Path
    min_label: str

    @property
    def enabled(self) -> bool:
        return bool(self.secret)


def settings() -> Settings:
    """The alert settings, read afresh each time (tests and long-running processes may change them)."""
    min_label = config.setting("ALERTS_MIN_LABEL", "anomalous")
    if min_label not in ("elevated", "anomalous"):
        min_label = "anomalous"
    return Settings(
        secret=config.setting("ALERTS_SECRET"),
        sender=config.setting("ALERTS_FROM", "Bara fire alerts <alerts@localhost>"),
        public_url=config.setting("PUBLIC_URL", "http://localhost:8000").rstrip("/"),
        smtp_host=config.setting("SMTP_HOST"),
        smtp_port=int(config.setting("SMTP_PORT", "587") or 587),
        smtp_user=config.setting("SMTP_USER"),
        smtp_password=config.setting("SMTP_PASSWORD"),
        outbox=Path(config.setting("ALERTS_OUTBOX") or config.data_dir() / "alerts" / "outbox"),
        min_label=min_label,
    )
