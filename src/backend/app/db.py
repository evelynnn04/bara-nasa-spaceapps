"""Small DuckDB helpers shared by the pipeline and the API."""

from __future__ import annotations


def quote(s: str) -> str:
    """SQL string literal."""
    return "'" + s.replace("'", "''") + "'"
