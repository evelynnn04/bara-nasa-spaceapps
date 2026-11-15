export type Level = "country" | "province" | "regency";
export type LngLat = [number, number];
/** [west, south, east, north] in degrees. */
export type BBox = [number, number, number, number];

export interface Region {
  id: string;
  name: string;
  level: Level;
  parentId: string | null;
  bbox: BBox;
}

export type SelectionMode = "area" | "polygon";

export interface Filters {
  mode: SelectionMode;
  regionIds: string[];
  polygon: LngLat[] | null;
  start: string;
  end: string;
}

/** Which detections count: all, daytime only or night-time only. */
export type DayNight = "all" | "day" | "night";
