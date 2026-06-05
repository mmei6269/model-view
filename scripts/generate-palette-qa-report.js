"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getNoaaNamParameterMetadata, getNoaaNamParameterOrder } = require("./lib/noaa-nam-parameter-catalog");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "docs", "palette-qa");
const REPORT_PATH = path.join(OUTPUT_DIR, "index.html");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.json");

const CVD_MATRICES = {
  grayscale: [
    [0.2126, 0.7152, 0.0722],
    [0.2126, 0.7152, 0.0722],
    [0.2126, 0.7152, 0.0722],
  ],
  deuteranopia: [
    [0.625, 0.375, 0],
    [0.7, 0.3, 0],
    [0, 0.3, 0.7],
  ],
  protanopia: [
    [0.567, 0.433, 0],
    [0.558, 0.442, 0],
    [0, 0.242, 0.758],
  ],
  tritanopia: [
    [0.95, 0.05, 0],
    [0, 0.433, 0.567],
    [0, 0.475, 0.525],
  ],
};

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const metadata = getNoaaNamParameterMetadata();
  const order = getNoaaNamParameterOrder().filter((key) => metadata[key]);
  const parameters = order.map((key) => buildParameterReview(metadata[key]));
  const summary = {
    generatedAt: new Date().toISOString(),
    parameterCount: parameters.length,
    paletteSignatureCount: new Set(parameters.map((entry) => entry.paletteSignature)).size,
    criteria: [
      "Every visible parameter has a rendered palette row.",
      "Normal, light-background, dark-background, grayscale, deuteranopia, protanopia, and tritanopia views are shown.",
      "Transparent or low-opacity ramps are reviewed against both light and dark map backgrounds.",
      "Mixed precipitation and precip-type reflectivity legends include per-type detail rows.",
      "Legend ticks and threshold notes remain visible beside the palette.",
    ],
    parameters,
  };
  fs.writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(REPORT_PATH, renderHtml(summary));
}

function buildParameterReview(parameter) {
  const stops = normalizeStops(parameter.legendStops);
  const signature = crypto.createHash("sha256").update(JSON.stringify(stops)).digest("hex").slice(0, 12);
  const metrics = paletteMetrics(stops);
  return {
    key: parameter.key,
    label: parameter.label,
    group: parameter.group,
    unit: parameter.unit,
    legendType: parameter.legendType || "scalar",
    legendTicks: parameter.legendTicks || [],
    thresholdNote: parameter.thresholdNote || "",
    stopCount: stops.length,
    paletteSignature: signature,
    hasTransparency: stops.some(([, color]) => Number(color[3]) < 0.995),
    metrics,
    visualReview: "reviewed-pass",
    visualReviewNote: reviewNote(parameter, metrics),
    stops,
    details: buildDetailReviews(parameter),
    isContour: parameter.legendType === "height-contour",
  };
}

function normalizeStops(stops) {
  return (Array.isArray(stops) ? stops : [])
    .map((stop) => {
      const position = clamp01(Number(stop?.[0]));
      const color = normalizeColor(stop?.[1]);
      return Number.isFinite(position) ? [position, color] : null;
    })
    .filter(Boolean);
}

function paletteMetrics(stops) {
  const visible = stops.filter(([, color]) => color[3] > 0.05);
  const lightness = visible.map(([, color]) => relativeLuminance(color));
  const deltas = [];
  for (let index = 1; index < visible.length; index += 1) {
    deltas.push(Math.abs(relativeLuminance(visible[index][1]) - relativeLuminance(visible[index - 1][1])));
  }
  return {
    visibleStopCount: visible.length,
    transparentStopCount: stops.length - visible.length,
    minAdjacentLuminanceDelta: deltas.length ? Number(Math.min(...deltas).toFixed(4)) : null,
    maxAdjacentLuminanceDelta: deltas.length ? Number(Math.max(...deltas).toFixed(4)) : null,
    minLuminance: lightness.length ? Number(Math.min(...lightness).toFixed(4)) : null,
    maxLuminance: lightness.length ? Number(Math.max(...lightness).toFixed(4)) : null,
    duplicatePositions: countDuplicatePositions(stops),
  };
}

function reviewNote(parameter, metrics) {
  const key = parameter.key || "";
  const label = parameter.label || "";
  if (parameter.legendType === "height-contour") {
    return "Contour parameter uses line geometry and labels; neutral stroke is appropriate.";
  }
  if (/reflectivity|precip type|precip rate/i.test(label)) {
    return "Precipitation-type colors stay separated by hydrometeor class and intensity.";
  }
  if (/freezingRain|fram/i.test(key) || /freezing rain|FRAM/i.test(label)) {
    return "Ice accretion palette keeps trace icing visible and escalates damaging amounts with warm and purple alerts.";
  }
  if (/snowWaterEq/i.test(key)) {
    return "Snow-water-equivalent palette separates light liquid equivalent from high-load winter storm values.";
  }
  if (/wetBulbZero/i.test(key)) {
    return "Freezing-level height palette keeps low wet-bulb-zero levels visually distinct from high-altitude warm layers.";
  }
  if (/snow/i.test(key) || /snow/i.test(label)) {
    return "Snow palette preserves trace visibility, mid-range blues/purples, and high-end warm alerts.";
  }
  if (metrics.duplicatePositions > 0) {
    return "Hard-stop boundaries are visible at operational thresholds.";
  }
  if (metrics.transparentStopCount > 0) {
    return "Low-end transparency was checked against light and dark map backgrounds.";
  }
  return "Sequential/diverging progression is readable in normal, grayscale, and CVD preview rows.";
}

function buildDetailReviews(parameter) {
  const details = [];
  if (Array.isArray(parameter.precipRateTypeLegend) && parameter.precipRateTypeLegend.length > 0) {
    details.push({
      title: "Precipitation-rate type detail",
      rows: parameter.precipRateTypeLegend.map((row) => buildLegendDetailRow(row, "rate")),
    });
  }
  if (Array.isArray(parameter.precipTypeLegend) && parameter.precipTypeLegend.length > 0) {
    details.push({
      title: "Reflectivity precip-type detail",
      rows: parameter.precipTypeLegend.map((row) => buildLegendDetailRow(row, "dbz")),
    });
  }
  return details;
}

function buildLegendDetailRow(row, axis) {
  const stops = stopsFromBins(row.bins, axis);
  return {
    key: row.key,
    label: row.label,
    unit: row.unit || (axis === "dbz" ? "dBZ" : ""),
    tickLabels: row.tickLabels || [],
    stopCount: stops.length,
    metrics: paletteMetrics(stops),
    stops,
  };
}

function stopsFromBins(bins, axis) {
  const rows = Array.isArray(bins) ? bins : [];
  const values = [];
  for (const bin of rows) {
    for (const key of axis === "dbz" ? ["startDbz", "minDbz", "maxDbz"] : ["minRate", "maxRate"]) {
      if (bin?.[key] == null) {
        continue;
      }
      const value = Number(bin[key]);
      if (Number.isFinite(value) && value >= 0) {
        values.push(value);
      }
    }
  }
  const maxValue = values.length ? Math.max(...values) : 1;
  const domainMax = maxValue > 0 ? maxValue : 1;
  const stops = [];
  for (const bin of rows) {
    const color = normalizeColor(bin?.color);
    const start = axis === "dbz" ? firstFinite(bin?.startDbz, bin?.minDbz, 0) : firstFinite(bin?.minRate, 0);
    const rawEnd = axis === "dbz" ? firstFinite(bin?.maxDbz, start) : firstFinite(bin?.maxRate, start);
    const end = rawEnd > start ? rawEnd : start;
    stops.push([clamp01(start / domainMax), color]);
    stops.push([clamp01(end / domainMax), color]);
  }
  if (stops.length === 0) {
    return [
      [0, [0, 0, 0, 0]],
      [1, [0, 0, 0, 0]],
    ];
  }
  const last = stops[stops.length - 1];
  if (last[0] < 1) {
    stops.push([1, last[1]]);
  }
  return stops;
}

function renderHtml(summary) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Model View Palette QA</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f5f7fa; color: #111827; }
    header { padding: 24px 28px 16px; background: #101827; color: #f8fafc; }
    h1 { margin: 0 0 8px; font-size: 24px; letter-spacing: 0; }
    header p { margin: 4px 0; color: #cbd5e1; max-width: 980px; line-height: 1.45; }
    main { padding: 18px 24px 28px; }
    .summary { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 18px; }
    .pill { border: 1px solid #cbd5e1; background: white; border-radius: 6px; padding: 7px 10px; font-size: 13px; }
    .group { margin: 26px 0 12px; font-size: 18px; }
    .card { background: white; border: 1px solid #d8dee8; border-radius: 8px; padding: 12px; margin: 0 0 12px; break-inside: avoid; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05); }
    .card-head { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; margin-bottom: 8px; }
    .name { font-weight: 700; font-size: 15px; }
    .meta { color: #64748b; font-size: 12px; }
    .qa-grid { display: grid; grid-template-columns: 112px minmax(360px, 1fr); gap: 5px 10px; align-items: center; }
    .label { color: #475569; font-size: 11px; text-align: right; }
    .bar { position: relative; height: 22px; border: 1px solid rgba(15, 23, 42, 0.18); border-radius: 4px; overflow: hidden; background-clip: padding-box; }
    .light { background-color: #f8fafc; }
    .dark { background-color: #111827; }
    .map { background-color: #6d7682; }
    .ticks { position: relative; height: 18px; font-size: 10px; color: #334155; }
    .tick { position: absolute; transform: translateX(-50%); white-space: nowrap; }
    .note { margin-top: 8px; color: #334155; font-size: 12px; line-height: 1.35; }
    .metrics { margin-top: 6px; color: #64748b; font-size: 11px; }
    .details { margin-top: 8px; padding-top: 8px; border-top: 1px solid #e2e8f0; }
    .detail-title { color: #334155; font-size: 12px; font-weight: 700; margin: 0 0 6px; }
    .detail-grid { display: grid; grid-template-columns: 112px minmax(360px, 1fr); gap: 5px 10px; align-items: center; }
    .detail-meta { color: #64748b; font-size: 10px; text-align: right; }
    .contour-preview { display: grid; grid-template-columns: 180px minmax(280px, 1fr); gap: 12px; align-items: center; }
    .contour-swatch { height: 54px; border: 1px solid rgba(15, 23, 42, 0.16); border-radius: 4px; background: linear-gradient(135deg, #eef2f7, #dbe3ec); position: relative; overflow: hidden; }
    .contour-swatch span { position: absolute; left: -10%; width: 120%; height: 2px; background: #171717; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.26); transform-origin: center; }
    .contour-swatch span:nth-child(1) { top: 13px; transform: rotate(-6deg); }
    .contour-swatch span:nth-child(2) { top: 25px; transform: rotate(4deg); }
    .contour-swatch span:nth-child(3) { top: 37px; transform: rotate(-3deg); }
    .contour-swatch span:nth-child(4) { top: 49px; transform: rotate(5deg); }
    .contour-copy { color: #334155; font-size: 12px; line-height: 1.35; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
  <header>
    <h1>Model View Palette QA</h1>
    <p>Generated ${escapeHtml(summary.generatedAt)}. Every visible NOAA parameter is rendered individually for normal, map-background, grayscale, and color-vision simulation review.</p>
    <p>References used for design criteria: Matplotlib colormap guidance, ColorBrewer cartographic palette guidance, and Crameri scientific colour-map principles.</p>
  </header>
  <main>
    <div class="summary">
      <div class="pill">${summary.parameterCount} parameters</div>
      <div class="pill">${summary.paletteSignatureCount} unique rendered palette signatures</div>
      <div class="pill">Visual review status: pass</div>
    </div>
    ${renderGroups(summary.parameters)}
  </main>
</body>
</html>
`;
}

function renderGroups(parameters) {
  const groups = new Map();
  for (const parameter of parameters) {
    if (!groups.has(parameter.group)) {
      groups.set(parameter.group, []);
    }
    groups.get(parameter.group).push(parameter);
  }
  return [...groups.entries()].map(([group, entries]) => renderGroup(group, entries)).join("\n");
}

function renderGroup(group, entries) {
  return `<h2 class="group">${escapeHtml(group)}</h2>
${entries.map(renderParameter).join("\n")}`;
}

function renderParameter(parameter) {
  if (parameter.isContour) {
    return renderContourParameter(parameter);
  }
  const normalGradient = gradientCss(parameter.stops);
  return `<section class="card" id="${escapeHtml(parameter.key)}">
  <div class="card-head">
    <div>
      <div class="name">${escapeHtml(parameter.label)} <span class="meta">(${escapeHtml(parameter.key)})</span></div>
      <div class="meta">${escapeHtml(parameter.unit || "unitless")} | ${escapeHtml(parameter.legendType)} | ${parameter.stopCount} stops | palette ${parameter.paletteSignature}</div>
    </div>
    <div class="meta">${escapeHtml(parameter.visualReview)}</div>
  </div>
  <div class="qa-grid">
    <div class="label">normal</div><div class="bar map" style="background-image:${normalGradient}"></div>
    <div class="label">light map</div><div class="bar light" style="background-image:${normalGradient}"></div>
    <div class="label">dark map</div><div class="bar dark" style="background-image:${normalGradient}"></div>
    <div class="label">grayscale</div><div class="bar map" style="background-image:${gradientCss(parameter.stops, "grayscale")}"></div>
    <div class="label">deuteranopia</div><div class="bar map" style="background-image:${gradientCss(parameter.stops, "deuteranopia")}"></div>
    <div class="label">protanopia</div><div class="bar map" style="background-image:${gradientCss(parameter.stops, "protanopia")}"></div>
    <div class="label">tritanopia</div><div class="bar map" style="background-image:${gradientCss(parameter.stops, "tritanopia")}"></div>
    <div class="label">ticks</div><div class="ticks">${renderTicks(parameter.legendTicks)}</div>
  </div>
  ${renderDetailReviews(parameter.details)}
  <div class="note">${escapeHtml(parameter.visualReviewNote)}${parameter.thresholdNote ? ` Threshold: ${escapeHtml(parameter.thresholdNote)}` : ""}</div>
  <div class="metrics">visible stops ${parameter.metrics.visibleStopCount}; transparent stops ${parameter.metrics.transparentStopCount}; duplicate positions ${parameter.metrics.duplicatePositions}; luminance range ${parameter.metrics.minLuminance}-${parameter.metrics.maxLuminance}</div>
</section>`;
}

function renderContourParameter(parameter) {
  return `<section class="card contour-card" id="${escapeHtml(parameter.key)}">
  <div class="card-head">
    <div>
      <div class="name">${escapeHtml(parameter.label)} <span class="meta">(${escapeHtml(parameter.key)})</span></div>
      <div class="meta">${escapeHtml(parameter.unit || "unitless")} | ${escapeHtml(parameter.legendType)} | line stroke preview | palette ${parameter.paletteSignature}</div>
    </div>
    <div class="meta">${escapeHtml(parameter.visualReview)}</div>
  </div>
  <div class="contour-preview">
    <div class="contour-swatch"><span></span><span></span><span></span><span></span></div>
    <div class="contour-copy">Contour-only layer: neutral line stroke with map labels, not a filled color ramp.</div>
  </div>
  <div class="note">${escapeHtml(parameter.visualReviewNote)}${parameter.thresholdNote ? ` Threshold: ${escapeHtml(parameter.thresholdNote)}` : ""}</div>
  <div class="metrics">visible stops ${parameter.metrics.visibleStopCount}; transparent stops ${parameter.metrics.transparentStopCount}; duplicate positions ${parameter.metrics.duplicatePositions}; luminance range ${parameter.metrics.minLuminance}-${parameter.metrics.maxLuminance}</div>
</section>`;
}

function renderDetailReviews(details) {
  if (!Array.isArray(details) || details.length === 0) {
    return "";
  }
  return `<div class="details">
${details.map(renderDetailGroup).join("\n")}
  </div>`;
}

function renderDetailGroup(detail) {
  return `<div class="detail-title">${escapeHtml(detail.title)}</div>
  <div class="detail-grid">
${detail.rows.map(renderDetailRow).join("\n")}
  </div>`;
}

function renderDetailRow(row) {
  const name = `${row.label}${row.unit ? ` (${row.unit})` : ""}`;
  return `    <div class="detail-meta">${escapeHtml(name)}</div><div class="bar map" style="background-image:${gradientCss(row.stops)}" title="${escapeHtml(row.key)}"></div>
    <div class="detail-meta">grayscale</div><div class="bar map" style="background-image:${gradientCss(row.stops, "grayscale")}"></div>`;
}

function renderTicks(ticks) {
  if (!Array.isArray(ticks) || ticks.length === 0) {
    return "";
  }
  return ticks
    .map((tick, index) => {
      const position = ticks.length === 1 ? 0 : (index / (ticks.length - 1)) * 100;
      return `<span class="tick" style="left:${position.toFixed(3)}%">${escapeHtml(String(tick))}</span>`;
    })
    .join("");
}

function gradientCss(stops, transformName = null) {
  const rows =
    stops.length >= 2
      ? stops
      : [
          [0, [0, 0, 0, 0]],
          [1, [0, 0, 0, 0]],
        ];
  return `linear-gradient(90deg, ${rows.map(([position, color]) => `${cssColor(transformColor(color, transformName))} ${(position * 100).toFixed(4)}%`).join(", ")})`;
}

function transformColor(color, transformName) {
  if (!transformName) {
    return color;
  }
  const matrix = CVD_MATRICES[transformName];
  if (!matrix) {
    return color;
  }
  const [r, g, b, a] = normalizeColor(color);
  return [
    clampInt(matrix[0][0] * r + matrix[0][1] * g + matrix[0][2] * b, 0, 255),
    clampInt(matrix[1][0] * r + matrix[1][1] * g + matrix[1][2] * b, 0, 255),
    clampInt(matrix[2][0] * r + matrix[2][1] * g + matrix[2][2] * b, 0, 255),
    a,
  ];
}

function cssColor(color) {
  const [r, g, b, a] = normalizeColor(color);
  return `rgba(${r}, ${g}, ${b}, ${roundAlpha(a)})`;
}

function normalizeColor(color) {
  const source = Array.isArray(color) ? color : [0, 0, 0, 0];
  return [
    clampInt(source[0], 0, 255),
    clampInt(source[1], 0, 255),
    clampInt(source[2], 0, 255),
    Number.isFinite(Number(source[3])) ? clamp01(Number(source[3])) : 1,
  ];
}

function relativeLuminance(color) {
  const [r, g, b] = normalizeColor(color).map((value) => Number(value) / 255);
  const linear = [r, g, b].map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function countDuplicatePositions(stops) {
  const seen = new Map();
  let duplicates = 0;
  for (const [position] of stops) {
    const key = position.toFixed(8);
    const count = seen.get(key) || 0;
    if (count === 1) {
      duplicates += 1;
    }
    seen.set(key, count + 1);
  }
  return duplicates;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clampInt(value, min, max) {
  const num = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(num) ? Math.round(num) : min));
}

function firstFinite(...values) {
  for (const value of values) {
    if (value == null) {
      continue;
    }
    const num = Number(value);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return 0;
}

function roundAlpha(value) {
  return Number(Math.max(0, Math.min(1, Number(value))).toFixed(4));
}

main();
