"""Hindcast of the fire spread simulation on held-out fire events.

Run `python -m app validate-spread` after the cache is built. It reproduces the evaluation tables of
`docs/fire-spread.md`.

For every complete VIIRS-era year, the model is counted on the other years only (reach shares and
cell histories), and fire events of the held-out year are replayed from their first cell on their
first day. On days 1, 3, 7 and 14 the chance given to each land cell within `spread.WINDOW` cells
is compared with the cells the event actually reached.

Compared with two baselines counted on the same training years:

- `stays put`: the fire never leaves its first cell;
- `distance only`: each cell gets the share of training events that reached a cell at its offset
  from the first cell by that day (the typical footprint shape, ignoring month and cell history).

Scores: Brier score over the window cells (lower is better) and its skill against each baseline,
the area under the ROC curve of the cells reached besides the first (how well the chances rank the
cells that burned), and the mean expected against observed footprint in cells. Events are sampled
at random, and separately among large events (`spread.is_large`); the large-fire scenario is meant
for the second sample.
"""

from __future__ import annotations

import logging
import random
from collections import defaultdict
from statistics import mean

from . import spread, store
from .harmonise import weights

log = logging.getLogger("app.spread_validation")

CHECK_DAYS = (1, 3, 7, 14)
SAMPLE_ALL = 150
SAMPLE_LARGE = 150
SEED = 5
MODELS = ("stays put", "distance only", "model", "model, large-fire scenario")


def reached_by(e: dict, k: int) -> set:
    return {c for c, day in e["reached"].items() if day <= k}


def shape(train_events: list[dict], sample: int = spread.TRAIN_EVENTS, seed: int = spread.SEED) -> dict:
    """Share of training events reaching each offset from their first cell by each checked day."""
    rng = random.Random(seed)
    evts = train_events if len(train_events) <= sample else rng.sample(train_events, sample)
    out = {}
    for k in CHECK_DAYS:
        n: dict = defaultdict(int)
        for e in evts:
            fx, fy = e["first"]
            for c in reached_by(e, k):
                dx, dy = c[0] - fx, c[1] - fy
                if max(abs(dx), abs(dy)) <= spread.WINDOW:
                    n[(dx, dy)] += 1
        out[k] = {o: v / len(evts) for o, v in n.items()}
    return out


def auc(scores: list[tuple[float, bool]]) -> float | None:
    """Area under the ROC curve (Mann-Whitney, ties counted half)."""
    pos = sum(1 for _, y in scores if y)
    neg = len(scores) - pos
    if not pos or not neg:
        return None
    ranked = sorted(scores, key=lambda s: s[0])
    rank_sum, i = 0.0, 0
    while i < len(ranked):
        j = i
        while j < len(ranked) and ranked[j][0] == ranked[i][0]:
            j += 1
        rank_sum += (i + j + 1) / 2 * sum(1 for s in ranked[i:j] if s[1])
        i = j
    return (rank_sum - pos * (pos + 1) / 2) / (pos * neg)


def sample(evts: list[dict], rng: random.Random) -> list[tuple[str, dict]]:
    """(stratum, event) pairs: a random sample of all events and of large ones."""
    large = [e for e in evts if spread.is_large(e)]
    return ([("all", e) for e in rng.sample(evts, min(SAMPLE_ALL, len(evts)))]
            + [("large", e) for e in rng.sample(large, min(SAMPLE_LARGE, len(large)))])


def evaluate(con, hotspots: str = "vegetation") -> dict:
    """{(stratum, model, day): {"brier", "auc_pairs", "pred", "obs"}} over every held-out year."""
    years = spread.viirs_years(con)
    by_year = {y: spread.year_events(con, y, hotspots) for y in years}
    rng = random.Random(SEED)
    out: dict = defaultdict(lambda: defaultdict(list))
    horizon = max(CHECK_DAYS)
    for test in years:
        train = [y for y in years if y != test]
        model = spread.estimate(con, train, hotspots, by_year)
        typical = shape([e for y in train for e in by_year[y]])
        picked = sample(by_year[test], rng)
        log.info("held-out %d: %d events", test, len(picked))
        for stratum, e in picked:
            first = e["first"]
            ch = spread.chances(model, first, e["start"], horizon)
            ch_large = spread.chances(model, first, e["start"], horizon, "large")
            for k in CHECK_DAYS:
                truth = reached_by(e, k)
                window = list(ch)
                preds = {
                    "model": {c: ch[c][k - 1] for c in window},
                    "model, large-fire scenario": {c: ch_large[c][k - 1] for c in window},
                    "stays put": {c: float(c == first) for c in window},
                    "distance only": {c: 1.0 if c == first else typical[k].get((c[0] - first[0], c[1] - first[1]), 0.0)
                                      for c in window},
                }
                for name, p in preds.items():
                    acc = out[(stratum, name, k)]
                    acc["brier"].append(mean((p[c] - (c in truth)) ** 2 for c in window) if window else 0.0)
                    acc["auc_pairs"].extend((p[c], c in truth) for c in window if c != first)
                    acc["pred"].append(sum(p.values()))
                    acc["obs"].append(len([c for c in truth if c in p]))
    return out


def report(results: dict) -> None:
    """Prints the hindcast tables."""
    for stratum, label in (("all", "random events"), ("large", f"events reaching {spread.LARGE_CELLS}+ cells in {spread.LARGE_DAYS} days")):
        print(f"\n=== {label} ===")
        print(f"  {'model':26} {'day':>3} {'events':>6} {'Brier x1000':>11} {'vs stays put':>12} "
              f"{'vs distance':>11} {'AUC':>5} {'cells expected/observed':>24}")
        for k in CHECK_DAYS:
            base = {n: mean(results[(stratum, n, k)]["brier"]) for n in ("stays put", "distance only")}
            for name in MODELS:
                acc = results[(stratum, name, k)]
                b = mean(acc["brier"])
                a = auc(acc["auc_pairs"])
                print(f"  {name:26} {k:3} {len(acc['brier']):6} {1000 * b:11.3f} "
                      f"{100 * (1 - b / base['stays put']):+11.0f}% {100 * (1 - b / base['distance only']):+10.0f}% "
                      f"{'-' if a is None else f'{a:.2f}':>5} {mean(acc['pred']):11.1f} / {mean(acc['obs']):<10.1f}")


def run() -> None:
    """Runs the hindcast on the local record and prints it."""
    con = store.connect(weights.load_params())
    if not store.has(con, "celldays", "days", "cells"):
        raise SystemExit("The derived tables are missing. Run `python -m app all` first.")
    report(evaluate(con))
