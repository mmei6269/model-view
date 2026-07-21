import { MODEL_CONFIG, MODEL_KEYS } from "../../config/constants";
import type {
  FrameHourStatus,
  LayerDefinition,
  LayerKey,
  ModelKey,
  RunManifestPointer,
  ValidTimeIso,
} from "../../types";
import { getParameterCaveat } from "../../config/parameter-caveats";
import { computeRunStaleness } from "../../lib/run-staleness";
import { formatUnitDisplay, hourChipClass } from "./format-utils";

export interface PanelFrameOption {
  hour: number;
  status: FrameHourStatus;
  selected: boolean;
  selectable: boolean;
  validHourKey: ValidTimeIso | null;
}

interface PanelStatus {
  label: string;
  kind: "loading" | "error" | "ready";
}

interface PanelChromeProps {
  modelKey: ModelKey;
  // Quarter-height panels (3-4 up) render tighter paddings and controls.
  compact?: boolean;
  referenceTime: string | null;
  status: PanelStatus;
  loadedCount: number;
  totalHours: number;
  runLabel: string;
  currentRunId: string | null;
  selectedRunId: string | null;
  runOptions: RunManifestPointer[];
  frameHour: number | null;
  validLabel: string;
  frameOptions: PanelFrameOption[];
  menuOpen: boolean;
  parameterMenuOpen: boolean;
  parameterOptions: LayerDefinition[];
  selectedLayers: Set<LayerKey>;
  canRemove: boolean;
  onToggleMenu: () => void;
  onToggleParameterMenu: () => void;
  onLayerToggle: (layer: LayerKey) => void;
  onModelChange: (modelKey: ModelKey) => void;
  onRunChange: (runId: string | null) => void;
  onSelectValidTime: (validTime: ValidTimeIso) => void;
  onRemove: () => void;
}

const statusDotClass: Record<PanelStatus["kind"], string> = {
  loading: "bg-amber-300 shadow-[0_0_0_3px_rgba(251,191,36,0.14)] animate-pulse",
  error: "bg-rose-300 shadow-[0_0_0_3px_rgba(251,113,133,0.14)]",
  ready: "bg-emerald-300 shadow-[0_0_0_3px_rgba(110,231,183,0.12)]",
};

const statusTextClass: Record<PanelStatus["kind"], string> = {
  loading: "text-amber-100",
  error: "text-rose-100",
  ready: "text-slate-100",
};

const PRECIPITATION_GROUP = "Precipitation";
const SEVERE_THERMO_GROUP = "Severe: Thermodynamics";
const SEVERE_KINEMATICS_GROUP = "Severe: Kinematics";
const WINTER_GROUP = "Winter / Snow & Ice";
const UPPER_AIR_STANDARD_GROUP = "Upper Air: Height / Wind / Temp";
const UPPER_AIR_DIAGNOSTIC_GROUP = "Upper Air: Omega / Vorticity";
const PARAMETER_GROUP_ORDER = [
  "Surface & Boundary Layer",
  PRECIPITATION_GROUP,
  "Radar",
  "Clouds & Ceiling",
  UPPER_AIR_STANDARD_GROUP,
  UPPER_AIR_DIAGNOSTIC_GROUP,
  SEVERE_THERMO_GROUP,
  SEVERE_KINEMATICS_GROUP,
  WINTER_GROUP,
  "Selected",
  "Parameters",
];
const SLOTTED_PARAMETER_GROUPS = new Set([
  PRECIPITATION_GROUP,
  UPPER_AIR_STANDARD_GROUP,
  UPPER_AIR_DIAGNOSTIC_GROUP,
  SEVERE_THERMO_GROUP,
  SEVERE_KINEMATICS_GROUP,
  WINTER_GROUP,
]);

export function PanelChrome({
  modelKey,
  compact = false,
  referenceTime,
  status,
  loadedCount,
  totalHours,
  runLabel,
  currentRunId,
  selectedRunId,
  runOptions,
  frameHour,
  validLabel,
  frameOptions,
  menuOpen,
  parameterMenuOpen,
  parameterOptions,
  selectedLayers,
  canRemove,
  onToggleMenu,
  onToggleParameterMenu,
  onLayerToggle,
  onModelChange,
  onRunChange,
  onSelectValidTime,
  onRemove,
}: PanelChromeProps) {
  const frameHorizonLabel = formatFrameHorizon(frameOptions);
  const frameLabel = frameHour === null ? "F---" : `F${String(frameHour).padStart(3, "0")}`;
  const selectedRunMissing = selectedRunId && !runOptions.some((run) => run.run === selectedRunId);
  // Shared control sizing: quarter panels drop one notch so the bar does not
  // dominate a half-height map.
  const controlClass = compact ? "h-7 px-2 text-[11px]" : "h-8 px-2.5 text-xs";

  return (
    <>
      {/* Outside-click dismissal for the inline menus, mirroring DisplayMenu's
          fixed-inset backdrop idiom. It must sit outside the chrome root: that
          div's backdrop-blur is a containing block for fixed descendants, which
          would pin inset-0 to the chrome box instead of the viewport. The
          chrome root below is relative z-50 so its controls stay clickable. */}
      {parameterMenuOpen || menuOpen ? (
        <div
          className="pointer-events-auto fixed inset-0 z-40"
          onClick={() => {
            if (parameterMenuOpen) {
              onToggleParameterMenu();
            }
            if (menuOpen) {
              onToggleMenu();
            }
          }}
        />
      ) : null}
      <div
        className={`pointer-events-auto relative z-50 w-fit max-w-full rounded-lg border border-white/[0.08] bg-slate-900/[0.72] shadow-lg shadow-slate-950/35 backdrop-blur-xl ${
          compact ? "px-2 py-1.5" : "px-3 py-2"
        }`}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className={`font-semibold leading-none text-slate-50 ${compact ? "text-sm" : "text-lg"}`}>
              {MODEL_CONFIG[modelKey].label}
            </h2>
            <StatusBadge status={status} />
            {compact ? null : (
              <RunAgeChip
                modelKey={modelKey}
                referenceTime={referenceTime}
                currentRunId={currentRunId}
                runOptions={runOptions}
              />
            )}
          </div>

          <select
            value={modelKey}
            onChange={(event) => onModelChange(event.target.value as ModelKey)}
            className={`${controlClass} rounded-lg border border-white/[0.12] bg-slate-950/[0.88] font-medium text-slate-100 shadow-inner shadow-black/20 outline-none hover:border-white/20 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20`}
            aria-label="Model"
          >
            {MODEL_KEYS.map((key) => (
              <option key={key} value={key} className="bg-slate-950">
                {MODEL_CONFIG[key].label}
              </option>
            ))}
          </select>

          <select
            value={selectedRunId || ""}
            onChange={(event) => onRunChange(event.target.value || null)}
            className={`${controlClass} ${compact ? "max-w-36" : "max-w-44"} rounded-lg border border-white/[0.12] bg-slate-950/[0.88] font-medium text-slate-100 shadow-inner shadow-black/20 outline-none hover:border-white/20 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20`}
            aria-label="Run"
          >
            <option value="" className="bg-slate-950">
              Latest
            </option>
            {selectedRunMissing ? (
              <option value={selectedRunId} className="bg-slate-950">
                {formatRunId(selectedRunId)}
              </option>
            ) : null}
            {runOptions.map((run) => (
              <option key={run.run} value={run.run} className="bg-slate-950">
                {formatRunOptionLabel(run)}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={onToggleParameterMenu}
            className={`${controlClass} rounded-lg border font-semibold active:scale-95 ${
              parameterMenuOpen
                ? "border-cyan-300/40 bg-cyan-400/20 text-cyan-100"
                : "border-white/[0.12] bg-white/[0.06] text-slate-200 hover:bg-white/[0.1]"
            }`}
            aria-expanded={parameterMenuOpen}
          >
            Parameters {selectedLayers.size}
          </button>

          <button
            type="button"
            onClick={onToggleMenu}
            className={`${controlClass} rounded-lg border font-semibold active:scale-95 ${
              menuOpen
                ? "border-cyan-300/40 bg-cyan-400/20 text-cyan-100"
                : "border-white/[0.12] bg-white/[0.06] text-slate-200 hover:bg-white/[0.1]"
            }`}
            aria-expanded={menuOpen}
          >
            Frames {loadedCount}/{totalHours}
            {frameHorizonLabel ? ` · ${frameHorizonLabel}` : ""}
          </button>

          {canRemove ? (
            <button
              type="button"
              onClick={onRemove}
              className={`${controlClass} rounded-lg border border-rose-400/35 bg-rose-500/10 font-semibold text-rose-100 hover:bg-rose-500/20 active:scale-95`}
            >
              Remove
            </button>
          ) : null}
        </div>

        <div
          className={`flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 leading-4 text-slate-200/90 ${
            compact ? "mt-1 text-[10px]" : "mt-1.5 text-[11px]"
          }`}
        >
          <span className="min-w-0 truncate">Run {runLabel}</span>
          <span className="rounded border border-white/[0.08] bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-slate-100">
            {frameLabel}
          </span>
          <span className="min-w-0 truncate">Valid {validLabel}</span>
          {compact ? (
            <RunAgeChip
              modelKey={modelKey}
              referenceTime={referenceTime}
              currentRunId={currentRunId}
              runOptions={runOptions}
            />
          ) : null}
        </div>

        <div
          data-testid="parameter-menu-wrapper"
          className={`origin-top transition-opacity duration-200 ${
            parameterMenuOpen ? "mt-2 opacity-100" : "max-h-0 overflow-hidden opacity-0"
          }`}
        >
          <div
            data-testid="parameter-menu-scroll"
            className="max-h-[min(34rem,62vh)] w-[min(52rem,calc(100vw-3.5rem))] max-w-full overflow-auto rounded-md border border-white/[0.06] bg-slate-950/35 p-1.5"
          >
            {groupParameterOptions(parameterOptions).map((group) => (
              <div key={group.name} className="py-1.5">
                <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                  {group.name}
                </div>
                <ParameterGroupControls
                  groupName={group.name}
                  options={group.options}
                  selectedLayers={selectedLayers}
                  onLayerToggle={onLayerToggle}
                />
              </div>
            ))}
          </div>
        </div>

        <div
          className={`origin-top overflow-hidden transition-all duration-200 ${
            menuOpen ? "mt-2 max-h-48 opacity-100" : "max-h-0 opacity-0"
          }`}
        >
          <div
            className="mb-1 flex flex-wrap gap-x-2 gap-y-0.5 px-0.5 text-[9px] text-slate-400"
            aria-label="Frame status key"
          >
            {(["loaded", "loading", "pending", "error", "unavailable"] as FrameHourStatus[]).map((frameStatus) => (
              <span key={frameStatus} className="inline-flex items-center gap-1">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${frameStatusDotClass(frameStatus)}`}
                  aria-hidden="true"
                />
                {frameStatusLabel(frameStatus)}
              </span>
            ))}
          </div>
          <div className="grid max-h-40 grid-cols-8 gap-1 overflow-auto rounded-md border border-white/[0.06] bg-slate-950/35 p-1 sm:grid-cols-10 md:grid-cols-12">
            {frameOptions.map((option) => {
              const clickable = option.selectable && Boolean(option.validHourKey);
              return (
                <button
                  key={option.hour}
                  type="button"
                  disabled={!clickable}
                  onClick={() => {
                    if (option.validHourKey) {
                      onSelectValidTime(option.validHourKey);
                    }
                  }}
                  aria-label={`Forecast hour ${option.hour}: ${frameStatusLabel(option.status)}${
                    option.selected ? ", selected" : ""
                  }`}
                  title={`F${String(option.hour).padStart(3, "0")} - ${frameStatusLabel(option.status)}`}
                  data-frame-status={option.status}
                  className={hourChipClass(option.status, option.selected)}
                >
                  {String(option.hour).padStart(3, "0")}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

function formatFrameHorizon(frameOptions: PanelFrameOption[]): string {
  const hours = frameOptions.map((option) => Number(option.hour)).filter(Number.isFinite);
  if (hours.length === 0) {
    return "";
  }
  const first = Math.min(...hours);
  const last = Math.max(...hours);
  return `F${String(first).padStart(3, "0")}-F${String(last).padStart(3, "0")}`;
}

function groupParameterOptions(options: LayerDefinition[]) {
  const groups: Array<{ name: string; options: LayerDefinition[] }> = [];
  const byName = new Map<string, LayerDefinition[]>();
  for (const option of options) {
    const group = String(option.group || "Parameters").trim() || "Parameters";
    const bucket = byName.get(group) || [];
    bucket.push(option);
    byName.set(group, bucket);
  }
  for (const [name, groupedOptions] of byName.entries()) {
    groups.push({ name, options: groupedOptions });
  }
  for (const name of PARAMETER_GROUP_ORDER) {
    if (SLOTTED_PARAMETER_GROUPS.has(name) && !byName.has(name)) {
      groups.push({ name, options: [] });
    }
  }
  return groups.sort((left, right) => parameterGroupRank(left.name) - parameterGroupRank(right.name));
}

function parameterGroupRank(name: string) {
  const index = PARAMETER_GROUP_ORDER.indexOf(name);
  return index === -1 ? PARAMETER_GROUP_ORDER.length : index;
}

interface ParameterGridSlot {
  key: string;
  placeholderLabel?: string | null;
}

const UPPER_AIR_STANDARD_ROWS: ParameterGridSlot[][] = [
  [{ key: "height250" }, { key: "wind250" }],
  [{ key: "height300" }, { key: "wind300" }],
  [{ key: "height500" }, { key: "wind500" }, { key: "temp500" }, { key: "rh500" }],
  [{ key: "height700" }, { key: "wind700" }, { key: "temp700" }, { key: "rh700" }],
  [{ key: "height850" }, { key: "wind850" }, { key: "temp850" }, { key: "rh850" }],
];

const UPPER_AIR_DIAGNOSTIC_ROWS: ParameterGridSlot[][] = ["500", "700"].map((level) => [
  { key: `absoluteVorticity${level}`, placeholderLabel: `${level} mb Abs Vort` },
  { key: `verticalVelocity${level}`, placeholderLabel: `${level} mb Omega` },
  { key: `relativeVorticity${level}`, placeholderLabel: `${level} mb Rel Vort` },
]);

const PRECIPITATION_ROWS: ParameterGridSlot[][] = [
  [
    { key: "precip", placeholderLabel: "1-h Precip" },
    { key: "precip3h", placeholderLabel: "3-h Precip" },
    { key: "precip6h", placeholderLabel: "6-h Precip" },
  ],
  [
    { key: "precip12h", placeholderLabel: "12-h Precip" },
    { key: "precip24h", placeholderLabel: "24-h Precip" },
    { key: "precipTotal", placeholderLabel: "Total Precip" },
  ],
  [{ key: "precipRateAndType", placeholderLabel: "Precip Rate + Type" }],
];

const SEVERE_THERMO_ROWS: ParameterGridSlot[][] = [
  [
    { key: "sbcape", placeholderLabel: "SBCAPE" },
    { key: "sbcin", placeholderLabel: "SBCIN" },
  ],
  [
    { key: "mlcape", placeholderLabel: "MLCAPE" },
    { key: "mlcin", placeholderLabel: "MLCIN" },
  ],
  [
    { key: "mucape", placeholderLabel: "MUCAPE" },
    { key: "dcape", placeholderLabel: "DCAPE" },
  ],
  [
    { key: "surfaceBasedLclHeight", placeholderLabel: "Surface LCL (AGL)" },
    { key: "surfaceThetaE", placeholderLabel: "Surface Theta-e" },
  ],
  [
    { key: "lapseRate700to500", placeholderLabel: "700-500 LR" },
    { key: "lapseRate0to3km", placeholderLabel: "0-3 km LR" },
  ],
  [{ key: "maxSimulatedHailSize", placeholderLabel: "Max Model-Simulated Hail" }],
];

const SEVERE_KINEMATICS_ROWS: ParameterGridSlot[][] = [
  [
    { key: "srh0to1km", placeholderLabel: "0-1 km SRH" },
    { key: "srh0to3km", placeholderLabel: "0-3 km SRH" },
  ],
  [
    { key: "bulkShear0to6km", placeholderLabel: "0-6 km Shear" },
    { key: "effectiveBulkShear", placeholderLabel: "Eff Bulk Shear" },
  ],
  [
    { key: "supercellCompositeParameter", placeholderLabel: "SCP 0-3 km Proxy" },
    { key: "effectiveLayerSupercellCompositeParameter", placeholderLabel: "SCP Effective" },
  ],
  [
    { key: "significantTornadoParameter", placeholderLabel: "STP Fixed" },
    { key: "effectiveLayerSignificantTornadoParameter", placeholderLabel: "STP Effective" },
  ],
  [
    { key: "updraftHelicity2to5km1h", placeholderLabel: "1-h Max 2-5 km UH" },
    { key: "updraftHelicity2to5kmRunMax", placeholderLabel: "Run Max of 1-h UH" },
  ],
];

const WINTER_ROWS: ParameterGridSlot[][] = [
  [
    { key: "wetBulbZeroHeight", placeholderLabel: "Wet-Bulb Zero (MSL)" },
    { key: "freezingRainLiquidTotal", placeholderLabel: "Freezing Rain Liquid" },
  ],
  [
    { key: "snowDepth", placeholderLabel: "Snow Depth (State)" },
    { key: "snowWaterEq", placeholderLabel: "Snow Water Eq (State)" },
  ],
  [
    { key: "snow10to1", placeholderLabel: "10:1 Snow" },
    { key: "snowKuchera", placeholderLabel: "Kuchera Snow" },
  ],
  [
    { key: "snowCobb", placeholderLabel: "Cobb Snow" },
    { key: "snowRfConus", placeholderLabel: "CONUS RF Snow" },
  ],
  [
    { key: "snowWesternLinear", placeholderLabel: "Western HRRR Linear Snow" },
    { key: "snowHrrrAsnow", placeholderLabel: "HRRR ASNOW" },
  ],
  [
    { key: "framFlatIce", placeholderLabel: "FRAM Flat Ice" },
    { key: "framRadialIce", placeholderLabel: "FRAM Radial Ice" },
  ],
];

function ParameterGroupControls({
  groupName,
  options,
  selectedLayers,
  onLayerToggle,
}: {
  groupName: string;
  options: LayerDefinition[];
  selectedLayers: Set<LayerKey>;
  onLayerToggle: (layer: LayerKey) => void;
}) {
  if (groupName === UPPER_AIR_STANDARD_GROUP) {
    return (
      <ParameterSlotGrid
        options={options}
        rows={UPPER_AIR_STANDARD_ROWS}
        selectedLayers={selectedLayers}
        onLayerToggle={onLayerToggle}
      />
    );
  }
  if (groupName === UPPER_AIR_DIAGNOSTIC_GROUP) {
    return (
      <ParameterSlotGrid
        options={options}
        rows={UPPER_AIR_DIAGNOSTIC_ROWS}
        selectedLayers={selectedLayers}
        onLayerToggle={onLayerToggle}
      />
    );
  }
  if (groupName === PRECIPITATION_GROUP) {
    return (
      <ParameterSlotGrid
        options={options}
        rows={PRECIPITATION_ROWS}
        selectedLayers={selectedLayers}
        onLayerToggle={onLayerToggle}
      />
    );
  }
  if (groupName === SEVERE_THERMO_GROUP) {
    return (
      <ParameterSlotGrid
        options={options}
        rows={SEVERE_THERMO_ROWS}
        selectedLayers={selectedLayers}
        onLayerToggle={onLayerToggle}
      />
    );
  }
  if (groupName === SEVERE_KINEMATICS_GROUP) {
    return (
      <ParameterSlotGrid
        options={options}
        rows={SEVERE_KINEMATICS_ROWS}
        selectedLayers={selectedLayers}
        onLayerToggle={onLayerToggle}
      />
    );
  }
  if (groupName === WINTER_GROUP) {
    return (
      <ParameterSlotGrid
        options={options}
        rows={WINTER_ROWS}
        selectedLayers={selectedLayers}
        onLayerToggle={onLayerToggle}
      />
    );
  }
  return (
    <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
      {options.map((option) => (
        <ParameterOptionControl
          key={option.key}
          option={option}
          selected={selectedLayers.has(option.key)}
          onToggle={onLayerToggle}
        />
      ))}
    </div>
  );
}

function ParameterSlotGrid({
  options,
  rows,
  selectedLayers,
  onLayerToggle,
}: {
  options: LayerDefinition[];
  rows: ParameterGridSlot[][];
  selectedLayers: Set<LayerKey>;
  onLayerToggle: (layer: LayerKey) => void;
}) {
  const slottedKeys = new Set(rows.flat().map((slot) => slot.key));
  const optionByKey = new Map<string, LayerDefinition>();
  const unmatched: LayerDefinition[] = [];
  for (const option of options) {
    if (!slottedKeys.has(String(option.key))) {
      unmatched.push(option);
      continue;
    }
    optionByKey.set(String(option.key), option);
  }
  const columnCount = Math.max(1, ...rows.map((row) => row.length), unmatched.length > 0 ? 2 : 1);

  return (
    <div
      className="grid w-full gap-x-2 gap-y-1"
      style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(10.5rem, 1fr))` }}
    >
      {rows.flatMap((row, rowIndex) =>
        Array.from({ length: columnCount }, (_, columnIndex) => {
          const slot = row[columnIndex] || null;
          if (!slot) {
            return <div key={`empty-${rowIndex}-${columnIndex}`} className="min-h-7" aria-hidden="true" />;
          }
          const option = optionByKey.get(slot.key) || {
            key: slot.key,
            label: slot.placeholderLabel || slot.key,
            unit: null,
            available: false,
          };
          return (
            <ParameterOptionControl
              key={option.key}
              option={option}
              selected={selectedLayers.has(option.key)}
              onToggle={onLayerToggle}
            />
          );
        }),
      )}
      {unmatched.map((option) => (
        <ParameterOptionControl
          key={option.key}
          option={option}
          selected={selectedLayers.has(option.key)}
          onToggle={onLayerToggle}
        />
      ))}
    </div>
  );
}

function ParameterOptionControl({
  option,
  selected,
  onToggle,
}: {
  option: LayerDefinition;
  selected: boolean;
  onToggle: (layer: LayerKey) => void;
}) {
  const disabled = option.available === false && !selected;
  const caveat = getParameterCaveat(String(option.key));
  const tooltip = buildParameterOptionTooltip(option, caveat);
  const hasMethodDetails = Boolean(
    option.sourceNote ||
    option.derivation ||
    option.formulaReference ||
    option.methodVersion ||
    option.applicability ||
    option.thresholdNote,
  );
  return (
    <label
      title={tooltip}
      className={`flex min-h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs ${
        disabled
          ? "cursor-not-allowed text-slate-500 opacity-55"
          : selected
            ? "cursor-pointer bg-cyan-400/12 text-cyan-100"
            : "cursor-pointer text-slate-200 hover:bg-white/[0.06]"
      }`}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={disabled}
        onChange={() => onToggle(option.key)}
        className="h-3.5 w-3.5 accent-cyan-300"
      />
      <span
        title={tooltip}
        className={`min-w-0 flex-1 truncate ${
          hasMethodDetails ? "decoration-dotted underline-offset-2 hover:underline" : ""
        }`}
      >
        {option.label}
      </span>
      {caveat ? (
        // Decorative marker: the caveat text itself is announced via the row
        // tooltip line ("Note: …"), so the glyph stays out of the a11y tree.
        <span
          className="shrink-0 cursor-help text-[10px] leading-none text-amber-300/80"
          title={caveat}
          aria-hidden="true"
          data-caveat-key={String(option.key)}
        >
          ⓘ
        </span>
      ) : null}
      {option.unit ? (
        <span className="shrink-0 text-[10px] text-slate-500">{formatUnitDisplay(option.unit)}</span>
      ) : null}
    </label>
  );
}

function buildParameterOptionTooltip(option: LayerDefinition, caveat: string | null = null): string {
  const lines = [option.label];
  if (caveat) {
    lines.push(`Note: ${caveat}`);
  }
  if (option.sourceNote) {
    lines.push(`Source: ${option.sourceNote}`);
  }
  if (option.derivation) {
    lines.push(`Derived: ${option.derivation}`);
  }
  if (option.applicability) {
    lines.push(`Applies: ${option.applicability}`);
  }
  if (option.formulaReference) {
    lines.push(`Reference: ${option.formulaReference}`);
  }
  if (option.thresholdNote) {
    lines.push(`Display: ${option.thresholdNote}`);
  }
  if (option.methodVersion) {
    lines.push(`Method: ${option.methodVersion}`);
  }
  if (option.available === false) {
    lines.push("Not available for this model/run.");
  }
  return lines.join("\n");
}

function formatRunOptionLabel(run: RunManifestPointer): string {
  const frameCount = Number(run.frameCount) || 0;
  const loadedFrameCount = Number(run.loadedFrameCount ?? frameCount) || 0;
  const countLabel = frameCount > 0 ? ` ${loadedFrameCount}/${frameCount}` : "";
  return `${formatRunId(run.run)}${countLabel}`;
}

function formatRunId(runId: string): string {
  const match = String(runId).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})00Z$/);
  if (!match) {
    return runId;
  }
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}z`;
}

function StatusBadge({ status }: { status: PanelStatus }) {
  return (
    <span
      data-testid="panel-status"
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${statusTextClass[status.kind]}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDotClass[status.kind]}`} />
      {status.label}
    </span>
  );
}

const runAgeChipClass: Record<"fresh" | "aging" | "stale", string> = {
  fresh: "border-emerald-400/30 bg-emerald-500/10 text-emerald-100",
  aging: "border-amber-400/35 bg-amber-500/12 text-amber-100",
  stale: "border-rose-400/35 bg-rose-500/12 text-rose-100",
};

function RunAgeChip({
  modelKey,
  referenceTime,
  currentRunId,
  runOptions,
}: {
  modelKey: ModelKey;
  referenceTime: string | null;
  currentRunId: string | null;
  runOptions: RunManifestPointer[];
}) {
  const { ageHours, level } = computeRunStaleness({
    referenceTime,
    cycleHours: MODEL_CONFIG[modelKey].cycleHours,
  });
  if (ageHours === null) {
    return null;
  }
  const rounded = ageHours < 1 ? "<1" : String(Math.round(ageHours));
  const newerAvailable = hasLaterBuiltRun(currentRunId, runOptions);
  const title = newerAvailable ? "A newer built run is available in the run picker" : "Run age since reference time";
  return (
    <span
      data-testid="run-age-chip"
      title={title}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${runAgeChipClass[level]}`}
    >
      {rounded}h old{newerAvailable ? " · newer available" : ""}
    </span>
  );
}

function hasLaterBuiltRun(currentRunId: string | null, runOptions: RunManifestPointer[]): boolean {
  const currentEpoch = runIdEpoch(currentRunId);
  return Number.isFinite(currentEpoch) && runOptions.some((run) => runIdEpoch(run.run) > currentEpoch);
}

function runIdEpoch(runId: string | null): number {
  const match = String(runId || "").match(/^(\d{4})(\d{2})(\d{2})-(\d{2})00Z$/);
  if (!match) {
    return Number.NaN;
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]));
}

function frameStatusLabel(status: FrameHourStatus): string {
  if (status === "loaded") return "Ready";
  if (status === "loading") return "Loading";
  if (status === "error") return "Error";
  if (status === "unavailable") return "Unavailable";
  return "Pending";
}

function frameStatusDotClass(status: FrameHourStatus): string {
  if (status === "loaded") return "bg-cyan-300";
  if (status === "loading") return "bg-sky-300";
  if (status === "error") return "bg-rose-300";
  if (status === "unavailable") return "bg-slate-600";
  return "bg-slate-400";
}
