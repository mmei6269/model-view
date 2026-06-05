import type { PointSoundingIndices, PointSoundingLevel, PointSoundingPayload } from "../types";
import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { formatValidUtcLabel } from "../core/time";
import { formatCoordinate } from "./map-panel/format-utils";

interface SoundingDrawerProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  sounding: PointSoundingPayload | null;
  point: { lat: number; lon: number } | null;
  forecastHour: number | null;
  validLabel: string;
  onRequestPoint: (lat: number, lon: number) => void;
  onClose: () => void;
}

const PLOT = Object.freeze({ left: 60, top: 26, width: 610, height: 610 });
const SKEWT_VIEWBOX_WIDTH = 820;
const SKEWT_VIEWBOX_HEIGHT = 700;
const WIND_BARB_X = PLOT.left + PLOT.width + 60;
const PRESSURE_MAX = 1050;
const PRESSURE_MIN = 100;
const TEMP_MIN = -64;
const TEMP_MAX = 60;
const SKEW_C = 44;
const LOW_LEVEL_WIND_BARB_AGL_LEVELS_M = [0, 500, 1000, 1500, 2000, 2500, 3000] as const;
const PRESSURE_TICKS = [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100];
const TEMP_TICKS = [-70, -60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50];
const HEIGHT_MARKS_M = [0, 1000, 3000, 6000, 9000, 12000, 15000];
const HODO_HEIGHT_MARKS_M = [1000, 3000, 6000, 9000];

export default function SoundingDrawer({
  open,
  loading,
  error,
  sounding,
  point,
  forecastHour,
  validLabel: frameValidLabel,
  onRequestPoint,
  onClose,
}: SoundingDrawerProps) {
  if (!open) {
    return null;
  }
  const levelCount = sounding?.levels?.length || 0;
  const title = sounding ? `${sounding.modelLabel || sounding.model} Point Sounding` : "Point Sounding";
  const validLabel = sounding?.validTime ? formatValidUtcLabel(sounding.validTime) : frameValidLabel;
  const displayForecastHour = sounding?.forecastHour ?? forecastHour ?? 0;
  const requestLat = Number.isFinite(sounding?.lat) ? Number(sounding?.lat) : Number(point?.lat);
  const requestLon = Number.isFinite(sounding?.lon) ? Number(sounding?.lon) : Number(point?.lon);
  return (
    <aside
      className="pointer-events-auto absolute right-3 z-[700] flex w-[min(1240px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-lg border border-sky-300/20 bg-[#02060d]/96 shadow-2xl backdrop-blur-xl"
      style={{
        top: "calc(var(--chrome-top, 96px) + 12px)",
        bottom: "calc(var(--chrome-bottom, 72px) + 12px)",
      }}
    >
      <header className="flex items-start justify-between gap-3 border-b border-sky-200/10 px-4 py-3">
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold text-slate-50">{title}</h2>
          <PointCoordinateForm
            lat={requestLat}
            lon={requestLon}
            loading={loading}
            forecastHour={displayForecastHour}
            validLabel={validLabel}
            onRequestPoint={onRequestPoint}
          />
          {sounding?.sampleLat && sounding?.sampleLon ? (
            <p className="m-0 mt-1 font-mono text-[10px] text-slate-500">
              sampled {formatCoordinate(sounding.sampleLat, "N", "S")} {formatCoordinate(sounding.sampleLon, "E", "W")}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Close sounding"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-white/10 bg-white/5 text-sm text-slate-300 hover:bg-white/10 hover:text-white"
          onClick={onClose}
        >
          x
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {loading ? (
          <div className="grid h-full min-h-[420px] place-items-center text-sm text-slate-300">
            Building point profile...
          </div>
        ) : error ? (
          <div className="rounded-lg border border-rose-400/25 bg-rose-950/40 px-3 py-2 text-sm text-rose-100">
            {error}
          </div>
        ) : sounding && levelCount > 0 ? (
          <div className="grid min-h-0 gap-3 xl:grid-cols-[660px_minmax(360px,1fr)]">
            <section className="min-w-0">
              <SkewTChart sounding={sounding} />
              <OperationalTables sounding={sounding} />
              <LevelTable levels={sounding.levels} />
            </section>
            <section className="grid content-start gap-3">
              <Hodograph sounding={sounding} />
              <HazardPanel indices={sounding.indices || {}} />
              <StormMotionPanel sounding={sounding} />
              <EffectiveLayerPanel indices={sounding.indices || {}} />
              <TechnicalSourcePanel sounding={sounding} />
              {sounding.warnings?.length ? (
                <div className="rounded-lg border border-amber-300/20 bg-amber-950/25 px-3 py-2 text-[11px] leading-5 text-amber-100">
                  {sounding.warnings.join(" ")}
                </div>
              ) : null}
            </section>
          </div>
        ) : (
          <div className="grid h-full min-h-[420px] place-items-center text-sm text-slate-400">
            No sounding profile is available for this point.
          </div>
        )}
      </div>
    </aside>
  );
}

function PointCoordinateForm({
  lat,
  lon,
  loading,
  forecastHour,
  validLabel,
  onRequestPoint,
}: {
  lat: number;
  lon: number;
  loading: boolean;
  forecastHour?: number;
  validLabel: string;
  onRequestPoint: (lat: number, lon: number) => void;
}) {
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lon);
  const [latText, setLatText] = useState(() => (hasPoint ? formatSignedCoordinate(lat) : ""));
  const [lonText, setLonText] = useState(() => (hasPoint ? formatSignedCoordinate(lon) : ""));
  const [inputError, setInputError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasPoint) {
      return;
    }
    setLatText(formatSignedCoordinate(lat));
    setLonText(formatSignedCoordinate(lon));
    setInputError(null);
  }, [hasPoint, lat, lon]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedLat = parseCoordinateInput(latText, "lat");
    const parsedLon = parseCoordinateInput(lonText, "lon");
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon)) {
      setInputError("Enter valid lat/lon.");
      return;
    }
    setInputError(null);
    onRequestPoint(parsedLat, parsedLon);
  };

  if (!hasPoint) {
    return <p className="m-0 mt-1 font-mono text-[11px] text-slate-400">Double-click a valid map point</p>;
  }

  return (
    <form
      aria-busy={loading}
      className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-slate-400"
      onSubmit={handleSubmit}
    >
      <label className="flex items-center gap-1">
        <span className="text-[10px] uppercase text-slate-500">Lat</span>
        <input
          aria-label="Sounding latitude"
          className="h-6 w-20 rounded border border-white/10 bg-white/[0.04] px-2 text-slate-100 outline-none focus:border-cyan-300/60"
          inputMode="decimal"
          spellCheck={false}
          value={latText}
          onChange={(event) => setLatText(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-1">
        <span className="text-[10px] uppercase text-slate-500">Lon</span>
        <input
          aria-label="Sounding longitude"
          className="h-6 w-20 rounded border border-white/10 bg-white/[0.04] px-2 text-slate-100 outline-none focus:border-cyan-300/60"
          inputMode="decimal"
          spellCheck={false}
          value={lonText}
          onChange={(event) => setLonText(event.target.value)}
        />
      </label>
      <button
        type="submit"
        className="h-6 rounded border border-cyan-300/20 bg-cyan-300/10 px-2 text-[10px] font-semibold text-cyan-100 hover:bg-cyan-300/20"
      >
        Go
      </button>
      <span className="text-slate-600">|</span>
      <span>F{String(forecastHour ?? 0).padStart(3, "0")}</span>
      <span className="text-slate-600">|</span>
      <span>{validLabel}</span>
      {inputError ? <span className="basis-full text-[10px] text-rose-300">{inputError}</span> : null}
    </form>
  );
}

function SkewTChart({ sounding }: { sounding: PointSoundingPayload }) {
  const levels = normalizedLevels(sounding.levels);
  const tempPath = pathForLevels(levels, "temp");
  const dewpointPath = pathForLevels(levels, "dwpt");
  const parcelTracePath = pathForParcelTrace(sounding.parcelTrace?.levels || []);
  const parcelLabel = sounding.parcelTrace?.label || "Parcel";
  const windBarbs = windBarbLevels(levels);
  const dryTheta = [280, 300, 320, 340, 360, 380, 400, 420];
  const mixingRatios = [1, 2, 4, 7, 10, 16, 24];
  const indices = sounding.indices || {};
  const parcelMarkers = sounding.parcelTrace || null;
  const surfaceHeightMsl = Number(levels.find((level) => level.source === "surface")?.hght ?? levels[0]?.hght);
  const criticalTempAgl = (heightMsl: number | null | undefined) =>
    Number.isFinite(heightMsl)
      ? Number(heightMsl) - (Number.isFinite(surfaceHeightMsl) ? surfaceHeightMsl : 0)
      : Number.NaN;
  const heightMarkers = HEIGHT_MARKS_M.map((heightM) => ({ heightM, y: yForAglHeight(levels, heightM) })).filter(
    (mark) => Number.isFinite(mark.y),
  );
  const markerRows = [
    { label: "LCL", value: parcelMarkers?.lclM ?? indices.lclM, color: "#facc15" },
    { label: "LFC", value: parcelMarkers?.lfcM ?? indices.lfcM, color: "#38bdf8" },
    { label: "EL", value: parcelMarkers?.elM ?? indices.elM, color: "#c084fc" },
    { label: "0C", value: criticalTempAgl(indices.temp0CHeightM ?? indices.freezingLevelM), color: "#60a5fa" },
    { label: "-20C", value: criticalTempAgl(indices.tempMinus20CHeightM), color: "#93c5fd" },
    { label: "-30C", value: criticalTempAgl(indices.tempMinus30CHeightM), color: "#bfdbfe" },
  ].filter((row) => Number.isFinite(row.value));
  const effectiveBaseY = yForAglHeight(levels, indices.effectiveBaseM);
  const effectiveTopY = yForAglHeight(levels, indices.effectiveTopM);

  return (
    <svg
      className="w-full rounded-lg bg-[#02060d]"
      style={{ aspectRatio: `${SKEWT_VIEWBOX_WIDTH} / ${SKEWT_VIEWBOX_HEIGHT}` }}
      viewBox={`0 0 ${SKEWT_VIEWBOX_WIDTH} ${SKEWT_VIEWBOX_HEIGHT}`}
      preserveAspectRatio="xMinYMin meet"
    >
      <defs>
        <clipPath id="sounding-plot-clip">
          <rect x={PLOT.left} y={PLOT.top} width={PLOT.width} height={PLOT.height} />
        </clipPath>
      </defs>

      <rect
        x={PLOT.left}
        y={PLOT.top}
        width={PLOT.width}
        height={PLOT.height}
        fill="#030910"
        stroke="rgba(125,211,252,0.28)"
      />

      {TEMP_TICKS.map((temp) => (
        <GridLine
          key={`iso-${temp}`}
          points={[pointForTempPressure(temp, PRESSURE_MAX), pointForTempPressure(temp, PRESSURE_MIN)]}
        />
      ))}
      {dryTheta.map((theta) => (
        <path
          key={`theta-${theta}`}
          d={dryAdiabatPath(theta)}
          clipPath="url(#sounding-plot-clip)"
          fill="none"
          stroke="rgba(244,190,99,0.18)"
          strokeWidth="1"
        />
      ))}
      {mixingRatios.map((ratio) => (
        <g key={`mix-${ratio}`}>
          <path
            d={mixingRatioPath(ratio)}
            clipPath="url(#sounding-plot-clip)"
            fill="none"
            stroke="rgba(34,197,94,0.22)"
            strokeWidth="1"
          />
          <text
            x={pointForTempPressure(saturationTempForMixingRatioC(ratio, 580), 580).x}
            y={yForPressure(580) - 5}
            className="fill-emerald-500/70 text-[9px]"
          >
            {ratio}
          </text>
        </g>
      ))}
      {PRESSURE_TICKS.map((pressure) => (
        <g key={`p-${pressure}`}>
          <line
            x1={PLOT.left}
            x2={PLOT.left + PLOT.width}
            y1={yForPressure(pressure)}
            y2={yForPressure(pressure)}
            stroke={pressure === 500 || pressure === 850 ? "rgba(203,213,225,0.38)" : "rgba(148,163,184,0.18)"}
          />
          <text
            x={PLOT.left - 8}
            y={yForPressure(pressure) + 4}
            textAnchor="end"
            className="fill-slate-400 text-[11px]"
          >
            {pressure}
          </text>
        </g>
      ))}
      {heightMarkers.map((mark) => (
        <g key={`height-${mark.heightM}`}>
          <line
            x1={PLOT.left}
            x2={PLOT.left + PLOT.width}
            y1={mark.y}
            y2={mark.y}
            stroke="rgba(248,113,113,0.12)"
            strokeDasharray="3 5"
          />
          <text x={PLOT.left + 6} y={Number(mark.y) - 4} className="fill-rose-400 text-[11px] font-semibold">
            {mark.heightM === 0 ? "0 km" : `${Math.round(mark.heightM / 1000)} km`}
          </text>
        </g>
      ))}
      <GridLine
        points={[pointForTempPressure(0, PRESSURE_MAX), pointForTempPressure(0, PRESSURE_MIN)]}
        color="rgba(96,165,250,0.85)"
        width={1.5}
      />

      {markerRows.map((row) => {
        const y = yForAglHeight(levels, row.value);
        if (!Number.isFinite(y)) {
          return null;
        }
        return (
          <g key={row.label}>
            <line
              x1={PLOT.left}
              x2={PLOT.left + PLOT.width}
              y1={y}
              y2={y}
              stroke={row.color}
              strokeDasharray="6 5"
              strokeOpacity="0.62"
            />
            <text x={PLOT.left + PLOT.width - 8} y={Number(y) - 4} textAnchor="end" fill={row.color} fontSize="10">
              {row.label}
            </text>
          </g>
        );
      })}

      {Number.isFinite(effectiveBaseY) && Number.isFinite(effectiveTopY) ? (
        <g>
          <line
            x1={PLOT.left + PLOT.width + 18}
            x2={PLOT.left + PLOT.width + 18}
            y1={effectiveTopY}
            y2={effectiveBaseY}
            stroke="#22d3ee"
            strokeWidth="3"
          />
          <line
            x1={PLOT.left + PLOT.width + 10}
            x2={PLOT.left + PLOT.width + 26}
            y1={effectiveTopY}
            y2={effectiveTopY}
            stroke="#22d3ee"
          />
          <line
            x1={PLOT.left + PLOT.width + 10}
            x2={PLOT.left + PLOT.width + 26}
            y1={effectiveBaseY}
            y2={effectiveBaseY}
            stroke="#22d3ee"
          />
          <text
            x={PLOT.left + PLOT.width + 31}
            y={(Number(effectiveBaseY) + Number(effectiveTopY)) / 2}
            className="fill-cyan-300 text-[10px]"
          >
            EFF
          </text>
        </g>
      ) : null}

      <g clipPath="url(#sounding-plot-clip)">
        <path d={tempPath} fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path
          d={dewpointPath}
          fill="none"
          stroke="#22c55e"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {parcelTracePath ? (
          <path
            d={parcelTracePath}
            fill="none"
            stroke="#22d3ee"
            strokeWidth="2.4"
            strokeDasharray="8 5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </g>

      {windBarbs.map(({ level, y }) => (
        <WindBarb key={`barb-${level.source}-${level.press}-${level.hght}`} x={WIND_BARB_X} y={y} level={level} />
      ))}

      {TEMP_TICKS.filter((temp) => temp >= -50 && temp <= 50 && temp % 20 === 0).map((temp) => {
        const point = pointForTempPressure(temp, PRESSURE_MAX);
        return (
          <text
            key={`temp-label-${temp}`}
            x={point.x}
            y={PLOT.top + PLOT.height + 20}
            textAnchor="middle"
            className="fill-slate-500 text-[10px]"
          >
            {temp}
          </text>
        );
      })}
      <text x={PLOT.left} y={PLOT.top + PLOT.height + 40} className="fill-slate-400 text-[11px]">
        Temperature C
      </text>
      <text x={WIND_BARB_X} y={PLOT.top + PLOT.height + 40} textAnchor="middle" className="fill-slate-400 text-[11px]">
        Wind kt
      </text>
      <LegendChip x={PLOT.left + 8} y={PLOT.top + 18} color="#ef4444" label="T" />
      <LegendChip x={PLOT.left + 58} y={PLOT.top + 18} color="#22c55e" label="Td" />
      <LegendChip x={PLOT.left + 116} y={PLOT.top + 18} color="#60a5fa" label="0C Isotherm" />
      {parcelTracePath ? (
        <LegendChip x={PLOT.left + 252} y={PLOT.top + 18} color="#22d3ee" label={parcelLabel} dash="8 5" />
      ) : null}
    </svg>
  );
}

function Hodograph({ sounding }: { sounding: PointSoundingPayload }) {
  const levels = profileLevelsWithAgl(sounding.levels).filter(
    (level) => Number.isFinite(level.uKt) && Number.isFinite(level.vKt),
  );
  const indices = sounding.indices || {};
  const motions = [
    { label: "RM", dir: indices.bunkersRightDirDeg, speed: indices.bunkersRightKt, color: "#facc15" },
    { label: "LM", dir: indices.bunkersLeftDirDeg, speed: indices.bunkersLeftKt, color: "#c084fc" },
    { label: "MW", dir: indices.meanWind0to6kmDirDeg, speed: indices.meanWind0to6kmKt, color: "#38bdf8" },
    { label: "UP", dir: indices.corfidiUpshearDirDeg, speed: indices.corfidiUpshearKt, color: "#67e8f9" },
    { label: "DN", dir: indices.corfidiDownshearDirDeg, speed: indices.corfidiDownshearKt, color: "#fb923c" },
  ].filter((motion) => Number.isFinite(motion.dir) && Number.isFinite(motion.speed));
  const maxWind = Math.max(
    40,
    ...levels.map((level) => Math.hypot(Number(level.uKt), Number(level.vKt))),
    ...motions.map((motion) => Number(motion.speed)),
  );
  const ringMax = Math.ceil(maxWind / 20) * 20;
  const center = 160;
  const plotRadius = 132;
  const scale = plotRadius / ringMax;
  const rings = Array.from({ length: Math.max(2, Math.floor(ringMax / 20)) }, (_, index) => (index + 1) * 20);
  return (
    <div className="rounded-lg border border-white/10 bg-[#030910] p-3">
      <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
        <span className="font-semibold text-slate-100">Hodograph</span>
        <span className="font-mono text-[11px] text-slate-400">kt</span>
      </div>
      <svg viewBox="0 0 320 320" className="h-80 w-full">
        {rings.map((ring) => (
          <g key={ring}>
            <circle cx={center} cy={center} r={ring * scale} fill="none" stroke="rgba(148,163,184,0.18)" />
            <text x={center + 4 + ring * scale} y={center - 4} className="fill-slate-500 text-[9px]">
              {ring}
            </text>
          </g>
        ))}
        <line x1="18" x2="302" y1={center} y2={center} stroke="rgba(203,213,225,0.24)" />
        <line x1={center} x2={center} y1="18" y2="302" stroke="rgba(203,213,225,0.24)" />
        {levels.slice(1).map((level, index) => {
          const previous = levels[index];
          const midHeight = (Number(previous.heightAglM) + Number(level.heightAglM)) / 2;
          return (
            <line
              key={`hodo-segment-${index}`}
              x1={center + Number(previous.uKt) * scale}
              y1={center - Number(previous.vKt) * scale}
              x2={center + Number(level.uKt) * scale}
              y2={center - Number(level.vKt) * scale}
              stroke={hodographColorForHeight(midHeight)}
              strokeWidth="3"
              strokeLinecap="round"
            />
          );
        })}
        {HODO_HEIGHT_MARKS_M.map((heightM) => {
          const wind = interpolateWindAtAgl(levels, heightM);
          if (!wind) {
            return null;
          }
          return (
            <g key={`hodo-height-${heightM}`}>
              <circle cx={center + wind.uKt * scale} cy={center - wind.vKt * scale} r="3" fill="#e2e8f0" />
              <text
                x={center + 4 + wind.uKt * scale}
                y={center - 4 - wind.vKt * scale}
                className="fill-slate-200 text-[9px]"
              >
                {heightM / 1000}
              </text>
            </g>
          );
        })}
        {motions.map((motion) => {
          const vector = windVectorFromDirectionSpeed(Number(motion.dir), Number(motion.speed));
          const x = center + vector.uKt * scale;
          const y = center - vector.vKt * scale;
          return (
            <g key={`motion-${motion.label}`}>
              <line x1={x - 6} x2={x + 6} y1={y} y2={y} stroke={motion.color} strokeWidth="1.8" />
              <line x1={x} x2={x} y1={y - 6} y2={y + 6} stroke={motion.color} strokeWidth="1.8" />
              <circle cx={x} cy={y} r="2.6" fill={motion.color} />
              <text x={x + 7} y={y - 5} fill={motion.color} fontSize="10">
                {motion.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function OperationalTables({ sounding }: { sounding: PointSoundingPayload }) {
  const indices = sounding.indices || {};
  const parcelTrace = sounding.parcelTrace || null;
  const sfcTrace = parcelTrace?.type === "SFC" ? parcelTrace : null;
  const mlTrace = parcelTrace?.type === "ML" ? parcelTrace : null;
  const muTrace = parcelTrace?.type === "MU" ? parcelTrace : null;
  return (
    <div className="mt-3 grid gap-3 xl:grid-cols-2">
      <DenseTable
        title="Parcel"
        headers={["PCL", "CAPE", "CINH", "LCL", "LIv", "LFC", "EL"]}
        rows={[
          [
            "SFC",
            formatNumber(indices.sbcapeJkg, "", 0),
            formatNumber(indices.sbcinJkg ?? sfcTrace?.cinJkg, "", 0),
            formatMetersCompact(indices.lclM ?? sfcTrace?.lclM),
            formatNumber(indices.liftedIndexC ?? sfcTrace?.liftedIndexC, "", 1),
            formatMetersCompact(indices.lfcM ?? sfcTrace?.lfcM),
            formatMetersCompact(indices.elM ?? sfcTrace?.elM),
          ],
          [
            "ML",
            formatNumber(indices.mlcapeJkg, "", 0),
            formatNumber(indices.mlcinJkg ?? mlTrace?.cinJkg, "", 0),
            formatMetersCompact(indices.mixedLayerLclM ?? mlTrace?.lclM),
            formatNumber(indices.mixedLayerLiftedIndexC ?? mlTrace?.liftedIndexC, "", 1),
            formatMetersCompact(indices.mixedLayerLfcM ?? mlTrace?.lfcM),
            formatMetersCompact(indices.mixedLayerElM ?? mlTrace?.elM),
          ],
          [
            "MU",
            formatNumber(indices.mucapeJkg ?? muTrace?.capeJkg, "", 0),
            formatNumber(indices.mucinJkg ?? muTrace?.cinJkg, "", 0),
            formatMetersCompact(indices.mostUnstableLclM ?? muTrace?.lclM),
            formatNumber(indices.mostUnstableLiftedIndexC ?? muTrace?.liftedIndexC, "", 1),
            formatMetersCompact(indices.mostUnstableLfcM ?? muTrace?.lfcM),
            formatMetersCompact(indices.mostUnstableElM ?? muTrace?.elM),
          ],
          ["0-3", formatNumber(indices.cape0to3kmJkg, "", 0), "--", "--", "--", "--", "--"],
        ]}
      />
      <DenseTable
        title="Kinematics"
        headers={["Layer", "EHI", "SRH", "Shear", "Mean"]}
        rows={[
          [
            "SFC-1km",
            formatNumber(indices.ehi0to1km, "", 2),
            formatNumber(indices.srh0to1kmM2S2, "", 0),
            formatNumber(indices.shear0to1kmKt, "", 0),
            "--",
          ],
          [
            "SFC-3km",
            formatNumber(indices.ehi0to3km, "", 2),
            formatNumber(indices.srh0to3kmM2S2, "", 0),
            formatNumber(indices.shear0to3kmKt, "", 0),
            "--",
          ],
          [
            "SFC-6km",
            "--",
            "--",
            formatNumber(indices.shear0to6kmKt, "", 0),
            formatWind(indices.meanWind0to6kmDirDeg, indices.meanWind0to6kmKt),
          ],
          ["SFC-8km", "--", "--", formatNumber(indices.shear0to8kmKt, "", 0), "--"],
          ["SFC-500", "--", "--", formatNumber(indices.shearSurfaceTo500mbKt, "", 0), "--"],
          [
            "Eff",
            "--",
            formatNumber(indices.effectiveSrhM2S2, "", 0),
            formatNumber(indices.effectiveBulkShearKt, "", 0),
            formatLayerCompact(indices.effectiveBaseM, indices.effectiveTopM),
          ],
        ]}
      />
      <DenseTable
        title="Thermo"
        headers={["Param", "Value", "Param", "Value"]}
        rows={[
          ["PW", formatNumber(indices.pwatMm, " mm", 1), "K", formatNumber(indices.kIndexC, "", 1)],
          ["TT", formatNumber(indices.totalTotalsC, "", 1), "VT", formatNumber(indices.verticalTotalsC, "", 1)],
          ["CT", formatNumber(indices.crossTotalsC, "", 1), "Show", formatNumber(indices.showalterIndexC, "", 1)],
          ["DCAPE", formatNumber(indices.dcapeJkg, "", 0), "Max Wind", formatNumber(indices.maxWindKt, " kt", 0)],
          [
            "Hail",
            formatNumber(indices.maxHailSizeIn, " in", 2),
            "UH",
            formatNumber(indices.updraftHelicity2to5kmM2S2, "", 0),
          ],
        ]}
      />
      <DenseTable
        title="Lapse"
        headers={["Layer", "Tv C/km", "Layer", "Tv C/km"]}
        rows={[
          [
            "Sfc-3km",
            <LapseRateValue
              key="lapse-sfc-3km"
              layer="Sfc-3km"
              virtualValue={indices.virtualLapseRate0to3kmCPerKm}
              literalValue={indices.lapseRate0to3kmCPerKm}
            />,
            "3-6km",
            <LapseRateValue
              key="lapse-3-6km"
              layer="3-6km"
              virtualValue={indices.virtualLapseRate3to6kmCPerKm}
              literalValue={indices.lapseRate3to6kmCPerKm}
            />,
          ],
          [
            "700-500",
            <LapseRateValue
              key="lapse-700-500"
              layer="700-500"
              virtualValue={indices.virtualLapseRate700to500CPerKm}
              literalValue={indices.lapseRate700to500CPerKm}
            />,
            "850-500",
            <LapseRateValue
              key="lapse-850-500"
              layer="850-500"
              virtualValue={indices.virtualLapseRate850to500CPerKm}
              literalValue={indices.lapseRate850to500CPerKm}
            />,
          ],
        ]}
      />
      <DenseTable
        title="Critical Temps"
        headers={["Level", "Height", "Level", "Height"]}
        rows={[
          ["0C MSL", formatFeet(indices.temp0CHeightFt), "-10C MSL", formatFeet(indices.tempMinus10CHeightFt)],
          ["-20C MSL", formatFeet(indices.tempMinus20CHeightFt), "-30C MSL", formatFeet(indices.tempMinus30CHeightFt)],
          ["WBZ MSL", formatMetersCompact(indices.wetBulbZeroM), "PBL AGL", formatMetersCompact(indices.pblHeightM)],
        ]}
      />
      <DenseTable
        title="Composite"
        headers={["Param", "Value", "Param", "Value"]}
        rows={[
          [
            "SCP",
            formatNumber(indices.supercellCompositeProxy ?? indices.supercellComposite, "", 1),
            "SCP Eff",
            formatNumber(indices.supercellCompositeEffective, "", 1),
          ],
          [
            "STP Fix",
            formatNumber(indices.significantTornadoFixed, "", 1),
            "STP Eff",
            formatNumber(indices.significantTornadoEffective, "", 1),
          ],
          [
            "Eff CAPE",
            formatNumber(indices.effectiveLayerMuCapeJkg, "", 0),
            "Eff CIN",
            formatNumber(indices.effectiveLayerMuCinJkg, "", 0),
          ],
          [
            "SRW 0-2",
            formatNumber(indices.stormRelativeWind0to2kmKt, " kt", 0),
            "SRW 4-6",
            formatNumber(indices.stormRelativeWind4to6kmKt, " kt", 0),
          ],
        ]}
      />
    </div>
  );
}

type DenseTableCell = string | ReactElement;

function DenseTable({ title, headers, rows }: { title: string; headers: string[]; rows: DenseTableCell[][] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-[#030910]">
      <div className="border-b border-white/10 px-3 py-2 text-xs font-semibold text-slate-100">{title}</div>
      <table className="w-full border-collapse text-left font-mono text-[11px] text-slate-300">
        <thead className="bg-[#07111f] text-[10px] uppercase text-slate-300">
          <tr>
            {headers.map((header, index) => (
              <th key={`${title}-${header}-${index}`} className="px-2 py-1.5 font-medium">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${title}-${rowIndex}-${denseCellKey(row[0])}`} className="border-t border-white/[0.045]">
              {row.map((cell, index) => (
                <td
                  key={`${title}-${denseCellKey(row[0])}-${index}`}
                  className={index === 0 ? "px-2 py-1.5 text-slate-100" : "px-2 py-1.5"}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function denseCellKey(cell: DenseTableCell): string {
  return typeof cell === "string" ? cell : cell.key ? String(cell.key) : "cell";
}

function LapseRateValue({
  layer,
  virtualValue,
  literalValue,
}: {
  layer: string;
  virtualValue: number | null | undefined;
  literalValue: number | null | undefined;
}) {
  const hasVirtual = Number.isFinite(virtualValue);
  const shown = hasVirtual ? virtualValue : literalValue;
  const tooltip = [
    `${layer} lapse rate`,
    `Virtual-temperature LR: ${formatNumber(virtualValue, " C/km", 1)}`,
    `Literal-temperature LR: ${formatNumber(literalValue, " C/km", 1)}`,
    hasVirtual
      ? "Displayed value uses virtual temperature."
      : "Virtual-temperature value unavailable; showing literal temperature.",
  ].join("\n");
  return (
    <span title={tooltip} className="decoration-dotted underline-offset-2 hover:underline">
      {formatNumber(shown, "", 1)}
    </span>
  );
}

function HazardPanel({ indices }: { indices: PointSoundingIndices }) {
  const signal = deriveHazardSignal(indices);
  return (
    <div className="rounded-lg border border-white/10 bg-[#030910] p-3">
      <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
        <span className="font-semibold text-slate-100">Psbl Haz. Type</span>
        <span className="font-mono text-[10px] text-slate-500">signal</span>
      </div>
      <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-4 text-center">
        <div className="font-mono text-2xl font-semibold tracking-normal" style={{ color: signal.color }}>
          {signal.label}
        </div>
        <div className="mt-1 text-[11px] text-slate-400">{signal.detail}</div>
      </div>
    </div>
  );
}

function StormMotionPanel({ sounding }: { sounding: PointSoundingPayload }) {
  const indices = sounding.indices || {};
  const levels = profileLevelsWithAgl(sounding.levels).filter(
    (level) => Number.isFinite(level.uKt) && Number.isFinite(level.vKt),
  );
  const storm = windVectorFromDirectionSpeed(indices.bunkersRightDirDeg, indices.bunkersRightKt);
  const hasStorm = Number.isFinite(storm.uKt) && Number.isFinite(storm.vKt);
  const points = hasStorm
    ? levels
        .filter((level) => Number(level.heightAglM) >= 0 && Number(level.heightAglM) <= 8000)
        .map((level) => {
          const srw = Math.hypot(Number(level.uKt) - storm.uKt, Number(level.vKt) - storm.vKt);
          return `${40 + Math.min(1, srw / 80) * 170},${204 - Math.min(1, Number(level.heightAglM) / 8000) * 170}`;
        })
        .join(" ")
    : "";
  return (
    <div className="rounded-lg border border-white/10 bg-[#030910] p-3">
      <div className="mb-2 text-xs font-semibold text-slate-100">Storm Motion Vectors</div>
      <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-slate-300">
        <MiniMetric label="Bunkers R" value={formatWind(indices.bunkersRightDirDeg, indices.bunkersRightKt)} />
        <MiniMetric label="Bunkers L" value={formatWind(indices.bunkersLeftDirDeg, indices.bunkersLeftKt)} />
        <MiniMetric label="Mean 0-6" value={formatWind(indices.meanWind0to6kmDirDeg, indices.meanWind0to6kmKt)} />
        <MiniMetric label="SRW 4-6" value={formatNumber(indices.stormRelativeWind4to6kmKt, " kt", 0)} />
        <MiniMetric label="Corfidi UP" value={formatWind(indices.corfidiUpshearDirDeg, indices.corfidiUpshearKt)} />
        <MiniMetric label="Corfidi DN" value={formatWind(indices.corfidiDownshearDirDeg, indices.corfidiDownshearKt)} />
      </div>
      <svg viewBox="0 0 230 220" className="mt-3 h-44 w-full">
        {[0, 2000, 4000, 6000, 8000].map((height) => {
          const y = 204 - (height / 8000) * 170;
          return (
            <g key={`srw-h-${height}`}>
              <line x1="40" x2="210" y1={y} y2={y} stroke="rgba(148,163,184,0.14)" />
              <text x="8" y={y + 3} className="fill-slate-500 text-[9px]">
                {height / 1000}km
              </text>
            </g>
          );
        })}
        {[20, 40, 60, 80].map((speed) => {
          const x = 40 + (speed / 80) * 170;
          return (
            <g key={`srw-s-${speed}`}>
              <line x1={x} x2={x} y1="34" y2="204" stroke="rgba(148,163,184,0.12)" />
              <text x={x} y="216" textAnchor="middle" className="fill-slate-500 text-[9px]">
                {speed}
              </text>
            </g>
          );
        })}
        <polyline
          points={points}
          fill="none"
          stroke="#f97316"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function EffectiveLayerPanel({ indices }: { indices: PointSoundingIndices }) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#030910] p-3">
      <div className="mb-2 text-xs font-semibold text-slate-100">Effective Layer</div>
      <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-slate-300">
        <MiniMetric label="Layer" value={formatLayerCompact(indices.effectiveBaseM, indices.effectiveTopM)} />
        <MiniMetric label="ESRH" value={formatNumber(indices.effectiveSrhM2S2, " m2/s2", 0)} />
        <MiniMetric label="EBWD" value={formatNumber(indices.effectiveBulkShearKt, " kt", 0)} />
        <MiniMetric label="Eff CAPE" value={formatNumber(indices.effectiveLayerMuCapeJkg, "", 0)} />
        <MiniMetric label="Eff CIN" value={formatNumber(indices.effectiveLayerMuCinJkg, "", 0)} />
        <MiniMetric
          label="STP/SCP"
          value={`${formatNumber(indices.significantTornadoEffective, "", 1)}/${formatNumber(indices.supercellCompositeEffective, "", 1)}`}
        />
      </div>
    </div>
  );
}

function TechnicalSourcePanel({ sounding }: { sounding: PointSoundingPayload }) {
  const parcelLabel = sounding.parcelTrace?.label || null;
  const indices = sounding.indices || {};
  const modelSrh = formatModelSrhSummary(indices);
  return (
    <div className="rounded-lg border border-white/10 bg-[#030910] p-3 text-[11px] leading-5 text-slate-400">
      <div className="mb-1 text-xs font-semibold text-slate-100">Data</div>
      <div className="font-mono">
        {sounding.selectedRecordCount
          ? `${sounding.selectedRecordCount} cached GRIB records sampled`
          : "Cached GRIB sampled"}
      </div>
      <div className="font-mono">{sounding.levels.length} profile levels</div>
      {parcelLabel ? <div className="font-mono">{parcelLabel} trace plotted from clicked profile</div> : null}
      <div className="font-mono">Surface parcel requires 2m TMP and DPT/RH with surface pressure/height</div>
      <div className="font-mono">
        Parcel CAPE/CIN use 1 hPa pressure-step profile calculations; sampled model fields fill gaps
      </div>
      <div className="font-mono">Parcel buoyancy uses virtual-temperature correction</div>
      <div className="font-mono">LIv is lifted index using virtual-temperature correction</div>
      <div className="font-mono">Effective-layer CAPE/CIN are profile-derived layer diagnostics</div>
      <div className="font-mono">Bunkers RM method: {formatBunkersMethod(indices.bunkersMethod)}</div>
      <div className="font-mono">SRH/EHI prefer profile Bunkers RM; sampled model SRH fills gaps</div>
      <div className="font-mono">DCAPE is a reduced-profile approximation, not a full downdraft parcel trace</div>
      <div className="font-mono">Lapse table shows virtual-temperature LR when available</div>
      <div className="font-mono">Height-layer values are blank outside sampled profile bounds</div>
      {modelSrh ? <div className="font-mono">Model SRH sampled: {modelSrh}</div> : null}
      <div className="font-mono">{sounding.source || "point sounding"}</div>
    </div>
  );
}

function formatBunkersMethod(method: string | null | undefined): string {
  if (method === "effective") {
    return "effective layer";
  }
  if (method === "fixed-0-6km") {
    return "fixed SFC-6km fallback";
  }
  return "--";
}

function formatModelSrhSummary(indices: PointSoundingIndices): string {
  const parts = [];
  if (Number.isFinite(indices.modelSrh0to1kmM2S2)) {
    parts.push(`0-1 ${formatNumber(indices.modelSrh0to1kmM2S2, "", 0)}`);
  }
  if (Number.isFinite(indices.modelSrh0to3kmM2S2)) {
    parts.push(`0-3 ${formatNumber(indices.modelSrh0to3kmM2S2, "", 0)}`);
  }
  return parts.length ? `${parts.join(" / ")} m2/s2` : "";
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5">
      <div className="truncate text-[9px] uppercase text-slate-400">{label}</div>
      <div className="truncate text-slate-100" title={value}>
        {value}
      </div>
    </div>
  );
}

function LevelTable({ levels }: { levels: PointSoundingLevel[] }) {
  const rows = normalizedLevels(levels);
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-[#030910]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-xs text-slate-300">
        <span className="font-semibold text-slate-100">Profile</span>
        <span className="font-mono text-[11px] text-slate-400">{rows.length} levels</span>
      </div>
      <div className="max-h-48 overflow-auto">
        <table className="w-full border-collapse text-left font-mono text-[11px] text-slate-300">
          <thead className="sticky top-0 bg-[#07111f] text-[10px] uppercase text-slate-300">
            <tr>
              <th className="px-3 py-1.5 font-medium">P</th>
              <th className="px-2 py-1.5 font-medium">Hgt</th>
              <th className="px-2 py-1.5 font-medium">T</th>
              <th className="px-2 py-1.5 font-medium">Td</th>
              <th className="px-2 py-1.5 font-medium">RH</th>
              <th className="px-2 py-1.5 font-medium">Wind</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((level) => (
              <tr key={`${level.source}-${level.press}-${level.hght}`} className="border-t border-white/[0.045]">
                <td className="px-3 py-1.5 text-slate-100">{formatNumber(level.press, "", 0)}</td>
                <td className="px-2 py-1.5">{formatNumber(level.hght, " m", 0)}</td>
                <td className="px-2 py-1.5 text-rose-200">{formatNumber(level.temp, " C", 1)}</td>
                <td className="px-2 py-1.5 text-emerald-200">{formatNumber(level.dwpt, " C", 1)}</td>
                <td className="px-2 py-1.5">{formatNumber(level.rh, "%", 0)}</td>
                <td className="px-2 py-1.5">{formatWind(level.wdir, level.wspd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WindBarb({ x, y, level }: { x: number; y: number; level: PointSoundingLevel }) {
  const speed = Math.max(0, Number(level.wspd) || 0);
  const direction = Number(level.wdir) || 0;
  const flags = Math.floor(speed / 50);
  let remainder = speed - flags * 50;
  const full = Math.floor(remainder / 10);
  remainder -= full * 10;
  const half = remainder >= 5 ? 1 : 0;
  const feathers: ReactElement[] = [];
  let offset = 0;
  for (let index = 0; index < flags; index += 1) {
    feathers.push(<path key={`f-${index}`} d={`M ${26 - offset} 0 l -8 -5 l 2 5 z`} fill="#e2e8f0" />);
    offset += 7;
  }
  for (let index = 0; index < full; index += 1) {
    feathers.push(
      <line key={`b-${index}`} x1={26 - offset} y1="0" x2={18 - offset} y2="-7" stroke="#e2e8f0" strokeWidth="1.7" />,
    );
    offset += 5;
  }
  if (half) {
    feathers.push(
      <line key="half" x1={26 - offset} y1="0" x2={21 - offset} y2="-4" stroke="#e2e8f0" strokeWidth="1.7" />,
    );
  }
  return (
    <g transform={`translate(${x} ${y}) rotate(${direction - 90})`}>
      <line x1="0" x2="28" y1="0" y2="0" stroke="#e2e8f0" strokeWidth="1.7" />
      {feathers}
    </g>
  );
}

function LegendChip({
  x,
  y,
  color,
  label,
  dash,
}: {
  x: number;
  y: number;
  color: string;
  label: string;
  dash?: string;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <line x1="0" x2="22" y1="0" y2="0" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={dash} />
      <text x="28" y="4" className="fill-slate-300 text-[11px]">
        {label}
      </text>
    </g>
  );
}

function GridLine({
  points,
  color = "rgba(148,163,184,0.16)",
  width = 1,
}: {
  points: Array<{ x: number; y: number }>;
  color?: string;
  width?: number;
}) {
  return (
    <line
      x1={points[0].x}
      y1={points[0].y}
      x2={points[1].x}
      y2={points[1].y}
      stroke={color}
      strokeWidth={width}
      clipPath="url(#sounding-plot-clip)"
    />
  );
}

function normalizedLevels(levels: PointSoundingLevel[]): PointSoundingLevel[] {
  return (Array.isArray(levels) ? levels : [])
    .filter((level) => Number.isFinite(level.press))
    .sort((left, right) => Number(right.press) - Number(left.press));
}

function profileLevelsWithAgl(levels: PointSoundingLevel[]): Array<PointSoundingLevel & { heightAglM: number }> {
  const rows = normalizedLevels(levels)
    .filter((level) => Number.isFinite(level.hght))
    .sort((left, right) => Number(left.hght) - Number(right.hght));
  const surface = rows.find((level) => level.source === "surface") || rows[0] || null;
  const surfaceHeight = Number(surface?.hght);
  return rows.map((level) => ({
    ...level,
    heightAglM: Number(level.hght) - (Number.isFinite(surfaceHeight) ? surfaceHeight : 0),
  }));
}

function pathForLevels(levels: PointSoundingLevel[], key: "temp" | "dwpt"): string {
  return levels
    .filter((level) => Number.isFinite(level.press) && Number.isFinite(level[key]))
    .map((level, index) => {
      const point = pointForTempPressure(Number(level[key]), Number(level.press));
      return `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    })
    .join(" ");
}

function windBarbLevels(levels: PointSoundingLevel[]): Array<{ level: PointSoundingLevel; y: number }> {
  const rows = profileLevelsWithAgl(levels);
  const surface = rows.find((level) => level.source === "surface") || rows[0] || null;
  const surfaceHeight = Number(surface?.hght);
  const lowLevelBarbs: Array<{ level: PointSoundingLevel; y: number }> = [];
  for (const aglM of LOW_LEVEL_WIND_BARB_AGL_LEVELS_M) {
    const pressure = pressureForAglHeight(levels, aglM);
    const wind = interpolateWindAtAgl(rows, aglM);
    const y = Number.isFinite(pressure) ? yForPressure(pressure) : Number.NaN;
    if (!wind || !Number.isFinite(y)) {
      continue;
    }
    const meteorologicalWind = meteorologicalFromWindComponentsKt(wind.uKt, wind.vKt);
    lowLevelBarbs.push({
      level: {
        source: `agl-${aglM}`,
        press: pressure,
        hght: Number.isFinite(surfaceHeight) ? surfaceHeight + aglM : null,
        temp: null,
        dwpt: null,
        ...meteorologicalWind,
      },
      y,
    });
  }
  const topFixedAglM = LOW_LEVEL_WIND_BARB_AGL_LEVELS_M[LOW_LEVEL_WIND_BARB_AGL_LEVELS_M.length - 1];
  const upperBarbs = rows
    .filter(
      (level) =>
        Number(level.heightAglM) > topFixedAglM &&
        Number.isFinite(level.press) &&
        Number.isFinite(level.wspd) &&
        Number.isFinite(level.wdir),
    )
    .map((level) => ({ level, y: yForPressure(Number(level.press)) }))
    .filter((entry) => Number.isFinite(entry.y));
  return [...lowLevelBarbs, ...upperBarbs].sort((left, right) => right.y - left.y);
}

function pathForParcelTrace(levels: Array<{ press: number | null; temp: number | null }>): string {
  return (Array.isArray(levels) ? levels : [])
    .filter((level) => Number.isFinite(level.press) && Number.isFinite(level.temp))
    .map((level, index) => {
      const point = pointForTempPressure(Number(level.temp), Number(level.press));
      return `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    })
    .join(" ");
}

function dryAdiabatPath(thetaK: number): string {
  const points: string[] = [];
  for (let pressure = 1000; pressure >= 100; pressure -= 25) {
    const tempC = thetaK * Math.pow(pressure / 1000, 0.2854) - 273.15;
    const point = pointForTempPressure(tempC, pressure);
    points.push(`${points.length === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`);
  }
  return points.join(" ");
}

function mixingRatioPath(ratioGkg: number): string {
  const points: string[] = [];
  for (let pressure = 1000; pressure >= 400; pressure -= 25) {
    const tempC = saturationTempForMixingRatioC(ratioGkg, pressure);
    const point = pointForTempPressure(tempC, pressure);
    points.push(`${points.length === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`);
  }
  return points.join(" ");
}

function saturationTempForMixingRatioC(ratioGkg: number, pressureHpa: number): number {
  const mixingRatio = Math.max(0.0001, ratioGkg / 1000);
  const vaporPressure = (mixingRatio * pressureHpa) / (0.622 + mixingRatio);
  const logRatio = Math.log(vaporPressure / 6.112);
  return (243.5 * logRatio) / (17.67 - logRatio);
}

function pointForTempPressure(tempC: number, pressureHpa: number): { x: number; y: number } {
  const offset = SKEW_C * (Math.log(PRESSURE_MAX / pressureHpa) / Math.log(PRESSURE_MAX / PRESSURE_MIN));
  const x = PLOT.left + ((tempC + offset - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)) * PLOT.width;
  return { x, y: yForPressure(pressureHpa) };
}

function yForPressure(pressureHpa: number): number {
  const t = Math.log(PRESSURE_MAX / pressureHpa) / Math.log(PRESSURE_MAX / PRESSURE_MIN);
  const clamped = Math.max(0, Math.min(1, t));
  return PLOT.top + (1 - clamped) * PLOT.height;
}

function yForAglHeight(levels: PointSoundingLevel[], aglM: number | null | undefined): number {
  const pressure = pressureForAglHeight(levels, aglM);
  return Number.isFinite(pressure) ? yForPressure(pressure) : Number.NaN;
}

function pressureForAglHeight(levels: PointSoundingLevel[], aglM: number | null | undefined): number {
  if (!Number.isFinite(aglM)) {
    return Number.NaN;
  }
  const rows = profileLevelsWithAgl(levels)
    .filter((level) => Number.isFinite(level.press) && Number.isFinite(level.heightAglM))
    .sort((left, right) => Number(left.heightAglM) - Number(right.heightAglM));
  const target = Number(aglM);
  for (let index = 1; index < rows.length; index += 1) {
    const lower = rows[index - 1];
    const upper = rows[index];
    if (Number(lower.heightAglM) <= target && Number(upper.heightAglM) >= target) {
      const t = (target - Number(lower.heightAglM)) / Math.max(1, Number(upper.heightAglM) - Number(lower.heightAglM));
      return Math.exp(
        Math.log(Number(lower.press)) +
          (Math.log(Number(upper.press)) - Math.log(Number(lower.press))) * Math.max(0, Math.min(1, t)),
      );
    }
  }
  return Number.NaN;
}

function interpolateWindAtAgl(
  levels: Array<PointSoundingLevel & { heightAglM: number }>,
  aglM: number,
): { uKt: number; vKt: number } | null {
  const rows = levels
    .filter((level) => Number.isFinite(level.heightAglM) && Number.isFinite(level.uKt) && Number.isFinite(level.vKt))
    .sort((left, right) => Number(left.heightAglM) - Number(right.heightAglM));
  for (let index = 1; index < rows.length; index += 1) {
    const lower = rows[index - 1];
    const upper = rows[index];
    if (Number(lower.heightAglM) <= aglM && Number(upper.heightAglM) >= aglM) {
      const t = (aglM - Number(lower.heightAglM)) / Math.max(1, Number(upper.heightAglM) - Number(lower.heightAglM));
      return {
        uKt: Number(lower.uKt) + (Number(upper.uKt) - Number(lower.uKt)) * Math.max(0, Math.min(1, t)),
        vKt: Number(lower.vKt) + (Number(upper.vKt) - Number(lower.vKt)) * Math.max(0, Math.min(1, t)),
      };
    }
  }
  return null;
}

function meteorologicalFromWindComponentsKt(
  uKt: number,
  vKt: number,
): Pick<PointSoundingLevel, "wdir" | "wspd" | "uKt" | "vKt"> {
  const u = Number(uKt);
  const v = Number(vKt);
  if (!Number.isFinite(u) || !Number.isFinite(v)) {
    return { wdir: Number.NaN, wspd: Number.NaN, uKt: Number.NaN, vKt: Number.NaN };
  }
  const direction = (Math.atan2(-u, -v) * 180) / Math.PI;
  return {
    wdir: (direction + 360) % 360,
    wspd: Math.hypot(u, v),
    uKt: u,
    vKt: v,
  };
}

function windVectorFromDirectionSpeed(
  directionDeg: number | null | undefined,
  speedKt: number | null | undefined,
): { uKt: number; vKt: number } {
  if (!Number.isFinite(directionDeg) || !Number.isFinite(speedKt)) {
    return { uKt: Number.NaN, vKt: Number.NaN };
  }
  const radians = (Number(directionDeg) * Math.PI) / 180;
  return {
    uKt: -Number(speedKt) * Math.sin(radians),
    vKt: -Number(speedKt) * Math.cos(radians),
  };
}

function hodographColorForHeight(heightAglM: number): string {
  if (heightAglM < 1000) {
    return "#ef4444";
  }
  if (heightAglM < 3000) {
    return "#facc15";
  }
  if (heightAglM < 6000) {
    return "#22c55e";
  }
  if (heightAglM < 9000) {
    return "#38bdf8";
  }
  return "#a78bfa";
}

function deriveHazardSignal(indices: PointSoundingIndices): { label: string; detail: string; color: string } {
  const cape = Math.max(
    finiteOrNegative(indices.sbcapeJkg),
    finiteOrNegative(indices.mlcapeJkg),
    finiteOrNegative(indices.mucapeJkg),
  );
  const stp = Math.max(
    finiteOrNegative(indices.significantTornadoEffective),
    finiteOrNegative(indices.significantTornadoFixed),
  );
  const scp = Math.max(
    finiteOrNegative(indices.supercellCompositeEffective),
    finiteOrNegative(indices.supercellCompositeProxy),
    finiteOrNegative(indices.supercellComposite),
  );
  const shear = Math.max(finiteOrNegative(indices.effectiveBulkShearKt), finiteOrNegative(indices.shear0to6kmKt));
  const srh = Math.max(
    finiteOrNegative(indices.effectiveSrhM2S2),
    finiteOrNegative(indices.srh0to1kmM2S2),
    finiteOrNegative(indices.srh0to3kmM2S2),
  );
  const hail = finiteOrNegative(indices.maxHailSizeIn);
  if (stp >= 2 && cape >= 500 && shear >= 30 && srh >= 100) {
    return { label: "TOR", detail: "tornadic supercell signal", color: "#ef4444" };
  }
  if (stp >= 1 && cape >= 500 && shear >= 25) {
    return { label: "TOR?", detail: "conditional tornado signal", color: "#fb7185" };
  }
  if (scp >= 4 && cape >= 1000 && shear >= 35) {
    return { label: "SUP", detail: "supercell-favored signal", color: "#f97316" };
  }
  if ((cape >= 1000 && shear >= 30) || hail >= 1) {
    return { label: "SVR", detail: "organized severe signal", color: "#facc15" };
  }
  if (cape >= 250 && shear >= 25) {
    return { label: "MRGL", detail: "weak or conditional signal", color: "#38bdf8" };
  }
  return { label: "NONE", detail: "limited severe signal", color: "#facc15" };
}

function finiteOrNegative(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : Number.NEGATIVE_INFINITY;
}

function formatMetersCompact(value: number | null | undefined): string {
  if (!Number.isFinite(value)) {
    return "--";
  }
  const number = Number(value);
  return Math.abs(number) >= 1000 ? `${(number / 1000).toFixed(1)}km` : `${Math.round(number)}m`;
}

function formatFeet(value: number | null | undefined): string {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return `${Math.round(Number(value))} ft`;
}

function formatNumber(value: number | null | undefined, suffix: string, digits: number): string {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return `${Number(value).toFixed(digits)}${suffix}`;
}

function formatWind(directionDeg: number | null | undefined, speedKt: number | null | undefined): string {
  if (!Number.isFinite(directionDeg) && !Number.isFinite(speedKt)) {
    return "--";
  }
  const direction = Number.isFinite(directionDeg) ? String(Math.round(Number(directionDeg))).padStart(3, "0") : "---";
  const speed = Number.isFinite(speedKt) ? Math.round(Number(speedKt)) : "--";
  return `${direction}/${speed}`;
}

function formatSignedCoordinate(value: number): string {
  return Number.isFinite(value) ? Number(value).toFixed(2) : "";
}

function parseCoordinateInput(value: string, axis: "lat" | "lon"): number {
  const text = String(value || "")
    .trim()
    .toUpperCase();
  const hemisphereMatch = text.match(/[NSEW]$/);
  const hemisphere = hemisphereMatch?.[0] || "";
  const numeric = Number(text.replace(/[NSEW]$/, "").replace(/[^\d.+-]/g, ""));
  if (!Number.isFinite(numeric)) {
    return Number.NaN;
  }
  let coordinate = numeric;
  if (hemisphere === "S" || hemisphere === "W") {
    coordinate = -Math.abs(numeric);
  } else if (hemisphere === "N" || hemisphere === "E") {
    coordinate = Math.abs(numeric);
  }
  const min = axis === "lat" ? -90 : -180;
  const max = axis === "lat" ? 90 : 180;
  return coordinate >= min && coordinate <= max ? coordinate : Number.NaN;
}

function formatLayerCompact(baseM: number | null | undefined, topM: number | null | undefined): string {
  if (!Number.isFinite(baseM) && !Number.isFinite(topM)) {
    return "--";
  }
  const base = Number.isFinite(baseM) ? formatMetersCompact(baseM) : "--";
  const top = Number.isFinite(topM) ? formatMetersCompact(topM) : "--";
  return `${base}-${top}`;
}
