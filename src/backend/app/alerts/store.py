"""Subscriptions and the log of sent alerts, as small JSON files under `data/alerts/`.

- `subscribers/<key>.json`: the email address, its regions, and when it was confirmed. `key` is a
  keyed hash of the address, so the same address always finds its own file and the file name
  reveals nothing. Only the subscribe, confirm and unsubscribe endpoints write these files.
- `sent/<key>.json`: which alerts that subscriber got (region and month -> label and time), and
  when each region last sent one. Only the alert run writes these files.

Each file has a single writer, which matters on a Cloud Storage mount, where the last write wins.
Nothing else about a person is kept, and unsubscribing deletes both files.

Links in the emails carry signed tokens (`sign`, `verify`), so they need no stored secret per
subscriber and cannot be guessed or altered.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .. import config

#: A sign-up not confirmed within this time is deleted.
PENDING_HOURS = 48
#: Most regions one subscription may follow.
MAX_REGIONS = 10
EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")


def root() -> Path:
    return config.data_dir() / "alerts"


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _mac(secret: str, text: str) -> str:
    return hmac.new(secret.encode(), text.encode(), hashlib.sha256).hexdigest()


def key_of(secret: str, email: str) -> str:
    """File key of an address: a keyed hash, so the same address maps to the same file."""
    return _mac(secret, "address:" + email.strip().lower())[:32]


def sign(secret: str, key: str, action: str) -> str:
    """Token for a link that performs `action` (`confirm` or `unsubscribe`) on subscription `key`."""
    return f"{key}.{action}.{_mac(secret, f'{key}.{action}')[:32]}"


def verify(secret: str, token: str, action: str) -> str | None:
    """The subscription key of a valid token for `action`, else None."""
    parts = (token or "").split(".")
    if len(parts) != 3 or parts[1] != action or not re.fullmatch(r"[0-9a-f]{32}", parts[0]):
        return None
    return parts[0] if hmac.compare_digest(sign(secret, parts[0], action), token) else None


@dataclass
class Subscriber:
    """One email address and the regions it follows. `pending` holds a requested set of regions
    until its confirmation link is used."""

    key: str
    email: str
    regions: list[str] = field(default_factory=list)
    pending: list[str] | None = None
    created: str = ""
    confirmed: str | None = None
    confirm_sent: str | None = None

    @property
    def active(self) -> bool:
        return self.confirmed is not None and bool(self.regions)


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _read(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def subscriber_path(key: str) -> Path:
    return root() / "subscribers" / f"{key}.json"


def sent_path(key: str) -> Path:
    return root() / "sent" / f"{key}.json"


def load(key: str) -> Subscriber | None:
    data = _read(subscriber_path(key))
    return Subscriber(**data) if data else None


def save(sub: Subscriber) -> None:
    _write(subscriber_path(sub.key), asdict(sub))


def delete(key: str) -> None:
    for path in (subscriber_path(key), sent_path(key)):
        path.unlink(missing_ok=True)


def subscribers() -> list[Subscriber]:
    folder = root() / "subscribers"
    out = []
    for path in sorted(folder.glob("*.json")) if folder.is_dir() else ():
        data = _read(path)
        if data:
            out.append(Subscriber(**data))
    return out


def expire_pending(at: dt.datetime | None = None) -> int:
    """Deletes sign-ups never confirmed within `PENDING_HOURS`; returns how many."""
    at = at or now()
    removed = 0
    for sub in subscribers():
        if sub.confirmed is None and sub.created and \
                at - dt.datetime.fromisoformat(sub.created) > dt.timedelta(hours=PENDING_HOURS):
            delete(sub.key)
            removed += 1
    return removed


def load_sent(key: str) -> dict:
    """{"alerts": {"<region>|<YYYY-MM>": {"label", "at"}}, "last": {region: at}}."""
    return _read(sent_path(key)) or {"alerts": {}, "last": {}}


def save_sent(key: str, sent: dict) -> None:
    _write(sent_path(key), sent)
