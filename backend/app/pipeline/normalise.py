"""Raw FIRMS CSV files -> one Parquet file per product and year, in one schema.

For each product (all years at once, then written out per acquisition year):

1. read its archive files and every API file, all columns as text;
2. map them to the schema below (MODIS and VIIRS name their brightness columns differently, and
   MODIS confidence is 0-100 where VIIRS uses l/n/h);
3. drop exact duplicate rows;
4. keep, for each satellite and UTC day, only the best source present
   (archive, then API standard product, then near-real-time), so overlapping downloads never
   count twice;
5. clip API rows to Indonesia (the archive is already clipped by FIRMS).

Afterwards a static-source mask is built from every typed detection: 0.01° cells where at least
`MASK_MIN_STATIC` detections are typed as volcano, other static source or offshore, and those make
up at least `MASK_MIN_SHARE` of the typed detections. Near-real-time rows carry no type; the
cell-day build treats them as vegetation fires unless they fall on this mask.

Schema: sensor, platform, acq_utc, acq_date, local_date, daynight, lon, lat, frp, confidence,
type, brightness, scan, track, version, source.
`local_date` is the local solar day, UTC + longitude / 15 hours.
"""

from __future__ import annotations

import logging
from pathlib import Path

import duckdb

from .. import config, geo
from ..db import quote

log = logging.getLogger("app.normalise")

MASK_RES = 0.01
MASK_MIN_STATIC = 3
MASK_MIN_SHARE = 0.5
#: API rows are kept inside the outlines or within this many 0.01° raster cells of them.
CLIP_DILATE = 1

def detections_dir() -> Path:
    return config.parquet_dir() / "detections"


def detections_glob() -> str:
    return str(detections_dir() / "*.parquet")


def static_mask_path() -> Path:
    return config.derived_dir() / "static_mask.parquet"


def _api_files(stream: config.Stream) -> list[tuple[Path, str]]:
    out = []
    for source, product in ((stream.api_sp, "sp"), (stream.api_nrt, "nrt")):
        folder = config.raw_dir() / "api" / source
        if folder.is_dir():
            out += [(p, product) for p in sorted(folder.glob("*.csv"))]
    return out


def _select(sensor: str, has_type: bool) -> str:
    """SELECT over view `src` (FIRMS column names, all text) producing the schema."""
    if sensor == "modis":
        bright = "brightness"
        conf = (f"CASE WHEN CAST(confidence AS INTEGER) < {config.MODIS_LOW_BELOW} THEN 'low' "
                f"WHEN CAST(confidence AS INTEGER) > {config.MODIS_HIGH_ABOVE} THEN 'high' ELSE 'nominal' END")
    else:
        bright = "bright_ti4"
        conf = "CASE lower(trim(confidence)) WHEN 'l' THEN 'low' WHEN 'n' THEN 'nominal' WHEN 'h' THEN 'high' END"
    codes = " ".join(f"WHEN {quote(k)} THEN {quote(v)}" for k, v in config.SATELLITE_CODES.items())
    ts = "strptime(acq_date || ' ' || lpad(trim(acq_time), 4, '0'), '%Y-%m-%d %H%M')"
    type_expr = "CAST(nullif(trim(type), '') AS TINYINT)" if has_type else "CAST(NULL AS TINYINT)"
    return f"""
        SELECT DISTINCT
            '{sensor}' AS sensor,
            CASE trim(satellite) {codes} END AS platform,
            {ts} AS acq_utc,
            CAST(acq_date AS DATE) AS acq_date,
            CAST({ts} + to_seconds(CAST(round(CAST(longitude AS DOUBLE) * 240) AS BIGINT)) AS DATE) AS local_date,
            upper(trim(daynight)) AS daynight,
            CAST(longitude AS DOUBLE) AS lon,
            CAST(latitude AS DOUBLE) AS lat,
            CAST(nullif(trim(frp), '') AS FLOAT) AS frp,
            {conf} AS confidence,
            {type_expr} AS type,
            CAST({bright} AS FLOAT) AS brightness,
            CAST(scan AS FLOAT) AS scan,
            CAST(track AS FLOAT) AS track,
            trim(version) AS version,
            src_kind AS source
        FROM src
    """


def _header(path: Path) -> list[str]:
    with path.open(encoding="utf-8", errors="replace") as f:
        return f.readline().strip().split(",")


def _load_clip(con: duckdb.DuckDBPyConnection) -> None:
    """Table `clip(iy, ix0, ix1)`: 0.01° raster runs covering Indonesia's outlines, dilated."""
    boundaries = geo.load_boundaries()
    raster = geo.LabelRaster(MASK_RES)
    for b in boundaries:
        if b.level in ("province", "regency"):
            raster.fill(b.rings, 1)
    spans = raster.spans(CLIP_DILATE)
    path = config.derived_dir() / "clip_spans.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("iy,ix0,ix1\n" + "\n".join(f"{a},{b},{c}" for a, b, c in spans) + "\n")
    con.execute(f"CREATE OR REPLACE TEMP TABLE clip AS SELECT * FROM read_csv({quote(str(path))}, header=true)")


def normalise_stream(con: duckdb.DuckDBPyConnection, stream: config.Stream) -> int:
    """Writes `{stream}_{year}.parquet` for every acquisition year present; returns the row count."""
    inputs = [(p, "archive") for p in sorted((config.raw_dir() / "archive").glob(f"{stream.key}_*.csv"))]
    inputs += _api_files(stream)
    if not inputs:
        return 0

    parts = []
    n_raw = 0
    for kind in ("archive", "sp", "nrt"):
        files = [p for p, k in inputs if k == kind]
        if not files:
            continue
        has_type = all("type" in _header(p) for p in files)
        listing = "[" + ", ".join(quote(str(p)) for p in files) + "]"
        con.execute(f"""
            CREATE OR REPLACE TEMP VIEW src AS
            SELECT *, '{kind}' AS src_kind
            FROM read_csv({listing}, header=true, all_varchar=true, union_by_name=true)
        """)
        n_raw += con.execute("SELECT count(*) FROM src").fetchone()[0]
        con.execute(f"CREATE OR REPLACE TEMP TABLE part_{kind} AS {_select(stream.sensor, has_type)}")
        parts.append(f"SELECT * FROM part_{kind}")

    con.execute(f"CREATE OR REPLACE TEMP TABLE rows AS {' UNION ALL '.join(parts)}")
    bad = con.execute(f"""
        SELECT count(*) FILTER (WHERE platform IS NULL),
               count(*) FILTER (WHERE confidence IS NULL),
               count(*) FILTER (WHERE daynight NOT IN ('D', 'N')),
               count(*) FILTER (WHERE type IS NOT NULL AND type NOT BETWEEN 0 AND 3),
               count(*) FILTER (WHERE platform NOT IN ({', '.join(map(quote, stream.platforms))}))
        FROM rows
    """).fetchone()
    if any(bad):
        raise ValueError(f"{stream.key}: rows failing validation "
                         f"(platform, confidence, daynight, type, wrong platform) = {bad}")

    west, south = config.INDONESIA_BBOX[0], config.INDONESIA_BBOX[1]
    rank = "CASE source WHEN 'archive' THEN 0 WHEN 'sp' THEN 1 ELSE 2 END"
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE kept AS
        WITH ranked AS (
            SELECT *, {rank} AS r, min({rank}) OVER (PARTITION BY platform, acq_date) AS best FROM rows
        )
        SELECT k.* EXCLUDE (r, best) FROM ranked k
        WHERE k.r = k.best AND (k.source = 'archive' OR EXISTS (
            SELECT 1 FROM clip c
            WHERE c.iy = CAST(floor((k.lat - {south}) / {MASK_RES}) AS INTEGER)
              AND CAST(floor((k.lon - {west}) / {MASK_RES}) AS INTEGER) BETWEEN c.ix0 AND c.ix1))
    """)
    n_unique = con.execute("SELECT count(*) FROM rows").fetchone()[0]
    years = [r[0] for r in con.execute("SELECT DISTINCT year(acq_date) FROM kept ORDER BY 1").fetchall()]
    detections_dir().mkdir(parents=True, exist_ok=True)
    total = 0
    for year in years:
        dest = detections_dir() / f"{stream.key}_{year}.parquet"
        tmp = dest.with_suffix(".tmp")
        con.execute(f"""
            COPY (SELECT * FROM kept WHERE year(acq_date) = {year} ORDER BY acq_utc, lat, lon)
            TO {quote(str(tmp))} (FORMAT parquet, COMPRESSION zstd)
        """)
        tmp.replace(dest)
        n = con.execute(f"SELECT count(*) FROM kept WHERE year(acq_date) = {year}").fetchone()[0]
        log.info("normalised %-13s %d  %9d rows", stream.key, year, n)
        total += n
    log.info("%s: %d rows read, %d exact duplicates, %d dropped as overlapping sources or outside Indonesia, %d kept",
             stream.key, n_raw, n_raw - n_unique, n_unique - total, total)
    con.execute("DROP TABLE rows; DROP TABLE kept")
    return total


def build_static_mask(con: duckdb.DuckDBPyConnection) -> int:
    """Writes the static-source mask from every typed detection; returns its cell count."""
    path = static_mask_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"""
        COPY (
            SELECT CAST(floor(lon / {MASK_RES}) AS INTEGER) AS mx, CAST(floor(lat / {MASK_RES}) AS INTEGER) AS my
            FROM read_parquet({quote(detections_glob())})
            WHERE type IS NOT NULL
            GROUP BY ALL
            HAVING count(*) FILTER (WHERE type IN (1, 2, 3)) >= {MASK_MIN_STATIC}
               AND count(*) FILTER (WHERE type IN (1, 2, 3)) >= {MASK_MIN_SHARE} * count(*)
        ) TO {quote(str(path))} (FORMAT parquet)
    """)
    return con.execute(f"SELECT count(*) FROM read_parquet({quote(str(path))})").fetchone()[0]


def run() -> None:
    """Normalises every product and year found in `data/raw`, then builds the static mask."""
    con = duckdb.connect()
    _load_clip(con)
    total = 0
    for old in detections_dir().glob("*.parquet") if detections_dir().is_dir() else []:
        old.unlink()
    for stream in config.STREAMS.values():
        total += normalise_stream(con, stream)
    log.info("normalised %d detections; static-source mask has %d cells", total, build_static_mask(con))
