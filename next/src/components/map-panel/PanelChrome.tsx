import { MODEL_CONFIG, MODEL_KEYS } from "../../config/constants";
import type {
  FrameHourStatus,
  LayerDefinition,
  LayerKey,
  ModelKey,
  RunManifestPointer,
  ValidTimeIso,
} from "../../types";
import { hourChipClass } from "./format-utils";

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
  status: PanelStatus;
  loadedCount: number;
  totalHours: number;
  runLabel: string;
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
  status,
  loadedCount,
  totalHours,
  runLabel,
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
  const frameLabel = frameHour === null ? "F---" : `F${String(frameHour).padStart(3, "0")}`;
  const selectedRunMissing = selectedRunId && !runOptions.some((run) => run.run === selectedRunId);

  return (
    <div className="pointer-events-auto w-fit max-w-full rounded-lg border border-white/[0.08] bg-slate-900/[0.72] px-3 py-2 shadow-lg shadow-slate-950/35 backdrop-blur-xl">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className="text-lg font-semibold leading-none text-slate-50">{MODEL_CONFIG[modelKey].label}</h2>
          <StatusBadge status={status} />
        </div>

        <select
          value={modelKey}
          onChange={(event) => onModelChange(event.target.value as ModelKey)}
          className="h-8 rounded-lg border border-white/[0.12] bg-slate-950/[0.88] px-2.5 text-xs font-medium text-slate-100 shadow-inner shadow-black/20 outline-none hover:border-white/20 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20"
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
          className="h-8 max-w-44 rounded-lg border border-white/[0.12] bg-slate-950/[0.88] px-2.5 text-xs font-medium text-slate-100 shadow-inner shadow-black/20 outline-none hover:border-white/20 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20"
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
          className={`h-8 rounded-lg border px-2.5 text-xs font-semibold active:scale-95 ${
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
          className={`h-8 rounded-lg border px-2.5 text-xs font-semibold active:scale-95 ${
            menuOpen
              ? "border-cyan-300/40 bg-cyan-400/20 text-cyan-100"
              : "border-white/[0.12] bg-white/[0.06] text-slate-200 hover:bg-white/[0.1]"
          }`}
          aria-expanded={menuOpen}
        >
          Frames {loadedCount}/{totalHours}
        </button>

        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="h-8 rounded-lg border border-rose-400/35 bg-rose-500/10 px-2.5 text-xs font-semibold text-rose-100 hover:bg-rose-500/20 active:scale-95"
          >
            Remove
          </button>
        ) : null}
      </div>

      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] leading-4 text-slate-200/90">
        <span className="min-w-0 truncate">Run {runLabel}</span>
        <span className="rounded border border-white/[0.08] bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-slate-100">
          {frameLabel}
        </span>
        <span className="min-w-0 truncate">Valid {validLabel}</span>
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
                className={hourChipClass(option.status, option.selected)}
              >
                {String(option.hour).padStart(3, "0")}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
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
    { key: "surfaceBasedLclHeight", placeholderLabel: "Surface LCL" },
    { key: "surfaceThetaE", placeholderLabel: "Surface Theta-e" },
  ],
  [
    { key: "lapseRate700to500", placeholderLabel: "700-500 LR" },
    { key: "lapseRate0to3km", placeholderLabel: "0-3 km LR" },
  ],
  [{ key: "maxSimulatedHailSize", placeholderLabel: "Max Hail Size" }],
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
    { key: "updraftHelicity2to5km1h", placeholderLabel: "2-5 km UH" },
    { key: "updraftHelicity2to5kmRunMax", placeholderLabel: "UH Run Max" },
  ],
];

const WINTER_ROWS: ParameterGridSlot[][] = [
  [
    { key: "wetBulbZeroHeight", placeholderLabel: "Wet Bulb Zero" },
    { key: "freezingRainLiquidTotal", placeholderLabel: "Freezing Rain Liquid" },
  ],
  [
    { key: "snowDepth", placeholderLabel: "Snow Depth" },
    { key: "snowWaterEq", placeholderLabel: "Snow Water Eq" },
  ],
  [
    { key: "snow10to1", placeholderLabel: "10:1 Snow" },
    { key: "snowKuchera", placeholderLabel: "Kuchera Snow" },
  ],
  [
    { key: "snowCobb", placeholderLabel: "Cobb Snow" },
    { key: "snowRfConus", placeholderLabel: "RF Snow" },
  ],
  [
    { key: "snowWesternLinear", placeholderLabel: "Western Linear Snow" },
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
  const tooltip = buildParameterOptionTooltip(option);
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
      {option.unit ? <span className="shrink-0 text-[10px] text-slate-500">{option.unit}</span> : null}
    </label>
  );
}

function buildParameterOptionTooltip(option: LayerDefinition): string {
  const lines = [option.label];
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
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${statusTextClass[status.kind]}`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDotClass[status.kind]}`} />
      {status.label}
    </span>
  );
}
