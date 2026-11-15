"""Command line for the data pipeline: `python -m app <command>`."""

from __future__ import annotations

import argparse
import logging
import time


def main(argv: list[str] | None = None) -> None:
    """Parses the command and runs the matching pipeline stage."""
    parser = argparse.ArgumentParser(prog="python -m app", description="Fire data pipeline")
    sub = parser.add_subparsers(dest="cmd", required=True)
    dl = sub.add_parser("download", help="download FIRMS archive and API data into data/raw")
    dl.add_argument("--no-api", action="store_true", help="archive only (no FIRMS key needed)")
    sub.add_parser("normalise", help="raw CSV -> one Parquet file per product and year")
    sub.add_parser("build", help="cell-day table, day status and cell lookup")
    sub.add_parser("fit", help="fit the VIIRS factors, evaluate them and write params.json")
    sub.add_parser("cache", help="region cache, fire events, their attribution and the fire outlook (needs params.json from fit)")
    ctx = sub.add_parser("context", help="download the environmental context layers into data/context")
    ctx.add_argument("sources", nargs="*", choices=["hansen", "peat", "modis", "imerg", "climate"],
                     help="layers to fetch (default all; modis and imerg need EARTHDATA_TOKEN)")
    sub.add_parser("attribute", help="likely cause of every fire event from the context layers")
    ev = sub.add_parser("anomaly-eval", help="leave-one-year-out alert rates of the anomaly labels")
    ev.add_argument("--unit", choices=("province", "regency", "grid"), default="province")
    ev.add_argument("--hotspots", choices=("vegetation", "all"), default="vegetation")
    every = sub.add_parser("all", help="download, normalise, build, fit, cache")
    every.add_argument("--no-api", action="store_true")
    sub.add_parser("validate-critical", help="check the critical-period definition on the full record")
    sub.add_parser("validate-outlook", help="score the fire outlook per cell on held-out years")
    al = sub.add_parser("alerts", help="send the email alerts due now, or replay past days into the outbox")
    al.add_argument("--replay", metavar="FROM:TO", help="step the last data day over these dates (YYYY-MM-DD:YYYY-MM-DD)")
    al.add_argument("--regions", default="idn", help="regions of the imaginary subscriber in a replay, comma-separated")
    al.add_argument("--step", type=int, default=1, help="days between replayed dates")
    up = sub.add_parser("update", help="download recent data, rebuild the tables and swap them in if they pass")
    up.add_argument("--every", type=float, metavar="MINUTES", help="repeat every so many minutes")
    up.add_argument("--no-download", action="store_true", help="rebuild from the files on disk (no FIRMS key needed)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
                        datefmt="%H:%M:%S")
    t0 = time.time()
    if args.cmd in ("download", "all"):
        from .pipeline import download
        download.run(api=not args.no_api)
    if args.cmd in ("normalise", "all"):
        from .pipeline import normalise
        normalise.run()
    if args.cmd in ("build", "all"):
        from .pipeline import celldays, cells
        celldays.run()
        cells.run()
    if args.cmd in ("fit", "all"):
        from .harmonise import fit
        fit.run()
    if args.cmd in ("cache", "all"):
        from . import attribution
        from .pipeline import aggregate, events
        aggregate.run()
        events.run()
        from . import outlook, store
        from .harmonise import weights
        outlook.build(store.connect(weights.load_params()))
        if attribution.has_context():
            attribution.run()
    if args.cmd == "context":
        from . import context
        context.run(tuple(args.sources) or context.SOURCES)
    if args.cmd == "attribute":
        from . import attribution
        attribution.run()
    if args.cmd == "anomaly-eval":
        import json
        from . import anomaly, queries, store
        from .harmonise import weights
        con = store.connect(weights.load_params())
        print(json.dumps(anomaly.evaluate(con, queries.day_flags(con), args.unit, args.hotspots), indent=2))
    if args.cmd == "validate-critical":
        from . import critical_validation
        critical_validation.run()
    if args.cmd == "validate-outlook":
        from . import outlook_validation
        outlook_validation.run()
    if args.cmd == "alerts":
        from .alerts import detect
        if args.replay:
            import datetime as dt
            first, _, last = args.replay.partition(":")
            found = detect.replay(dt.date.fromisoformat(first), dt.date.fromisoformat(last),
                                  args.regions.split(","), args.step)
            for a in found:
                print(f"{a['day']}  {a['region']:<28} {a['month']}  {a['label']:<10} {a['activity']:>10.1f}  {a['email']}")
            print(f"{len(found)} alert(s) in {len({a['email'] for a in found})} email(s)")
        else:
            detect.run()
    if args.cmd == "update":
        from .pipeline import update
        update.run(args.every, fetch=not args.no_download)
    logging.getLogger("app").info("done in %.0f s", time.time() - t0)
