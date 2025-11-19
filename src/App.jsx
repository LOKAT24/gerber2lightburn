import React, { useState, useRef, useMemo } from "react";
import {
  Upload,
  Layers,
  Eye,
  EyeOff,
  ZoomIn,
  ZoomOut,
  Move,
  Trash2,
  Info,
  Download,
  Maximize,
} from "lucide-react";

/**
 * SIMPLE EXCELLON PARSER (DRILL FILES)
 */
class SimpleExcellonParser {
  constructor() {
    this.tools = {};
    this.currentTool = null;
    this.paths = [];
    this.units = "in";
    this.format = { inchDivisor: 10000, metricDivisor: 1000 };
  }

  parseCoordinate(val) {
    if (!val) return 0;
    let num = 0;

    if (val.includes(".")) {
      num = parseFloat(val);
    } else {
      const raw = parseFloat(val);
      const divisor =
        this.units === "in"
          ? this.format.inchDivisor
          : this.format.metricDivisor;
      num = raw / divisor;
    }

    if (this.units === "in") {
      return num * 25.4;
    }
    return num;
  }

  parseToolSize(val) {
    let size = parseFloat(val);
    if (this.units === "in") {
      return size * 25.4;
    }
    return size;
  }

  parse(text) {
    const lines = text.split(/[\n\r]+/);
    this.paths = [];
    this.tools = {};

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      if (line.includes("METRIC") || line.includes("M71")) this.units = "mm";
      if (line.includes("INCH") || line.includes("M72")) this.units = "in";

      const toolDefMatch = line.match(/T(\d+)[C|F]([\d.]+)/);
      if (toolDefMatch) {
        const code = parseInt(toolDefMatch[1], 10);
        const rawSize = toolDefMatch[2];
        this.tools[code] = {
          type: "C",
          params: [this.parseToolSize(rawSize)],
        };
        continue;
      }

      const toolSelectMatch = line.match(/^T(\d+)$/);
      if (toolSelectMatch) {
        const code = parseInt(toolSelectMatch[1], 10);
        if (this.tools[code]) this.currentTool = this.tools[code];
        continue;
      }

      if (line.startsWith("X") || line.startsWith("Y")) {
        const tMatch = line.match(/T(\d+)/);
        if (tMatch) {
          const code = parseInt(tMatch[1], 10);
          if (this.tools[code]) this.currentTool = this.tools[code];
        }

        const xMatch = line.match(/X([-+]?[\d.]+)/);
        const yMatch = line.match(/Y([-+]?[\d.]+)/);

        if (xMatch) this.x = this.parseCoordinate(xMatch[1]);
        if (yMatch) this.y = this.parseCoordinate(yMatch[1]);

        if (this.currentTool) {
          this.paths.push({
            x: this.x,
            y: this.y,
            aperture: this.currentTool,
            type: "flash",
          });
        }
      }
    }
    return this.paths;
  }
}

/**
 * SIMPLE GERBER PARSER
 */
class SimpleGerberParser {
  constructor() {
    this.apertures = {};
    this.currentAperture = null;
    this.x = 0;
    this.y = 0;
    this.paths = [];
    this.units = "mm";
    this.format = {
      coordFormat: { dec: 4 },
    };
    this.isRegion = false;
    this.regionPath = "";
  }

  toMM(val) {
    if (this.units === "in") return val * 25.4;
    return val;
  }

  parseCoordinate(val, format) {
    if (!val) return null;
    const cleanVal = val.substring(1);
    let numStr = cleanVal;
    let sign = 1;
    if (numStr.startsWith("-")) {
      sign = -1;
      numStr = numStr.substring(1);
    } else if (numStr.startsWith("+")) {
      numStr = numStr.substring(1);
    }

    let num = 0;
    if (numStr.includes(".")) {
      num = parseFloat(numStr) * sign;
    } else {
      const divisor = Math.pow(10, format.dec);
      num = (parseInt(numStr, 10) / divisor) * sign;
    }
    return this.toMM(num);
  }

  parse(gerberText) {
    const lines = gerberText.split(/[\n\r*]+/);
    this.paths = [];
    this.apertures = {};
    this.x = 0;
    this.y = 0;
    this.isRegion = false;
    this.regionPath = "";
    let currentPath = "";

    const flushPath = () => {
      if (currentPath) {
        this.paths.push({
          d: currentPath,
          aperture: this.currentAperture,
          type: "trace",
        });
        currentPath = "";
      }
    };

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      if (line.startsWith("%MOIN")) this.units = "in";
      if (line.startsWith("%MOMM")) this.units = "mm";

      if (line === "G36") {
        flushPath();
        this.isRegion = true;
        this.regionPath = "";
        continue;
      }
      if (line === "G37") {
        this.isRegion = false;
        if (this.regionPath) {
          this.paths.push({ d: this.regionPath + " Z", type: "region" });
          this.regionPath = "";
        }
        continue;
      }

      if (line.startsWith("%AD")) {
        const match = line.match(/ADD(\d+)\s*([a-zA-Z0-9_]+)[, ]?([0-9.X]+)?/);
        if (match) {
          const code = match[1];
          const type = match[2];
          const params = match[3]
            ? match[3].split("X").map((p) => this.toMM(parseFloat(p)))
            : [];
          this.apertures[code] = { type, params };
        }
        continue;
      }

      if (line.startsWith("D") && !line.includes("X")) {
        const code = line.substring(1);
        if (parseInt(code) >= 10) {
          flushPath();
          this.currentAperture = this.apertures[code];
        }
      }

      if (line.match(/^(G|X|Y|D)/)) {
        const xMatch = line.match(/X([-+]?\d+)/);
        const yMatch = line.match(/Y([-+]?\d+)/);
        const dMatch = line.match(/D(\d+)/);

        const newX = xMatch
          ? this.parseCoordinate(xMatch[0], this.format.coordFormat)
          : this.x;
        const newY = yMatch
          ? this.parseCoordinate(yMatch[0], this.format.coordFormat)
          : this.y;

        if (dMatch) {
          const op = dMatch[1];
          if (this.isRegion) {
            if (op === "01" || op === "02") {
              const cmd = op === "02" ? "M" : "L";
              this.regionPath += ` ${cmd} ${newX} ${newY}`;
            }
          } else {
            if (op === "02") {
              flushPath();
              currentPath = `M ${newX} ${newY}`;
            } else if (op === "01") {
              if (!currentPath) currentPath = `M ${this.x} ${this.y}`;
              currentPath += ` L ${newX} ${newY}`;
            } else if (op === "03") {
              flushPath();
              this.paths.push({
                x: newX,
                y: newY,
                aperture: this.currentAperture,
                type: "flash",
              });
            }
          }
        } else {
          if (this.isRegion) {
            this.regionPath += ` L ${newX} ${newY}`;
          } else {
            if (currentPath) currentPath += ` L ${newX} ${newY}`;
          }
        }
        this.x = newX;
        this.y = newY;
      }
    }
    flushPath();
    return this.paths;
  }
}

// --- COMPONENTS ---

const LayerItem = ({
  layer,
  onToggle,
  onDelete,
  onColorChange,
  onChangeOpacity,
  onToggleInvert,
}) => {
  return (
    <div className="flex flex-col bg-slate-800 rounded-lg mb-2 border border-slate-700 overflow-hidden">
      <div className="flex items-center p-2 gap-2">
        <button
          onClick={() => onToggle(layer.id)}
          className={`p-1.5 rounded hover:bg-slate-700 transition-colors ${
            layer.visible ? "text-blue-400" : "text-slate-500"
          }`}
        >
          {layer.visible ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>

        <div
          className="w-4 h-4 rounded-full cursor-pointer border border-slate-500 shadow-sm"
          style={{ backgroundColor: layer.color }}
          onClick={() => document.getElementById(`color-${layer.id}`).click()}
        />
        <input
          type="color"
          id={`color-${layer.id}`}
          value={layer.color}
          onChange={(e) => onColorChange(layer.id, e.target.value)}
          className="hidden"
        />

        <span
          className="text-xs font-medium text-slate-200 truncate flex-1"
          title={layer.name}
        >
          {layer.name}
        </span>

        <button
          onClick={() => onToggleInvert(layer.id)}
          className={`p-1.5 rounded hover:bg-slate-700 transition-colors text-[10px] font-bold border border-slate-600 ${
            layer.inverted ? "bg-blue-600 text-white" : "text-slate-400"
          }`}
          title="Negatyw (dla lasera)"
        >
          INV
        </button>

        <button
          onClick={() => onDelete(layer.id)}
          className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-slate-700 rounded transition-colors"
        >
          <Trash2 size={16} />
        </button>
      </div>

      {layer.visible && (
        <div className="px-2 pb-2 flex items-center gap-2">
          <span className="text-[10px] text-slate-400">Op:</span>
          <input
            type="range"
            min="0.1"
            max="1"
            step="0.1"
            value={layer.opacity}
            onChange={(e) =>
              onChangeOpacity(layer.id, parseFloat(e.target.value))
            }
            className="w-full h-1 bg-slate-600 rounded-lg appearance-none cursor-pointer"
          />
        </div>
      )}
    </div>
  );
};

const parseFile = async (file) => {
  const text = await file.text();

  const isExcellon =
    text.includes("M48") ||
    (text.includes("T0") && !text.includes("%AD")) ||
    file.name.endsWith(".drl") ||
    file.name.endsWith(".xln") ||
    file.name.endsWith(".drd");

  let parser;
  if (isExcellon) {
    parser = new SimpleExcellonParser();
  } else {
    parser = new SimpleGerberParser();
  }

  const paths = parser.parse(text);

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  paths.forEach((p) => {
    if (p.type === "trace") {
      const width = p.aperture?.params?.[0] || 0;
      const halfWidth = width / 2;

      const coords = p.d.match(/[-+]?[\d.]+/g);
      if (coords) {
        for (let i = 0; i < coords.length; i += 2) {
          const x = parseFloat(coords[i]);
          const y = parseFloat(coords[i + 1]);
          if (x - halfWidth < minX) minX = x - halfWidth;
          if (x + halfWidth > maxX) maxX = x + halfWidth;
          if (y - halfWidth < minY) minY = y - halfWidth;
          if (y + halfWidth > maxY) maxY = y + halfWidth;
        }
      }
    } else if (p.type === "flash") {
      const params = p.aperture?.params || [0];
      const type = p.aperture?.type || "C";
      let rx = 0,
        ry = 0;

      if (type === "C" || type === "P") {
        rx = ry = (params[0] || 0) / 2;
      } else if (type === "R" || type === "O") {
        rx = (params[0] || 0) / 2;
        ry = (params[1] || params[0] || 0) / 2;
      }

      if (p.x - rx < minX) minX = p.x - rx;
      if (p.x + rx > maxX) maxX = p.x + rx;
      if (p.y - ry < minY) minY = p.y - ry;
      if (p.y + ry > maxY) maxY = p.y + ry;
    } else if (p.type === "region") {
      const coords = p.d.match(/[-+]?[\d.]+/g);
      if (coords) {
        for (let i = 0; i < coords.length; i += 2) {
          const x = parseFloat(coords[i]);
          const y = parseFloat(coords[i + 1]);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  });

  if (minX === Infinity) {
    minX = 0;
    maxX = 100;
    minY = 0;
    maxY = 100;
  }

  return {
    name: file.name,
    paths: paths,
    bounds: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
    units: "mm",
  };
};

const traceToOutlinePath = (d, width) => {
  const commands = d.trim().split(/\s+/);
  const points = [];
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    if (cmd === "M" || cmd === "L") {
      const x = parseFloat(commands[i + 1]);
      const y = parseFloat(commands[i + 2]);
      points.push({ x, y });
      i += 2;
    }
  }

  if (points.length < 2) return "";

  let path = "";
  const r = width / 2;

  // Add circles at all points (covers caps and joins)
  points.forEach((p) => {
    // Circle path: M cx cy m -r, 0 a r,r 0 1,1 (r*2),0 a r,r 0 1,1 -(r*2),0
    // Uses sweep-flag 1 (clockwise) to match the winding of the rectangles
    path += `M ${p.x} ${p.y} m -${r}, 0 a ${r},${r} 0 1,1 ${
      r * 2
    },0 a ${r},${r} 0 1,1 -${r * 2},0 `;
  });

  // Add rects for segments
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) continue;

    const nx = (-dy / len) * r;
    const ny = (dx / len) * r;

    // 4 corners
    const c1x = p1.x + nx;
    const c1y = p1.y + ny;
    const c2x = p1.x - nx;
    const c2y = p1.y - ny;
    const c3x = p2.x - nx;
    const c3y = p2.y - ny;
    const c4x = p2.x + nx;
    const c4y = p2.y + ny;

    path += `M ${c1x} ${c1y} L ${c2x} ${c2y} L ${c3x} ${c3y} L ${c4x} ${c4y} Z `;
  }

  return path;
};

const RenderLayer = ({ layerData, boardBounds }) => {
  return useMemo(() => {
    const { inverted, color, opacity, data, id } = layerData;

    const content = (
      <g>
        {/* Render regions first */}
        {(() => {
          const regionD = data.paths
            .filter((p) => p.type === "region")
            .map((p) => p.d)
            .join(" ");
          return regionD ? (
            <path
              d={regionD}
              fill="currentColor"
              stroke="none"
              fillRule="evenodd"
            />
          ) : null;
        })()}

        {/* Render flashes */}
        {data.paths
          .filter((p) => p.type === "flash")
          .map((p, i) => {
            const params = p.aperture?.params || [];
            const type = p.aperture?.type || "C";
            let size = params[0] || 0.8;

            if (type === "C" || type === "P") {
              return (
                <circle
                  key={`flash-${i}`}
                  cx={p.x}
                  cy={p.y}
                  r={size / 2}
                  fill="currentColor"
                />
              );
            } else if (type === "R" || type === "O") {
              const w = params[0] || size;
              const h = params[1] || w;
              const rx = type === "O" ? Math.min(w, h) / 2 : 0;
              return (
                <rect
                  key={`flash-${i}`}
                  x={p.x - w / 2}
                  y={p.y - h / 2}
                  width={w}
                  height={h}
                  rx={rx}
                  fill="currentColor"
                />
              );
            } else {
              return (
                <circle
                  key={`flash-${i}`}
                  cx={p.x}
                  cy={p.y}
                  r={size / 2}
                  fill="currentColor"
                />
              );
            }
          })}

        {/* Render traces as a single path if possible or just normal paths */}
        {data.paths
          .filter((p) => p.type === "trace")
          .map((p, i) => {
            const width = p.aperture?.params[0] || 0.2;
            const outlinePath = traceToOutlinePath(p.d, width);
            return (
              <path
                key={`trace-${i}`}
                d={outlinePath}
                fill="currentColor"
                stroke="none"
                fillRule="nonzero"
              />
            );
          })}
      </g>
    );

    if (inverted) {
      // Use boardBounds if available, otherwise layer bounds
      const b = boardBounds || data.bounds;
      const pad = 1; // 1mm padding
      const x = b.minX - pad;
      const y = b.minY - pad;
      const w = b.width + pad * 2;
      const h = b.height + pad * 2;

      return (
        <g style={{ opacity }}>
          <defs>
            <mask id={`mask-${id}`}>
              <rect x={x} y={y} width={w} height={h} fill="white" />
              <g fill="black">{content}</g>
            </mask>
          </defs>
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            fill={color}
            mask={`url(#mask-${id})`}
          />
        </g>
      );
    }

    return (
      <g
        className="mix-blend-screen"
        style={{ opacity: opacity, color: color }}
      >
        {content}
      </g>
    );
  }, [layerData, boardBounds]);
};

const getLayerSide = (name) => {
  const lower = name.toLowerCase();

  // Specific extensions for Top
  if (
    lower.endsWith(".gtl") ||
    lower.endsWith(".gto") ||
    lower.endsWith(".gts") ||
    lower.endsWith(".gtp") ||
    lower.includes("f.cu") ||
    lower.includes("f.silk") ||
    lower.includes("f.mask") ||
    lower.includes("f.paste")
  ) {
    return "top";
  }

  // Specific extensions for Bottom
  if (
    lower.endsWith(".gbl") ||
    lower.endsWith(".gbo") ||
    lower.endsWith(".gbs") ||
    lower.endsWith(".gbp") ||
    lower.includes("b.cu") ||
    lower.includes("b.silk") ||
    lower.includes("b.mask") ||
    lower.includes("b.paste")
  ) {
    return "bottom";
  }

  // Keywords
  const isTop = lower.includes("top") || lower.includes("front");

  const isBottom = lower.includes("bottom") || lower.includes("back");

  if (isTop && !isBottom) return "top";
  if (isBottom && !isTop) return "bottom";

  return "both";
};

const GerberView = ({
  layers,
  viewBox,
  svgRef,
  onWheel,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onMouseLeave,
  title,
  onExport,
  boardBounds,
}) => {
  return (
    <div className="flex-1 relative border-r border-slate-800 last:border-r-0">
      <div className="absolute top-2 left-2 right-2 flex justify-between items-start z-10 px-2 pointer-events-none">
        <div className="text-xs font-bold text-slate-500 bg-slate-900/50 px-2 rounded">
          {title}
        </div>
        <button
          onClick={onExport}
          className="pointer-events-auto bg-slate-800 hover:bg-slate-700 text-slate-300 p-1.5 rounded border border-slate-600 shadow-sm transition-colors cursor-pointer flex items-center gap-1"
          title={`Eksportuj ${title} do SVG`}
        >
          <Download size={14} />
          <span className="text-[10px] font-medium">SVG</span>
        </button>
      </div>
      <svg
        ref={svgRef}
        className="w-full h-full cursor-crosshair touch-none"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        preserveAspectRatio="xMidYMid meet"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
      >
        <defs>
          <pattern
            id="grid"
            width="10"
            height="10"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 10 0 L 0 0 0 10"
              fill="none"
              stroke="#1e293b"
              strokeWidth="0.1"
            />
          </pattern>
        </defs>
        <rect
          id="grid-background"
          x={viewBox.x - 1000}
          y={viewBox.y - 1000}
          width={viewBox.w + 2000}
          height={viewBox.h + 2000}
          fill="url(#grid)"
        />

        <g transform="scale(1, -1)">
          {layers.map(
            (layer) =>
              layer.visible && (
                <RenderLayer
                  key={layer.id}
                  layerData={layer}
                  boardBounds={boardBounds}
                />
              )
          )}
        </g>
      </svg>
    </div>
  );
};

export default function App() {
  const [layers, setLayers] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 100, h: 100 });
  const svgTopRef = useRef(null);
  const svgBottomRef = useRef(null);
  const [isPanning, setIsPanning] = useState(false);
  const [startPan, setStartPan] = useState({ x: 0, y: 0 });

  const boardBounds = useMemo(() => {
    const profile = layers.find(
      (l) =>
        l.name.toLowerCase().includes("profile") ||
        l.name.toLowerCase().includes("outline") ||
        l.name.toLowerCase().includes("edge") ||
        l.name.toLowerCase().includes("gm1") ||
        l.name.toLowerCase().includes("gko")
    );
    if (profile) return profile.data.bounds;

    // Fallback: combined bounds of all layers
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let hasContent = false;
    layers.forEach((l) => {
      const b = l.data.bounds;
      if (b.minX !== Infinity) {
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
        hasContent = true;
      }
    });
    if (hasContent)
      return {
        minX,
        minY,
        maxX,
        maxY,
        width: maxX - minX,
        height: maxY - minY,
      };
    return null;
  }, [layers]);

  const guessLayerStyle = (filename) => {
    const lower = filename.toLowerCase();

    // 1. Drills (White)
    if (
      lower.includes(".drl") ||
      lower.includes(".xln") ||
      lower.includes("drill") ||
      lower.includes(".drd")
    ) {
      return { color: "#ffffff", opacity: 0.9, order: 100 };
    }

    // 2. Profile / Outline (Orange)
    if (
      lower.includes("profile") ||
      lower.includes("outline") ||
      lower.includes("edge") ||
      lower.includes("gm1") ||
      lower.includes("gko")
    ) {
      return { color: "#e67e22", order: 90 };
    }

    // 3. Paste (Gold/Yellow)
    if (
      lower.includes("paste") ||
      lower.includes("gtp") ||
      lower.includes("gbp") ||
      lower.includes("stencil")
    ) {
      return { color: "#f1c40f", opacity: 0.8, order: 60 };
    }

    // 4. Soldermask (Green)
    if (
      lower.includes("mask") ||
      lower.includes("gts") ||
      lower.includes("gbs")
    ) {
      return { color: "#27ae60", opacity: 0.5, order: 50 };
    }

    // 5. Silkscreen (White/Gray)
    if (
      lower.includes("silk") ||
      lower.includes("gto") ||
      lower.includes("gbo") ||
      lower.includes("legend")
    ) {
      // Bottom Silk slightly darker
      if (
        lower.includes("bottom") ||
        lower.includes("b.") ||
        lower.includes("back") ||
        lower.includes("gbo")
      ) {
        return { color: "#bdc3c7", order: 80 };
      }
      return { color: "#ecf0f1", order: 80 };
    }

    // 6. Copper (Red/Blue)
    if (
      lower.includes("top") ||
      lower.includes("f.cu") ||
      lower.includes("gtl") ||
      lower.includes("front")
    ) {
      return { color: "#c0392b", opacity: 0.9, order: 10 };
    }

    if (
      lower.includes("bottom") ||
      lower.includes("b.cu") ||
      lower.includes("gbl") ||
      lower.includes("back")
    ) {
      return { color: "#2980b9", opacity: 0.9, order: 10 };
    }

    // Default fallback
    return { color: "#95a5a6", order: 5 };
  };

  const handleFiles = async (files) => {
    const newLayers = [];

    for (let file of files) {
      try {
        const data = await parseFile(file);
        const style = guessLayerStyle(file.name);

        newLayers.push({
          id: Math.random().toString(36).substr(2, 9),
          name: file.name,
          visible: true,
          color: style.color,
          opacity: style.opacity || 0.9,
          data: data,
          order: style.order,
        });
      } catch (e) {
        console.error("Błąd parsowania:", file.name, e);
        alert(`Nie udało się otworzyć pliku: ${file.name}.`);
      }
    }

    setLayers((prev) => {
      const combined = [...prev, ...newLayers].sort(
        (a, b) => b.order - a.order
      );

      // Calculate bounds for ALL layers to fit everything
      const box = getFitViewBox(combined);
      if (box) {
        setViewBox(box);
      }

      return combined;
    });
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleWheel = (e) => {
    e.preventDefault();
    const scale = e.deltaY > 0 ? 1.1 : 0.9;
    setViewBox((prev) => ({
      x: prev.x - (prev.w * (1 - scale)) / 2,
      y: prev.y - (prev.h * (1 - scale)) / 2,
      w: prev.w * scale,
      h: prev.h * scale,
    }));
  };

  const handleMouseDown = (e) => {
    setIsPanning(true);
    setStartPan({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e, ref) => {
    if (!isPanning) return;
    const dx = e.clientX - startPan.x;
    const dy = e.clientY - startPan.y;

    const svgEl = ref?.current;
    if (svgEl) {
      const { width, height } = svgEl.getBoundingClientRect();
      const scaleX = viewBox.w / width;
      const scaleY = viewBox.h / height;

      setViewBox((prev) => ({
        ...prev,
        x: prev.x - dx * scaleX,
        y: prev.y - dy * scaleY,
      }));
      setStartPan({ x: e.clientX, y: e.clientY });
    }
  };

  const handleExport = (ref, name) => {
    if (!ref.current) return;

    const clone = ref.current.cloneNode(true);
    const grid = clone.querySelector("#grid-background");
    if (grid) grid.remove();

    const svgData = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getFitViewBox = (layersList) => {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let hasContent = false;

    layersList.forEach((layer) => {
      if (layer.visible && layer.data && layer.data.bounds) {
        const b = layer.data.bounds;
        if (b.minX === Infinity || b.maxX === -Infinity) return;

        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
        hasContent = true;
      }
    });

    if (hasContent) {
      const width = maxX - minX;
      const height = maxY - minY;
      const pad = Math.max(width, height) * 0.1;

      return {
        x: minX - pad,
        y: -maxY - pad, // Corrected for scale(1, -1)
        w: width + pad * 2,
        h: height + pad * 2,
      };
    }
    return null;
  };

  const fitToScreen = () => {
    const box = getFitViewBox(layers);
    if (box) setViewBox(box);
  };

  return (
    <div className="flex h-screen w-full bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* SIDEBAR */}
      <div className="w-72 bg-slate-900 border-r border-slate-800 flex flex-col shadow-xl z-10">
        <div className="p-4 border-b border-slate-800 bg-slate-900">
          <h1 className="text-xl font-bold flex items-center gap-2 text-blue-400">
            <Layers className="w-6 h-6" />
            Gerber Viewer
          </h1>
          <p className="text-xs text-slate-500 mt-1">Podgląd Gerber & Drill</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {layers.length === 0 ? (
            <div className="text-center py-10 text-slate-600">
              <Upload className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="text-sm">Brak warstw</p>
              <p className="text-xs mt-2">
                Przeciągnij pliki .gbr / .drl tutaj
              </p>
            </div>
          ) : (
            layers.map((layer) => (
              <LayerItem
                key={layer.id}
                layer={layer}
                onToggle={(id) =>
                  setLayers((l) =>
                    l.map((x) =>
                      x.id === id ? { ...x, visible: !x.visible } : x
                    )
                  )
                }
                onDelete={(id) =>
                  setLayers((l) => l.filter((x) => x.id !== id))
                }
                onColorChange={(id, c) =>
                  setLayers((l) =>
                    l.map((x) => (x.id === id ? { ...x, color: c } : x))
                  )
                }
                onChangeOpacity={(id, o) =>
                  setLayers((l) =>
                    l.map((x) => (x.id === id ? { ...x, opacity: o } : x))
                  )
                }
                onToggleInvert={(id) =>
                  setLayers((l) =>
                    l.map((x) =>
                      x.id === id ? { ...x, inverted: !x.inverted } : x
                    )
                  )
                }
              />
            ))
          )}
        </div>

        <div className="p-4 border-t border-slate-800 bg-slate-900">
          <label className="flex flex-col items-center justify-center w-full h-12 border-2 border-dashed border-slate-700 rounded-lg cursor-pointer hover:border-blue-500 hover:bg-slate-800 transition-all group">
            <span className="text-sm text-slate-400 group-hover:text-blue-400 font-medium">
              Wgraj pliki
            </span>
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </label>
        </div>
      </div>

      {/* MAIN CANVAS */}
      <div className="flex-1 relative flex flex-col h-full">
        {/* TOOLBAR */}
        <div className="absolute top-16 left-1/2 transform -translate-x-1/2 bg-slate-800/90 backdrop-blur-sm p-2 rounded-full shadow-lg flex items-center gap-2 border border-slate-700 z-20">
          <button
            className="p-2 hover:bg-slate-700 rounded-full text-slate-300"
            onClick={() =>
              setViewBox((v) => ({ ...v, w: v.w * 0.8, h: v.h * 0.8 }))
            }
            title="Przybliż"
          >
            <ZoomIn size={20} />
          </button>
          <button
            className="p-2 hover:bg-slate-700 rounded-full text-slate-300"
            onClick={() =>
              setViewBox((v) => ({ ...v, w: v.w * 1.2, h: v.h * 1.2 }))
            }
            title="Oddal"
          >
            <ZoomOut size={20} />
          </button>
          <button
            className="p-2 hover:bg-slate-700 rounded-full text-slate-300"
            onClick={fitToScreen}
            title="Dopasuj do ekranu"
          >
            <Maximize size={20} />
          </button>
          <div className="w-px h-4 bg-slate-600 mx-1" />
          <button
            className="p-2 hover:bg-slate-700 rounded-full text-slate-300 cursor-move"
            title="Przesuń (LPM)"
          >
            <Move size={20} />
          </button>
          <div className="w-px h-4 bg-slate-600 mx-1" />
          <div className="relative group">
            <Info size={20} className="text-slate-400 cursor-help ml-2 mr-2" />
            <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 w-48 p-2 bg-slate-900 border border-slate-700 text-xs text-slate-300 rounded shadow-xl hidden group-hover:block">
              Scroll: Zoom
              <br />
              LPM + Przesuń: Pan
              <br />
              Obsługuje RS-274X i Excellon.
            </div>
          </div>
        </div>

        {/* SVG AREA */}
        <div
          className={`flex-1 bg-slate-950 relative overflow-hidden flex flex-row ${
            dragActive ? "bg-slate-900/50" : ""
          }`}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragActive(false);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
        >
          {dragActive && (
            <div className="absolute inset-0 flex items-center justify-center z-50 bg-blue-500/20 border-4 border-blue-500 border-dashed m-4 rounded-2xl pointer-events-none">
              <h2 className="text-2xl font-bold text-blue-100 drop-shadow-md">
                Upuść pliki Gerber / Drill
              </h2>
            </div>
          )}

          {layers.length === 0 && !dragActive && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-700 select-none pointer-events-none">
              <div className="w-96 h-64 border-2 border-slate-800 rounded-lg flex items-center justify-center border-dashed mb-4">
                <span className="text-6xl opacity-20">PCB</span>
              </div>
              <p>Obszar roboczy jest pusty</p>
            </div>
          )}

          <GerberView
            title="TOP"
            layers={layers.filter((l) => {
              const side = getLayerSide(l.name);
              return side === "top" || side === "both";
            })}
            viewBox={viewBox}
            svgRef={svgTopRef}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={(e) => handleMouseMove(e, svgTopRef)}
            onMouseUp={() => setIsPanning(false)}
            onMouseLeave={() => setIsPanning(false)}
            onExport={() => handleExport(svgTopRef, "pcb_top")}
            boardBounds={boardBounds}
          />

          <GerberView
            title="BOTTOM"
            layers={layers.filter((l) => {
              const side = getLayerSide(l.name);
              return side === "bottom" || side === "both";
            })}
            viewBox={viewBox}
            svgRef={svgBottomRef}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={(e) => handleMouseMove(e, svgBottomRef)}
            onMouseUp={() => setIsPanning(false)}
            onMouseLeave={() => setIsPanning(false)}
            onExport={() => handleExport(svgBottomRef, "pcb_bottom")}
            boardBounds={boardBounds}
          />
        </div>

        {/* FOOTER INFO */}
        <div className="bg-slate-900 text-slate-500 text-[10px] px-4 py-1 flex justify-between items-center border-t border-slate-800">
          <span>
            Pozycja: {Math.round(viewBox.x + viewBox.w / 2)},{" "}
            {Math.round(viewBox.y + viewBox.h / 2)}
          </span>
          <span>Skala: {(100 / viewBox.w).toFixed(2)}x</span>
        </div>
      </div>
    </div>
  );
}
