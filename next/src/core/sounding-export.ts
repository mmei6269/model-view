// Rasterize the sounding drawer's SVG charts (Skew-T + hodograph) to a PNG
// blob for download / clipboard. The charts style text via Tailwind classes,
// which a serialized SVG loses, so computed styles are inlined onto a clone
// before rasterization.

const INLINED_STYLE_PROPERTIES = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "font-size",
  "font-family",
  "font-weight",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
] as const;

// Parallel-walk source and clone (identical structure from cloneNode) and pin
// each element's computed style inline so the standalone SVG renders the same
// without the app stylesheet.
function inlineComputedStyles(source: Element, clone: Element): void {
  const computed = window.getComputedStyle(source);
  const inline: string[] = [];
  for (const property of INLINED_STYLE_PROPERTIES) {
    const value = computed.getPropertyValue(property);
    if (value && value !== "none" && value !== "normal" && value !== "auto") {
      inline.push(`${property}:${value}`);
    }
  }
  if (inline.length > 0) {
    clone.setAttribute("style", inline.join(";"));
  }
  clone.removeAttribute("class");
  const sourceChildren = source.children;
  const cloneChildren = clone.children;
  for (let index = 0; index < sourceChildren.length; index += 1) {
    if (cloneChildren[index]) {
      inlineComputedStyles(sourceChildren[index], cloneChildren[index]);
    }
  }
}

function svgViewBoxSize(svg: SVGSVGElement): { width: number; height: number } {
  const viewBox = svg.viewBox?.baseVal;
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    return { width: viewBox.width, height: viewBox.height };
  }
  const rect = svg.getBoundingClientRect();
  return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
}

function rasterizeSvg(svg: SVGSVGElement, width: number, height: number): Promise<HTMLImageElement> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(svg, clone);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const source = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" }));
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not rasterize the sounding chart."));
    };
    image.src = url;
  });
}

const EXPORT_SCALE = 2;
const EXPORT_GAP = 20;
const EXPORT_BACKGROUND = "#02060d";
const EXPORT_PROVENANCE_BACKGROUND = "#07111f";

export interface SoundingExportOptions {
  title?: string;
  provenanceLines?: string[];
}

// Compose the charts side by side (Skew-T left, hodograph right, top-aligned)
// on a dark canvas at 2x for crispness. Returns a PNG blob.
export async function renderSoundingChartsPng(
  svgs: SVGSVGElement[],
  options: SoundingExportOptions = {},
): Promise<Blob> {
  if (svgs.length === 0) {
    throw new Error("No sounding charts to export.");
  }
  const provenanceLines = (options.provenanceLines || [])
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .slice(0, 6);
  const provenanceHeight = provenanceLines.length > 0 ? 34 + provenanceLines.length * 16 : 0;
  const sizes = svgs.map(svgViewBoxSize);
  const totalWidth = sizes.reduce((sum, size) => sum + size.width, 0) + EXPORT_GAP * (svgs.length - 1);
  const chartHeight = Math.max(...sizes.map((size) => size.height));
  const totalHeight = chartHeight + provenanceHeight;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(totalWidth * EXPORT_SCALE);
  canvas.height = Math.round(totalHeight * EXPORT_SCALE);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D is unavailable in this browser.");
  }
  context.fillStyle = EXPORT_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(EXPORT_SCALE, EXPORT_SCALE);
  if (provenanceHeight > 0) {
    context.fillStyle = EXPORT_PROVENANCE_BACKGROUND;
    context.fillRect(0, 0, totalWidth, provenanceHeight);
    context.strokeStyle = "rgba(125, 211, 252, 0.24)";
    context.beginPath();
    context.moveTo(0, provenanceHeight - 0.5);
    context.lineTo(totalWidth, provenanceHeight - 0.5);
    context.stroke();
    context.fillStyle = "#f8fafc";
    context.font = "600 15px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    context.fillText(String(options.title || "Point sounding"), 16, 22);
    context.fillStyle = "#cbd5e1";
    context.font = "11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    for (let index = 0; index < provenanceLines.length; index += 1) {
      context.fillText(provenanceLines[index], 16, 42 + index * 16);
    }
  }
  let offsetX = 0;
  for (let index = 0; index < svgs.length; index += 1) {
    const { width, height } = sizes[index];
    const image = await rasterizeSvg(svgs[index], width, height);
    context.drawImage(image, offsetX, provenanceHeight, width, height);
    offsetX += width + EXPORT_GAP;
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("PNG encoding failed."));
      }
    }, "image/png");
  });
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a tick to start the download before revoking.
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

// Accepts the PNG as a promise so callers can invoke clipboard.write while
// the click's user activation is still live (Safari requires this; passing a
// promise as the ClipboardItem value is the standard pattern).
export async function copyPngToClipboard(blob: Blob | Promise<Blob>): Promise<void> {
  const clipboard = navigator.clipboard as Clipboard & {
    write?: (items: ClipboardItem[]) => Promise<void>;
  };
  if (!clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard is not available in this browser.");
  }
  await clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
