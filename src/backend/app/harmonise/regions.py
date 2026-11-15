"""Island groups: the regions the VIIRS factors are fitted for."""

from __future__ import annotations

#: Island groups in display order. `Other` (cells far from any province) keeps its region effect at 0,
#: so its factor is the national one for the month, exp(mu + sigma_m).
GROUPS = ("Sumatra", "Kalimantan", "Java-Bali-NT", "Sulawesi-Maluku", "Papua", "Other")

#: Province name (as in the boundary file) -> island group.
PROVINCE_GROUP = {
    **{p: "Sumatra" for p in (
        "Aceh", "North Sumatra", "West Sumatra", "South Sumatra", "Riau", "Jambi", "Bengkulu", "Lampung",
        "Bangka-Belitung Islands", "Riau Islands")},
    **{p: "Kalimantan" for p in (
        "West Kalimantan", "Central Kalimantan", "South Kalimantan", "East Kalimantan", "North Kalimantan")},
    **{p: "Papua" for p in ("Papua", "West Papua")},
    **{p: "Java-Bali-NT" for p in (
        "Jakarta Special Capital Region", "West Java", "Central Java", "East Java", "Special Region of Yogyakarta",
        "Banten", "Bali", "West Nusa Tenggara", "East Nusa Tenggara")},
    **{p: "Sulawesi-Maluku" for p in (
        "North Sulawesi", "Central Sulawesi", "South Sulawesi", "Southeast Sulawesi", "West Sulawesi", "Gorontalo",
        "Maluku", "North Maluku")},
}

#: A cell whose centre is in no province takes the nearest province within this distance.
NEAREST_MAX_DEG = 0.3


def group_of(province_name: str | None) -> str:
    """Island group of a province, `Other` when unknown."""
    return PROVINCE_GROUP.get(province_name or "", "Other")
