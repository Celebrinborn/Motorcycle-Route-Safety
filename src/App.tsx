import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Single-file Vite + React page
// - No external CSS
// - URL params only (?dep=YYYY-MM-DDTHH:MM&ret=YYYY-MM-DDTHH:MM)
// - Implemented (no signup): Open-Meteo forecast API
// - Not implemented (future, requires signup/key): WSDOT APIs, OpenRouteService

// -------------------- Types --------------------

type Journey = "there" | "back";
type CellState = "good" | "caution" | "fail" | "nodata";

type CellResult = {
  state: CellState;
  tooltip: string;
};

interface Waypoint {
  id: string;
  label: string;
  lat: number;
  lon: number;
}

interface Metric {
  id: string;
  title: string;
  description: string;
  importance: number;
}

interface WeatherHour {
  temperature_2m?: number;
  precipitation?: number;
  snowfall?: number;
  windgusts_10m?: number;
  visibility?: number;
}

// -------------------- Waypoints --------------------

const WAYPOINTS_THERE: Waypoint[] = [
  { id: "quincy", label: "Quincy", lat: 47.2343, lon: -119.8526 },
  { id: "vantage", label: "Vantage", lat: 46.9482, lon: -119.9911 },
  { id: "ellensburg", label: "Ellensburg", lat: 46.9965, lon: -120.5478 },
  { id: "snoqualmie", label: "Snoqualmie Pass", lat: 47.4223, lon: -121.4136 },
  { id: "northbend", label: "North Bend", lat: 47.4957, lon: -121.7868 },
  { id: "redmond", label: "Microsoft Commons", lat: 47.6445, lon: -122.132 },
];

// IMPORTANT: reverse() mutates; use slice() to avoid touching source.
const WAYPOINTS_BACK: Waypoint[] = WAYPOINTS_THERE.slice().reverse();

// Hardcoded segment durations (minutes) MVP only
// There: Quincy -> Vantage -> Ellensburg -> Pass -> North Bend -> Redmond
const SEGMENTS_THERE = [25, 55, 60, 20, 35];
// Back: reverse of above
const SEGMENTS_BACK = SEGMENTS_THERE.slice().reverse();

// -------------------- Metrics (ordered by importance) --------------------

const METRICS: Metric[] = [
  {
    id: "wsdot_pass",
    title: "Pass conditions (WSDOT) — NOT IMPLEMENTED",
    description:
      "Future: WSDOT MountainPassConditions REST GetMountainPassConditionsAsJson (requires AccessCode).",
    importance: 1,
  },
  {
    id: "cam_summit",
    title: "Webcam: Snoqualmie Summit — NOT IMPLEMENTED",
    description:
      "Placeholder for WSDOT camera at Snoqualmie Pass Summit. Used to visually confirm pavement, snow accumulation, visibility, and traffic conditions.",
    importance: 2,
  },
  {
    id: "cam_denny",
    title: "Webcam: Denny Creek (west-side ice trap) — NOT IMPLEMENTED",
    description:
      "Placeholder for WSDOT Denny Creek camera on the west approach to the pass. Riders check this shaded section for black ice risk during descent toward Seattle.",
    importance: 3,
  },
  {
    id: "cam_hyak",
    title: "Webcam: Hyak / East Summit — NOT IMPLEMENTED",
    description:
      "Placeholder for WSDOT Hyak camera ~2 miles east of Snoqualmie summit. Important for meltwater crossing the highway and overnight freeze risk.",
    importance: 4,
  },
  {
    id: "wsdot_alerts",
    title: "Incidents / closures (WSDOT) — NOT IMPLEMENTED",
    description: "Future: WSDOT HighwayAlerts REST GetAlertsAsJson (requires AccessCode).",
    importance: 5,
  },
  {
    id: "freezing",
    title: "Freezing risk (temp)",
    description: "Open-Meteo /v1/forecast hourly temperature_2m. Conservative ice proxy.",
    importance: 6,
  },
  {
    id: "precip",
    title: "Precipitation risk",
    description: "Open-Meteo /v1/forecast hourly precipitation + snowfall.",
    importance: 7,
  },
  {
    id: "wind",
    title: "Wind gust risk",
    description: "Open-Meteo /v1/forecast hourly windgusts_10m.",
    importance: 8,
  },
  {
    id: "light",
    title: "Light level (dawn/dusk/night)",
    description:
      "Local-only placeholder (no API). Phase 2 will use real dawn/dusk; MVP uses hour bands.",
    importance: 9,
  },
  {
    id: "visibility",
    title: "Visibility (forecast)",
    description: "Open-Meteo /v1/forecast hourly visibility (if available for the model).",
    importance: 10,
  },
  {
    id: "route",
    title: "Route / travel time — NOT IMPLEMENTED",
    description:
      "Future: OpenRouteService directions (driving-car) for geometry + ETA (may require API key).",
    importance: 11,
  },
].sort((a, b) => a.importance - b.importance);

// -------------------- Helpers --------------------

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatDatetimeLocal(d: Date) {
  // YYYY-MM-DDTHH:MM in local time
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function isWeekday(d: Date) {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

function nextWorkdayMorningAfter(now: Date, morningHour = 8) {
  // First weekday morning strictly after 'now'
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);

  const todayMorning = new Date(candidate);
  todayMorning.setHours(morningHour, 0, 0, 0);

  if (isWeekday(candidate) && candidate.getTime() < todayMorning.getTime()) {
    return todayMorning;
  }

  const d = new Date(candidate);
  do {
    d.setDate(d.getDate() + 1);
  } while (!isWeekday(d));
  d.setHours(morningHour, 0, 0, 0);
  return d;
}

function defaultDepRet() {
  const depDate = nextWorkdayMorningAfter(new Date(), 8);
  const retDate = new Date(depDate);
  retDate.setHours(17, 0, 0, 0);
  return { dep: formatDatetimeLocal(depDate), ret: formatDatetimeLocal(retDate) };
}

function getUrlParam(name: string) {
  return new URL(window.location.href).searchParams.get(name);
}

function setUrlParams(dep: string, ret: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("dep", dep);
  if (ret) {
    url.searchParams.set("ret", ret);
  } else {
    url.searchParams.delete("ret");
  }
  window.history.replaceState({}, "", url.toString());
}

function addMinutes(date: Date, mins: number) {
  return new Date(date.getTime() + mins * 60000);
}

function projectTimes(start: Date, segments: number[]) {
  const times: Date[] = [start];
  for (const m of segments) {
    times.push(addMinutes(times[times.length - 1], m));
  }
  return times;
}

function stateIcon(state: CellState) {
  switch (state) {
    case "good":
      return "✅";
    case "caution":
      return "⚠️";
    case "fail":
      return "❌";
    default:
      return "⬜";
  }
}

function fmt(n: number | undefined | null, digits = 0) {
  if (n == null || Number.isNaN(n)) return "n/a";
  return n.toFixed(digits);
}

function getLightState(date: Date): CellState {
  // Placeholder hour-of-day bands (local time)
  // Green: 06:00–17:59
  // Yellow: 05:00–05:59 or 18:00–18:59
  // Red: otherwise
  const hour = date.getHours();
  if (hour >= 6 && hour < 18) return "good";
  if ((hour >= 5 && hour < 6) || (hour >= 18 && hour < 19)) return "caution";
  return "fail";
}

function buildTooltipBase(args: { wp: Waypoint; at: Date; w?: WeatherHour | null }) {
  const { wp, at, w } = args;
  const time = at.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const lines = [
    `${wp.label}`,
    `Time: ${time}`,
    `Temp: ${w?.temperature_2m == null ? "n/a" : `${fmt(w.temperature_2m, 1)} °C`}`,
    `Precip: ${w?.precipitation == null ? "n/a" : `${fmt(w.precipitation, 1)} mm`}`,
    `Snow: ${w?.snowfall == null ? "n/a" : `${fmt(w.snowfall, 1)} cm`}`,
    `Gust: ${w?.windgusts_10m == null ? "n/a" : `${fmt(w.windgusts_10m, 0)} km/h`}`,
    `Vis: ${w?.visibility == null ? "n/a" : `${fmt(w.visibility, 0)} m`}`,
  ];

  return lines.join("\n");
}

function notImplementedCell(details: string): CellResult {
  return { state: "nodata", tooltip: `Not implemented yet: ${details}` };
}

function emptyCell(reason = "No data"): CellResult {
  return { state: "nodata", tooltip: reason };
}

function startOfLocalDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function makePresetDate(base: Date, hour: number) {
  const d = new Date(base);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function presetLabel(d: Date) {
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "numeric",
    day: "numeric",
  });
}

function getPresetOptions(now: Date) {
  const options: Array<{ key: string; label: string; dep: string; ret: string }> = [];

  const today = startOfLocalDay(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  options.push({
    key: "today",
    label: `Today (${presetLabel(today)})`,
    dep: formatDatetimeLocal(makePresetDate(today, 8)),
    ret: formatDatetimeLocal(makePresetDate(today, 17)),
  });
  options.push({
    key: "tomorrow",
    label: `Tomorrow (${presetLabel(tomorrow)})`,
    dep: formatDatetimeLocal(makePresetDate(tomorrow, 8)),
    ret: formatDatetimeLocal(makePresetDate(tomorrow, 17)),
  });

  const days: Date[] = [];
  for (let offset = 0; offset < 14; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    if (isWeekday(d)) days.push(d);
  }

  const thisWeek = days.filter((d) => {
    const diff = Math.floor((startOfLocalDay(d).getTime() - today.getTime()) / 86400000);
    return diff >= 0 && diff <= 6;
  });
  const nextWeek = days.filter((d) => {
    const diff = Math.floor((startOfLocalDay(d).getTime() - today.getTime()) / 86400000);
    return diff >= 7 && diff <= 13;
  });

  for (const d of thisWeek) {
    options.push({
      key: `this-${formatDatetimeLocal(d).slice(0, 10)}`,
      label: `This week: ${presetLabel(d)}`,
      dep: formatDatetimeLocal(makePresetDate(d, 8)),
      ret: formatDatetimeLocal(makePresetDate(d, 17)),
    });
  }

  for (const d of nextWeek) {
    options.push({
      key: `next-${formatDatetimeLocal(d).slice(0, 10)}`,
      label: `Next week: ${presetLabel(d)}`,
      dep: formatDatetimeLocal(makePresetDate(d, 8)),
      ret: formatDatetimeLocal(makePresetDate(d, 17)),
    });
  }

  return options;
}

// -------------------- Open-Meteo fetching --------------------

// Keyed by waypoint id; maps ISO hour string to weather hour data
type WeatherCache = Record<string, Record<string, WeatherHour>>;

const OPEN_METEO_VARS = [
  "temperature_2m",
  "precipitation",
  "snowfall",
  "windgusts_10m",
  "visibility",
].join(",");

async function fetchWeatherForWaypoint(wp: Waypoint): Promise<Record<string, WeatherHour>> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${wp.lat}&longitude=${wp.lon}` +
    `&hourly=${OPEN_METEO_VARS}` +
    `&forecast_days=16` +
    `&timezone=America%2FLos_Angeles`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status} for ${wp.label}`);
  const json = await res.json();

  const hourly = json.hourly as Record<string, unknown[]>;
  const times: string[] = (hourly.time as string[]) ?? [];
  const result: Record<string, WeatherHour> = {};

  const nums = hourly as Record<string, (number | null)[]>;

  times.forEach((isoHour, i) => {
    result[isoHour] = {
      temperature_2m: nums.temperature_2m?.[i] ?? undefined,
      precipitation: nums.precipitation?.[i] ?? undefined,
      snowfall: nums.snowfall?.[i] ?? undefined,
      windgusts_10m: nums.windgusts_10m?.[i] ?? undefined,
      visibility: nums.visibility?.[i] ?? undefined,
    };
  });

  return result;
}

// Round a Date down to the nearest hour to match Open-Meteo keys (YYYY-MM-DDTHH:00)
function toHourKey(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  return `${yyyy}-${mm}-${dd}T${hh}:00`;
}

function lookupWeather(cache: WeatherCache, wpId: string, at: Date): WeatherHour | null {
  const byHour = cache[wpId];
  if (!byHour) return null;
  return byHour[toHourKey(at)] ?? null;
}

// -------------------- Per-metric cell builders --------------------

function buildFreezingCell(args: { wp: Waypoint; at: Date; w: WeatherHour | null }): CellResult {
  const { wp, at, w } = args;
  const base = buildTooltipBase({ wp, at, w });
  if (w?.temperature_2m == null) return { state: "nodata", tooltip: `${base}\n\nNo temp data.` };
  const t = w.temperature_2m;
  let state: CellState;
  if (t > 5) state = "good";
  else if (t > 2) state = "caution";
  else state = "fail";
  return { state, tooltip: `${base}\n\nTemp ${fmt(t, 1)} °C -> ${state}` };
}

function buildPrecipCell(args: { wp: Waypoint; at: Date; w: WeatherHour | null }): CellResult {
  const { wp, at, w } = args;
  const base = buildTooltipBase({ wp, at, w });
  const precip = w?.precipitation ?? 0;
  const snow = w?.snowfall ?? 0;
  if (w?.precipitation == null && w?.snowfall == null)
    return { state: "nodata", tooltip: `${base}\n\nNo precip data.` };
  let state: CellState;
  if (snow > 0) state = "fail";
  else if (precip >= 5) state = "fail";
  else if (precip >= 1) state = "caution";
  else state = "good";
  return {
    state,
    tooltip: `${base}\n\nPrecip ${fmt(precip, 1)} mm, Snow ${fmt(snow, 1)} cm -> ${state}`,
  };
}

function buildWindCell(args: { wp: Waypoint; at: Date; w: WeatherHour | null }): CellResult {
  const { wp, at, w } = args;
  const base = buildTooltipBase({ wp, at, w });
  if (w?.windgusts_10m == null) return { state: "nodata", tooltip: `${base}\n\nNo wind data.` };
  const gust = w.windgusts_10m;
  let state: CellState;
  if (gust < 40) state = "good";
  else if (gust < 60) state = "caution";
  else state = "fail";
  return { state, tooltip: `${base}\n\nGust ${fmt(gust, 0)} km/h -> ${state}` };
}

function buildLightCell(args: { wp: Waypoint; at: Date }): CellResult {
  const { at } = args;
  const state = getLightState(at);
  const hour = at.getHours();
  const label = hour >= 6 && hour < 18 ? "Day" : hour >= 5 || hour < 19 ? "Dawn/Dusk" : "Night";
  return { state, tooltip: `Hour ${pad2(hour)}:00 -> ${label} (${state})` };
}

function buildVisibilityCell(args: {
  wp: Waypoint;
  at: Date;
  w: WeatherHour | null;
}): CellResult {
  const { wp, at, w } = args;
  const base = buildTooltipBase({ wp, at, w });
  if (w?.visibility == null) return { state: "nodata", tooltip: `${base}\n\nNo visibility data.` };
  const vis = w.visibility;
  let state: CellState;
  if (vis >= 5000) state = "good";
  else if (vis >= 1000) state = "caution";
  else state = "fail";
  return { state, tooltip: `${base}\n\nVisibility ${fmt(vis, 0)} m -> ${state}` };
}

function buildMetricCell(args: {
  metricId: string;
  wp: Waypoint;
  at: Date;
  w: WeatherHour | null;
}): CellResult {
  const { metricId, wp, at, w } = args;
  switch (metricId) {
    case "wsdot_pass":
      return notImplementedCell("WSDOT MountainPassConditions");
    case "cam_summit":
      return notImplementedCell("WSDOT webcam: Snoqualmie Summit");
    case "cam_denny":
      return notImplementedCell("WSDOT webcam: Denny Creek");
    case "cam_hyak":
      return notImplementedCell("WSDOT webcam: Hyak/East Summit");
    case "wsdot_alerts":
      return notImplementedCell("WSDOT HighwayAlerts");
    case "freezing":
      return buildFreezingCell({ wp, at, w });
    case "precip":
      return buildPrecipCell({ wp, at, w });
    case "wind":
      return buildWindCell({ wp, at, w });
    case "light":
      return buildLightCell({ wp, at });
    case "visibility":
      return buildVisibilityCell({ wp, at, w });
    case "route":
      return notImplementedCell("OpenRouteService ETA");
    default:
      return emptyCell(`Unknown metric: ${metricId}`);
  }
}

// -------------------- Styles (inline) --------------------

const CSS: Record<string, React.CSSProperties> = {
  root: {
    fontFamily: "system-ui, sans-serif",
    maxWidth: 1200,
    margin: "0 auto",
    padding: "12px 16px",
    background: "#f8f9fa",
    minHeight: "100vh",
  },
  h1: { fontSize: "1.4rem", margin: "0 0 12px" },
  controlRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
    marginBottom: 12,
  },
  label: { fontWeight: 600, marginRight: 4, whiteSpace: "nowrap" },
  input: { padding: "4px 6px", fontSize: "0.9rem", borderRadius: 4, border: "1px solid #ccc" },
  select: { padding: "4px 6px", fontSize: "0.9rem", borderRadius: 4, border: "1px solid #ccc" },
  btn: {
    padding: "5px 12px",
    fontSize: "0.9rem",
    borderRadius: 4,
    border: "none",
    background: "#0d6efd",
    color: "#fff",
    cursor: "pointer",
  },
  sectionTitle: { fontWeight: 700, fontSize: "1rem", margin: "16px 0 4px" },
  tableWrap: { overflowX: "auto", marginBottom: 16 },
  table: { borderCollapse: "collapse", fontSize: "0.82rem", width: "100%" },
  th: {
    padding: "4px 6px",
    background: "#dee2e6",
    border: "1px solid #adb5bd",
    whiteSpace: "nowrap",
    textAlign: "left",
  },
  tdMetric: {
    padding: "4px 6px",
    border: "1px solid #dee2e6",
    whiteSpace: "nowrap",
    maxWidth: 240,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  tdCell: { padding: "4px 6px", border: "1px solid #dee2e6", textAlign: "center", cursor: "help" },
  statusBanner: {
    padding: "6px 10px",
    borderRadius: 4,
    marginBottom: 12,
    fontSize: "0.85rem",
  },
  legend: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12, fontSize: "0.82rem" },
};

function cellBg(state: CellState) {
  switch (state) {
    case "good":
      return "#d1e7dd";
    case "caution":
      return "#fff3cd";
    case "fail":
      return "#f8d7da";
    default:
      return "#e9ecef";
  }
}

// -------------------- Main Component --------------------

export default function App() {
  const defaults = useMemo(() => defaultDepRet(), []);
  const presetOptions = useMemo(() => getPresetOptions(new Date()), []);

  const [dep, setDep] = useState(getUrlParam("dep") || defaults.dep);
  const [ret, setRet] = useState(getUrlParam("ret") || defaults.ret);

  // Grid results: journey -> metricId -> waypointId -> CellResult
  const [results, setResults] = useState<
    Record<Journey, Record<string, Record<string, CellResult>>>
  >({ there: {}, back: {} });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<string | null>(null);

  // Cache weather data keyed by waypoint id
  const weatherCache = useRef<WeatherCache>({});

  const depDate = useMemo(() => new Date(dep), [dep]);
  const retDate = useMemo(() => new Date(ret), [ret]);

  const thereWaypoints = WAYPOINTS_THERE;
  const backWaypoints = WAYPOINTS_BACK;

  const thereTimes = useMemo(() => projectTimes(depDate, SEGMENTS_THERE), [depDate]);
  const backTimes = useMemo(() => projectTimes(retDate, SEGMENTS_BACK), [retDate]);

  const buildGrid = useCallback(
    (cache: WeatherCache) => {
      const grid: Record<Journey, Record<string, Record<string, CellResult>>> = {
        there: {},
        back: {},
      };

      for (const metric of METRICS) {
        grid.there[metric.id] = {};
        grid.back[metric.id] = {};

        thereWaypoints.forEach((wp, i) => {
          const at = thereTimes[i];
          const w = lookupWeather(cache, wp.id, at);
          grid.there[metric.id][wp.id] = buildMetricCell({ metricId: metric.id, wp, at, w });
        });

        backWaypoints.forEach((wp, i) => {
          const at = backTimes[i];
          const w = lookupWeather(cache, wp.id, at);
          grid.back[metric.id][wp.id] = buildMetricCell({ metricId: metric.id, wp, at, w });
        });
      }

      return grid;
    },
    [thereWaypoints, backWaypoints, thereTimes, backTimes],
  );

  const fetchAndBuild = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch for all unique waypoints (there and back share the same set)
      const allWaypoints = WAYPOINTS_THERE;
      await Promise.all(
        allWaypoints.map(async (wp) => {
          const data = await fetchWeatherForWaypoint(wp);
          weatherCache.current[wp.id] = data;
        }),
      );

      const grid = buildGrid(weatherCache.current);
      setResults(grid);
      setLastFetched(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [buildGrid]);

  // Auto-fetch on mount
  useEffect(() => {
    fetchAndBuild();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Rebuild grid (no re-fetch) when times change
  useEffect(() => {
    if (Object.keys(weatherCache.current).length === 0) return;
    setResults(buildGrid(weatherCache.current));
  }, [buildGrid]);

  function handleDepChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setDep(v);
    setUrlParams(v, ret);
  }

  function handleRetChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setRet(v);
    setUrlParams(dep, v);
  }

  function handlePreset(e: React.ChangeEvent<HTMLSelectElement>) {
    const opt = presetOptions.find((o) => o.key === e.target.value);
    if (!opt) return;
    setDep(opt.dep);
    setRet(opt.ret);
    setUrlParams(opt.dep, opt.ret);
  }

  function renderGrid(journey: Journey, waypoints: Waypoint[], times: Date[]) {
    const journeyResults = results[journey];

    return (
      <div style={CSS.tableWrap}>
        <table style={CSS.table}>
          <thead>
            <tr>
              <th style={CSS.th}>Metric</th>
              {waypoints.map((wp, i) => (
                <th key={wp.id} style={CSS.th}>
                  {wp.label}
                  <br />
                  <span style={{ fontWeight: 400, fontSize: "0.75rem" }}>
                    {times[i]?.toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRICS.map((metric) => {
              const row = journeyResults[metric.id];
              return (
                <tr key={metric.id}>
                  <td style={CSS.tdMetric} title={metric.description}>
                    {metric.title}
                  </td>
                  {waypoints.map((wp) => {
                    const cell = row?.[wp.id];
                    if (!cell) return <td key={wp.id} style={CSS.tdCell}>⬜</td>;
                    return (
                      <td
                        key={wp.id}
                        style={{ ...CSS.tdCell, background: cellBg(cell.state) }}
                        title={cell.tooltip}
                      >
                        {stateIcon(cell.state)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={CSS.root}>
      <h1 style={CSS.h1}>🏍️ Motorcycle Route Safety — Quincy ↔ Redmond</h1>

      {/* Controls */}
      <div style={CSS.controlRow}>
        <label style={CSS.label}>Preset:</label>
        <select style={CSS.select} value="" onChange={handlePreset}>
          <option value="">— choose —</option>
          {presetOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>

        <label style={CSS.label}>Departure:</label>
        <input
          type="datetime-local"
          style={CSS.input}
          value={dep}
          onChange={handleDepChange}
        />

        <label style={CSS.label}>Return:</label>
        <input
          type="datetime-local"
          style={CSS.input}
          value={ret}
          onChange={handleRetChange}
        />

        <button style={CSS.btn} onClick={fetchAndBuild} disabled={loading}>
          {loading ? "Loading…" : "Refresh weather"}
        </button>
      </div>

      {/* Status */}
      {error && (
        <div style={{ ...CSS.statusBanner, background: "#f8d7da", color: "#842029" }}>
          ⚠️ {error}
        </div>
      )}
      {lastFetched && !error && (
        <div style={{ ...CSS.statusBanner, background: "#d1e7dd", color: "#0a3622" }}>
          ✅ Weather fetched at {lastFetched}
        </div>
      )}

      {/* Legend */}
      <div style={CSS.legend}>
        <span>✅ Good</span>
        <span>⚠️ Caution</span>
        <span>❌ Fail</span>
        <span>⬜ No data / Not implemented</span>
      </div>

      {/* There grid */}
      <div style={CSS.sectionTitle}>🡆 There (Departure: {dep})</div>
      {renderGrid("there", thereWaypoints, thereTimes)}

      {/* Back grid */}
      <div style={CSS.sectionTitle}>🡄 Back (Return: {ret})</div>
      {renderGrid("back", backWaypoints, backTimes)}

      {/* Notes */}
      <details style={{ marginTop: 16, fontSize: "0.8rem", color: "#555" }}>
        <summary>Notes &amp; limitations</summary>
        <ul>
          <li>Weather from Open-Meteo (open-source forecast, no API key needed).</li>
          <li>Travel times are hardcoded estimates (MVP).</li>
          <li>Light-level bands are hour-of-day proxies, not real sunrise/sunset.</li>
          <li>WSDOT pass conditions, webcams, and alerts require an AccessCode (not implemented).</li>
          <li>Route ETA via OpenRouteService is not yet implemented.</li>
        </ul>
      </details>
    </div>
  );
}
