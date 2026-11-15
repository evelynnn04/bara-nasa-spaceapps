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
    sub.add_parser("cache", help="region cache, fire events and the fire outlook (needs params.json from fit)")
    ev = sub.add_parser("anomaly-eval", help="leave-one-year-out alert rates of the anomaly labels")
    ev.add_argument("--unit", choices=("province", "regency", "grid"), default="province")
    ev.add_argument("--hotspots", choices=("vegetation", "all"), default="vegetation")
    every = sub.add_parser("all", help="download, normalise, build, fit, cache")
    every.add_argument("--no-api", action="store_true")
    sub.add_parser("validate-critical", help="check the critical-period definition on the full record")
    sub.add_parser("validate-outlook", help="score the fire outlook per cell on held-out years")
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
        from .pipeline import aggregate, events
        aggregate.run()
        events.run()
        from . import outlook, store
        from .harmonise import weights
        outlook.build(store.connect(weights.load_params()))
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
    logging.getLogger("app").info("done in %.0f s", time.time() - t0)
