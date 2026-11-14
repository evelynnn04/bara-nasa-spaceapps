export type Sensor = "MODIS" | "VIIRS";
export type Confidence = "low" | "nominal" | "high";
export type Level = "country" | "province" | "regency";
export type LngLat = [number, number];
/** [west, south, east, north] in degrees. */
export type BBox = [number, number, number, number];

/** One fire detection, in the shape the merged MODIS and VIIRS dataset will deliver. */
export interface Hotspot {
  id: number;
  lon: number;
  lat: number;
  /** Acquisition date, YYYY-MM-DD (UTC). */
  date: string;
  sensor: Sensor;
  confidence: Confidence;
  /** Fire radiative power in megawatts. */
  frp: number;
  /** Finest administrative unit the detection falls in (a city or regency). */
  regionId: string;
}

export interface Region {
  id: string;
  name: string;
  level: Level;
  parentId: string | null;
  bbox: BBox;
}

export interface Dataset {
  hotspots: Hotspot[];
  regions: Region[];
  /** First and last day covered by the dataset, YYYY-MM-DD. */
  start: string;
  end: string;
}

export type SelectionMode = "area" | "polygon";

export interface Filters {
  mode: SelectionMode;
  regionIds: string[];
  polygon: LngLat[] | null;
  start: string;
  end: string;
}
