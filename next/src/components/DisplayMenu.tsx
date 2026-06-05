import {
  DISPLAY_BOUNDARY_COLORS,
  DISPLAY_PRESETS,
  type BoundaryDisplayMode,
  type DisplayBasemapKey,
  type DisplayPresetKey,
  type MapDisplaySettings,
  cloneDisplaySettings,
  normalizeDisplaySettings,
} from "../config/display";

interface DisplayMenuProps {
  display: MapDisplaySettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (display: MapDisplaySettings) => void;
}

const PRESET_KEYS = Object.keys(DISPLAY_PRESETS) as Exclude<DisplayPresetKey, "custom">[];

export default function DisplayMenu({ display, open, onOpenChange, onChange }: DisplayMenuProps) {
  const applyPreset = (preset: Exclude<DisplayPresetKey, "custom">) => {
    onChange(cloneDisplaySettings(DISPLAY_PRESETS[preset]));
  };
  const updateCustom = (next: Partial<MapDisplaySettings>) => {
    onChange(
      normalizeDisplaySettings({
        ...display,
        ...next,
        preset: "custom",
      }),
    );
  };
  const updateNested = <K extends keyof MapDisplaySettings>(key: K, value: Partial<MapDisplaySettings[K]>) => {
    updateCustom({
      [key]: {
        ...(display[key] as object),
        ...value,
      },
    } as Partial<MapDisplaySettings>);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium active:scale-95 ${
          open
            ? "border-cyan-400/30 bg-cyan-500/20 text-cyan-300"
            : "border-white/[0.06] bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]"
        }`}
        aria-expanded={open}
      >
        Display
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => onOpenChange(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-1rem))] rounded-lg border border-white/[0.08] bg-slate-950/90 p-3 shadow-2xl shadow-slate-950/60 backdrop-blur-xl">
            <div className="mb-3 flex gap-1 rounded-lg border border-white/[0.06] bg-white/[0.03] p-1">
              {PRESET_KEYS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className={`min-w-0 flex-1 rounded-md px-2 py-1 text-[11px] font-semibold capitalize active:scale-95 ${
                    display.preset === preset
                      ? "bg-cyan-400/18 text-cyan-100 shadow-sm shadow-cyan-950/20"
                      : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-100"
                  }`}
                >
                  {preset}
                </button>
              ))}
              {display.preset === "custom" ? (
                <span className="rounded-md bg-white/[0.06] px-2 py-1 text-[11px] font-semibold text-slate-200">
                  Custom
                </span>
              ) : null}
            </div>

            <div className="grid gap-3">
              <div className="grid gap-2 border-b border-white/[0.06] pb-3">
                <MenuSelect
                  label="Basemap"
                  value={display.basemap}
                  onChange={(value) => updateCustom({ basemap: value as DisplayBasemapKey })}
                  options={[
                    { value: "light", label: "Light" },
                    { value: "topographic", label: "Topographic" },
                  ]}
                />
                <MenuCheckbox
                  label="Labels"
                  checked={display.labels.visible}
                  onChange={(visible) => updateNested("labels", { visible })}
                />
                <MenuSlider
                  label="Label Opacity"
                  value={display.labels.opacity}
                  onChange={(opacity) => updateNested("labels", { opacity })}
                  min={0}
                  max={100}
                  step={5}
                  unit="%"
                  disabled={!display.labels.visible}
                />
              </div>

              <div className="grid gap-2 border-b border-white/[0.06] pb-3">
                <MenuSlider
                  label="Weather Opacity"
                  value={display.weather.opacity}
                  onChange={(opacity) => updateNested("weather", { opacity })}
                  min={0}
                  max={100}
                  step={5}
                  unit="%"
                />
                <MenuSlider
                  label="Synoptic Opacity"
                  value={display.synoptic.opacity}
                  onChange={(opacity) => updateNested("synoptic", { opacity })}
                  min={0}
                  max={100}
                  step={5}
                  unit="%"
                />
              </div>

              <div className="grid gap-2">
                <MenuSelect
                  label="Borders"
                  value={display.boundaries.mode}
                  onChange={(mode) => updateNested("boundaries", { mode: mode as BoundaryDisplayMode })}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "reference", label: "Reference" },
                    { value: "basemap", label: "Basemap" },
                    { value: "off", label: "Off" },
                  ]}
                />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] text-slate-400">Border Color</span>
                  <div className="flex gap-1.5">
                    {DISPLAY_BOUNDARY_COLORS.map((color) => (
                      <button
                        key={color.value}
                        type="button"
                        title={color.label}
                        aria-label={color.label}
                        onClick={() => updateNested("boundaries", { color: color.value })}
                        className={`h-5 w-5 rounded-full border-2 active:scale-90 ${
                          display.boundaries.color === color.value ? "border-cyan-300" : "border-white/20"
                        }`}
                        style={{ backgroundColor: color.value }}
                      />
                    ))}
                  </div>
                </div>
                <MenuSlider
                  label="Country Opacity"
                  value={display.boundaries.countryOpacity}
                  onChange={(countryOpacity) => updateNested("boundaries", { countryOpacity })}
                  min={0}
                  max={100}
                  step={5}
                  unit="%"
                  disabled={display.boundaries.mode === "basemap" || display.boundaries.mode === "off"}
                />
                <MenuSlider
                  label="Country Weight"
                  value={display.boundaries.countryWeight}
                  onChange={(countryWeight) => updateNested("boundaries", { countryWeight })}
                  min={0.5}
                  max={3}
                  step={0.1}
                  unit="px"
                  disabled={display.boundaries.mode === "basemap" || display.boundaries.mode === "off"}
                />
                <MenuSlider
                  label="State Opacity"
                  value={display.boundaries.stateOpacity}
                  onChange={(stateOpacity) => updateNested("boundaries", { stateOpacity })}
                  min={0}
                  max={100}
                  step={5}
                  unit="%"
                  disabled={display.boundaries.mode !== "reference"}
                />
                <MenuSlider
                  label="State Weight"
                  value={display.boundaries.stateWeight}
                  onChange={(stateWeight) => updateNested("boundaries", { stateWeight })}
                  min={0.25}
                  max={2}
                  step={0.05}
                  unit="px"
                  disabled={display.boundaries.mode !== "reference"}
                />
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function MenuSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="text-[11px] text-slate-400">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 rounded-lg border border-white/[0.08] bg-slate-950/80 px-2 text-xs text-slate-100 outline-none hover:border-white/20 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-slate-950">
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function MenuCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="text-[11px] text-slate-400">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-cyan-400"
      />
    </label>
  );
}

function MenuSlider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  unit: string;
  disabled?: boolean;
}) {
  return (
    <label className={`grid gap-1 ${disabled ? "opacity-45" : ""}`}>
      <span className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-slate-400">{label}</span>
        <span className="text-[11px] tabular-nums text-slate-300">{formatSliderValue(value, unit)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onInput={(event) => onChange(Number(event.currentTarget.value))}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-3 w-full disabled:cursor-not-allowed"
      />
    </label>
  );
}

function formatSliderValue(value: number, unit: string): string {
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${formatted}${unit}`;
}
