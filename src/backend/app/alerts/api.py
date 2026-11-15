"""Subscribe, confirm and unsubscribe: `/api/alerts/...`.

- `POST /api/alerts/subscribe` (JSON `{email, regions}`) emails a confirmation link; nothing is sent
  to the address until that link is used. The answer is the same whether or not the address was
  already known, so the endpoint does not reveal who subscribed.
- `GET /api/alerts/confirm?token=...` shows a page with a button that confirms (a `POST`), so a mail
  scanner opening the link cannot confirm on the person's behalf.
- `GET /api/alerts/unsubscribe?token=...` shows a page with a button; `POST` unsubscribes and
  deletes everything kept about the address. Mail clients' one-click unsubscribe (RFC 8058) posts
  to the same address.
- `GET /api/alerts/status` says whether alerts are set up, for the dashboard.

Abuse limits: a hidden form field bots fill in, at most `MAX_PER_CLIENT` sign-ups per client every
`WINDOW_MINUTES`, and at most one confirmation email per address every `RESEND_MINUTES`.
"""

from __future__ import annotations

import datetime as dt
import html
import threading
import time
from collections import defaultdict, deque
from urllib.parse import parse_qs

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from . import mailer, settings, store
from .detect import area_name, areas

router = APIRouter(prefix="/api/alerts")

MAX_PER_CLIENT = 5
WINDOW_MINUTES = 10
RESEND_MINUTES = 10
_recent: dict[str, deque] = defaultdict(deque)
_recent_lock = threading.Lock()


class Subscription(BaseModel):
    email: str = Field(max_length=254)
    regions: list[str] = Field(max_length=store.MAX_REGIONS)
    #: Hidden field: people leave it empty, form-filling bots do not.
    website: str = ""


def _enabled():
    s = settings()
    if not s.enabled:
        raise HTTPException(503, "Email alerts are not set up on this server.")
    return s


def _client(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "?")


def _throttled(client: str) -> bool:
    with _recent_lock:
        q, now = _recent[client], time.monotonic()
        while q and now - q[0] > WINDOW_MINUTES * 60:
            q.popleft()
        if len(q) >= MAX_PER_CLIENT:
            return True
        q.append(now)
        return False


def _page(title: str, body: str, status: int = 200) -> HTMLResponse:
    return HTMLResponse(f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title>
<style>body{{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#222}}
button{{font:inherit;padding:.5rem 1rem;border-radius:999px;border:1px solid #c45a1c;background:#e8722a;color:#fff;cursor:pointer}}
a{{color:#c45a1c}}</style></head><body><h1>{html.escape(title)}</h1>{body}</body></html>""", status_code=status)


@router.get("/status")
def status() -> dict:
    """Whether alerts are set up, and how many regions one subscription may follow."""
    return {"enabled": settings().enabled, "max_regions": store.MAX_REGIONS}


@router.post("/subscribe", status_code=202)
def subscribe(body: Subscription, request: Request) -> dict:
    """Starts a subscription (or a change of regions) and emails its confirmation link."""
    s = _enabled()
    done = {"status": "check_email", "message": "Check your inbox for a link to confirm your alerts."}
    if body.website:
        return done
    email = body.email.strip()
    if not store.EMAIL.match(email):
        raise HTTPException(400, "email: enter a valid email address")
    known = areas()
    regions = sorted(set(body.regions))
    if not regions or any(r not in known for r in regions):
        raise HTTPException(400, f"regions: choose 1 to {store.MAX_REGIONS} provinces or cities/regencies")
    if _throttled(_client(request)):
        raise HTTPException(429, "Too many sign-ups from here. Try again in a few minutes.")
    now = store.now()
    key = store.key_of(s.secret, email)
    sub = store.load(key) or store.Subscriber(key=key, email=email, created=now.isoformat(timespec="seconds"))
    if sub.confirmed is None:
        sub.regions = regions
    sub.pending = regions
    if sub.confirm_sent and now - dt.datetime.fromisoformat(sub.confirm_sent) < dt.timedelta(minutes=RESEND_MINUTES):
        store.save(sub)
        return done
    sub.confirm_sent = now.isoformat(timespec="seconds")
    store.save(sub)
    link = f"{s.public_url}/api/alerts/confirm?token={store.sign(s.secret, key, 'confirm')}"
    names = "\n".join(f"  - {area_name(r)}" for r in regions)
    text = (f"Someone, hopefully you, asked for email alerts about unusual fire activity in:\n\n{names}\n\n"
            f"Confirm with this link:\n{link}\n\nIf this was not you, ignore this email and nothing will be sent. "
            f"The request expires in {store.PENDING_HOURS} hours.")
    mailer.send(s, mailer.message(s, email, "Confirm your fire activity alerts", text))
    return done


async def _posted_token(request: Request, token: str) -> str:
    """The token from the link, else from the posted form (parsed here, without extra packages)."""
    if token:
        return token
    body = (await request.body())[:4096].decode("utf-8", errors="replace")
    return parse_qs(body).get("token", [""])[0]


def _form(action: str, token: str, label: str) -> str:
    return (f'<form method="post" action="/api/alerts/{action}"><input type="hidden" name="token" '
            f'value="{html.escape(token)}"><button type="submit">{html.escape(label)}</button></form>')


@router.get("/confirm", response_class=HTMLResponse)
def confirm_page(token: str = "") -> HTMLResponse:
    s = _enabled()
    key = store.verify(s.secret, token, "confirm")
    sub = store.load(key) if key else None
    if sub is None or not sub.pending:
        return _page("Link expired", "<p>This confirmation link is not valid any more. Sign up again on the dashboard.</p>", 404)
    names = "".join(f"<li>{html.escape(area_name(r))}</li>" for r in sub.pending)
    return _page("Confirm your alerts", f"<p>Email alerts for:</p><ul>{names}</ul>{_form('confirm', token, 'Confirm')}")


@router.post("/confirm", response_class=HTMLResponse)
async def confirm(request: Request, token: str = "") -> HTMLResponse:
    s = _enabled()
    key = store.verify(s.secret, await _posted_token(request, token), "confirm")
    sub = store.load(key) if key else None
    if sub is None or not sub.pending:
        return _page("Link expired", "<p>This confirmation link is not valid any more. Sign up again on the dashboard.</p>", 404)
    sub.regions, sub.pending = sub.pending, None
    sub.confirmed = store.now().isoformat(timespec="seconds")
    store.save(sub)
    unsubscribe = f"{s.public_url}/api/alerts/unsubscribe?token={store.sign(s.secret, key, 'unsubscribe')}"
    return _page("Alerts confirmed", "<p>You will get an email when fire activity in your regions becomes unusual. "
                 f'Every email has an unsubscribe link, or use <a href="{html.escape(unsubscribe)}">this one</a>.</p>')


@router.get("/unsubscribe", response_class=HTMLResponse)
def unsubscribe_page(token: str = "") -> HTMLResponse:
    s = _enabled()
    if not store.verify(s.secret, token, "unsubscribe"):
        return _page("Link not valid", "<p>This unsubscribe link is not valid.</p>", 404)
    return _page("Unsubscribe", "<p>Stop all fire activity alerts to this address and delete it?</p>"
                 + _form("unsubscribe", token, "Unsubscribe"))


@router.post("/unsubscribe", response_class=HTMLResponse)
async def unsubscribe(request: Request, token: str = "") -> HTMLResponse:
    """Unsubscribes from the page's button (token in the form) or a mail client's one-click
    request (token in the link, `List-Unsubscribe=One-Click` in the body)."""
    s = _enabled()
    key = store.verify(s.secret, await _posted_token(request, token), "unsubscribe")
    if not key:
        return _page("Link not valid", "<p>This unsubscribe link is not valid.</p>", 404)
    store.delete(key)
    return _page("Unsubscribed", "<p>You will not get any more alerts, and your address has been deleted.</p>")
