"""Sending the alert emails through any SMTP provider, or writing them to a folder.

With `SMTP_HOST` set the email goes to that server (port 465 with TLS, any other port with
STARTTLS), logged in with `SMTP_USER` and `SMTP_PASSWORD`. Without it the email is written to the
outbox folder as an `.eml` file, which is how the tests and the historical replay check them.
"""

from __future__ import annotations

import datetime as dt
import re
import smtplib
import ssl
from email import policy
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from . import Settings


def message(s: Settings, to: str, subject: str, text: str, unsubscribe: str | None = None) -> EmailMessage:
    """A plain-text email with one-click unsubscribe headers (RFC 8058) when `unsubscribe` is given."""
    # Headers are not folded: a folded List-Unsubscribe link would be encoded and stop working.
    msg = EmailMessage(policy=policy.default.clone(max_line_length=998))
    msg["From"] = s.sender
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(usegmt=True)
    domain = s.sender.rsplit("@", 1)[-1].strip(" >") or "localhost"
    msg["Message-ID"] = make_msgid(domain=domain)
    if unsubscribe:
        msg["List-Unsubscribe"] = f"<{unsubscribe}>"
        msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    msg.set_content(text)
    return msg


def send(s: Settings, msg: EmailMessage) -> str:
    """Sends or writes one email; returns where it went. Raises on failure, so the caller can
    leave the alert unrecorded and try again on the next run."""
    if s.smtp_host:
        context = ssl.create_default_context()
        if s.smtp_port == 465:
            server = smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, timeout=30, context=context)
        else:
            server = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=30)
            server.starttls(context=context)
        with server:
            if s.smtp_user:
                server.login(s.smtp_user, s.smtp_password)
            server.send_message(msg)
        return f"smtp:{s.smtp_host}"
    s.outbox.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    who = re.sub(r"[^a-z0-9]+", "-", str(msg["To"]).lower()).strip("-")[:40]
    path = s.outbox / f"{stamp}-{who}.eml"
    path.write_bytes(bytes(msg))
    return str(path)
