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
        } else {
          if (currentPath) currentPath += ` L ${newX} ${newY}`;
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
    } else if (p.type === "flash") {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
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

const RenderLayer = ({ layerData }) => {
  return useMemo(() => {
    return (
      <g
        className="mix-blend-screen"
        style={{ opacity: layerData.opacity, color: layerData.color }}
      >
        {layerData.data.paths.map((p, i) => {
          if (p.type === "flash") {
            const params = p.aperture?.params || [];
            const type = p.aperture?.type || "C";
            let size = params[0] || 0.8;

            if (type === "C" || type === "P") {
              return (
                <circle
                  key={i}
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
                  key={i}
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
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r={size / 2}
                  fill="currentColor"
                />
              );
            }
          } else {
            const width = p.aperture?.params[0] || 0.2;
            return (
              <path
                key={i}
                d={p.d}
                stroke="currentColor"
                strokeWidth={width}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          }
        })}
      </g>
    );
  }, [layerData.color, layerData.opacity, layerData.data]);
};

export default function App() {
  const [layers, setLayers] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 100, h: 100 });
  const svgRef = useRef(null);
  const [isPanning, setIsPanning] = useState(false);
  const [startPan, setStartPan] = useState({ x: 0, y: 0 });

  const guessLayerStyle = (filename) => {
    const lower = filename.toLowerCase();
    if (
      lower.includes(".drl") ||
      lower.includes(".xln") ||
      lower.includes("drill") ||
      lower.includes(".drd")
    ) {
      return { color: "#ecf0f1", opacity: 0.9, order: 100 };
    }
    if (lower.includes("f.cu") || lower.includes("gtl"))
      return { color: "#c0392b", order: 1 };
    if (lower.includes("b.cu") || lower.includes("gbl"))
      return { color: "#2980b9", order: 2 };
    if (lower.includes("f.silk") || lower.includes("gto"))
      return { color: "#ecf0f1", order: 0 };
    if (lower.includes("b.silk") || lower.includes("gbo"))
      return { color: "#bdc3c7", order: 3 };
    if (
      lower.includes("mask") ||
      lower.includes("gts") ||
      lower.includes("gbs")
    )
      return { color: "#27ae60", opacity: 0.5, order: 4 };

    return { color: "#f1c40f", order: 10 };
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
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      let hasContent = false;

      combined.forEach((layer) => {
        if (layer.data && layer.data.bounds) {
          const b = layer.data.bounds;
          // Skip invalid bounds
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
        const pad = Math.max(width, height) * 0.1; // 10% padding

        setViewBox({
          x: minX - pad,
          y: minY - pad,
          w: width + pad * 2,
          h: height + pad * 2,
        });
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

  const handleMouseMove = (e) => {
    if (!isPanning) return;
    const dx = e.clientX - startPan.x;
    const dy = e.clientY - startPan.y;

    const svgEl = svgRef.current;
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
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-slate-800/90 backdrop-blur-sm p-2 rounded-full shadow-lg flex items-center gap-2 border border-slate-700 z-20">
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
          className={`flex-1 bg-slate-950 relative overflow-hidden ${
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

          <svg
            ref={svgRef}
            className="w-full h-full cursor-crosshair touch-none"
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
            preserveAspectRatio="xMidYMid meet"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={() => setIsPanning(false)}
            onMouseLeave={() => setIsPanning(false)}
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
                    <RenderLayer key={layer.id} layerData={layer} />
                  )
              )}
            </g>
          </svg>
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
