"""Downloads for the context layers: streamed to disk, with retries, and with an Earthdata token
sent only to NASA Earthdata hosts."""

from __future__ import annotations

import http.cookiejar
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .. import config
from ..pipeline.download import REDACT, USER_AGENT, _get

#: Hosts that receive the Earthdata token. Redirect targets elsewhere (signed S3 links) get none.
EARTHDATA_HOSTS = (".earthdata.nasa.gov", ".earthdatacloud.nasa.gov")
CMR_GRANULES = "https://cmr.earthdata.nasa.gov/search/granules.json"
CHUNK = 1 << 20


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D102
        return None


def _opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), _NoRedirect)


def earthdata_host(url: str) -> bool:
    """Whether a URL's host is a NASA Earthdata host, the only ones the token is sent to."""
    host = urllib.parse.urlsplit(url).hostname or ""
    return any(host.endswith(h) or host == h.lstrip(".") for h in EARTHDATA_HOSTS)


def download(url: str, dest: Path, token: str | None = None, tries: int = 4, timeout: float = 300) -> Path:
    """Streams `url` to `dest` (through a `.part` file) and returns `dest`; skips it when present.

    Redirects are followed by hand so that the token goes only to Earthdata hosts."""
    if dest.is_file():
        return dest
    if token:
        REDACT.add(token)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    last = ""
    for attempt in range(tries):
        opener, target = _opener(), url
        try:
            for _ in range(10):
                headers = {"User-Agent": USER_AGENT}
                if token and earthdata_host(target):
                    headers["Authorization"] = f"Bearer {token}"
                try:
                    resp = opener.open(urllib.request.Request(target, headers=headers), timeout=timeout)
                except urllib.error.HTTPError as exc:
                    if exc.code in (301, 302, 303, 307, 308):
                        target = urllib.parse.urljoin(target, exc.headers["Location"])
                        continue
                    raise
                with resp, tmp.open("wb") as f:
                    while chunk := resp.read(CHUNK):
                        f.write(chunk)
                tmp.replace(dest)
                return dest
            last = "too many redirects"
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise FileNotFoundError(REDACT(url)) from None
            if exc.code in (401, 403):
                raise PermissionError(f"{REDACT(url)}: HTTP {exc.code}. Check EARTHDATA_TOKEN in .env "
                                      "(tokens expire after 60 days).") from None
            last = f"HTTP {exc.code}"
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            last = type(exc).__name__
        time.sleep(3 * (attempt + 1))
    tmp.unlink(missing_ok=True)
    hint = " Check EARTHDATA_TOKEN in .env (tokens expire after 60 days)." if token else ""
    raise RuntimeError(f"{REDACT(url)}: {last} after {tries} tries.{hint}")


def granules(short_name: str, version: str, bbox: tuple[float, float, float, float] | None = None,
             temporal: str | None = None) -> list[dict]:
    """Granules of a NASA collection from the CMR search API (no account needed), each as
    `{"title", "start", "url"}` with the HTTPS data link."""
    out, page = [], 1
    while True:
        q = {"short_name": short_name, "version": version, "page_size": 2000, "page_num": page,
             "sort_key": "start_date"}
        if bbox:
            q["bounding_box"] = ",".join(str(v) for v in bbox)
        if temporal:
            q["temporal"] = temporal
        entries = json.loads(_get(f"{CMR_GRANULES}?{urllib.parse.urlencode(q)}"))["feed"]["entry"]
        for e in entries:
            links = [l["href"] for l in e.get("links", []) if l.get("rel", "").endswith("/data#")
                     and l["href"].startswith("https://")]
            if links:
                out.append({"title": e["title"], "start": e["time_start"][:10], "url": links[0]})
        if len(entries) < 2000:
            return out
        page += 1


def raw_dir(source: str) -> Path:
    """Folder of one source's original downloads, kept next to the FIRMS downloads so any reduction
    can be rerun without downloading again."""
    return config.raw_dir() / "context" / source
