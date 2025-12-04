import React, { useState, useRef, useMemo, useEffect } from "react";
import paper from "paper";
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
  FlipHorizontal,
} from "lucide-react";

import { traceToOutlinePath, generateMergedPath, generateProfilePath } from "./utils/gerberUtils";

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
    this.interpolationMode = "G01"; // G01, G02, G03
    this.quadrantMode = "G74"; // G74 (Single), G75 (Multi)
    this.macros = {};
    this.parsingMacro = null;
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

  // Helper to generate SVG Arc path command
  getArcCommand(x1, y1, x2, y2, i, j, mode) {
    // I, J are offsets from (x1, y1) to center
    const cx = x1 + i;
    const cy = y1 + j;
    const radius = Math.sqrt(i * i + j * j);

    // Calculate angles to determine large-arc-flag
    const startAngle = Math.atan2(y1 - cy, x1 - cx);
    const endAngle = Math.atan2(y2 - cy, x2 - cx);

    let diff = endAngle - startAngle;

    // Normalize diff based on direction
    if (mode === "G02") {
      // CW
      if (diff > 0) diff -= 2 * Math.PI;
    } else {
      // G03 CCW
      if (diff < 0) diff += 2 * Math.PI;
    }

    const largeArc = Math.abs(diff) > Math.PI ? 1 : 0;
    const sweep = mode === "G02" ? 0 : 1; // 0 for CW, 1 for CCW in SVG (if Y-axis is not flipped)

    return `A ${radius} ${radius} 0 ${largeArc} ${sweep} ${x2} ${y2}`;
  }

  parse(gerberText) {
    const lines = gerberText.split(/[\n\r*]+/);
    this.paths = [];
    this.apertures = {};
    this.macros = {};
    this.parsingMacro = null;
    this.x = 0;
    this.y = 0;
    this.isRegion = false;
    this.regionPath = "";
    this.interpolationMode = "G01";
    this.coordinateMode = "G90";
    this.quadrantMode = "G74";
    this.polarity = "dark"; // Default to Dark (LPD)
    let currentPath = "";

    const flushPath = () => {
      if (currentPath) {
        this.paths.push({
          d: currentPath,
          aperture: this.currentAperture,
          type: "trace",
          polarity: this.polarity,
        });
        currentPath = "";
      }
    };

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      // Polarity
      if (line.startsWith("%LPD")) { this.polarity = "dark"; continue; }
      if (line.startsWith("%LPC")) { this.polarity = "clear"; continue; }

      // Macro Parsing
      if (line.startsWith("%AM")) {
        const name = line.substring(3);
        this.macros[name] = [];
        this.parsingMacro = name;
        continue;
      }
      if (this.parsingMacro) {
        if (line.includes("%")) {
          this.parsingMacro = null;
          continue;
        }
        this.macros[this.parsingMacro].push(line);
        continue;
      }

      if (line.startsWith("%MOIN")) this.units = "in";
      if (line.startsWith("%MOMM")) this.units = "mm";

      if (line.startsWith("%FS")) {
        const match = line.match(/X(\d)(\d)Y(\d)(\d)/i);
        if (match) {
          this.format.coordFormat.dec = parseInt(match[2], 10);
        }
      }

      if (line.includes("G01")) this.interpolationMode = "G01";
      if (line.includes("G02")) this.interpolationMode = "G02";
      if (line.includes("G03")) this.interpolationMode = "G03";
      if (line.includes("G90")) this.coordinateMode = "G90";
      if (line.includes("G91")) this.coordinateMode = "G91";
      if (line.includes("G74")) this.quadrantMode = "G74";
      if (line.includes("G75")) this.quadrantMode = "G75";

      if (line === "G36") {
        flushPath();
        this.isRegion = true;
        this.regionPath = "";
        continue;
      }
      if (line === "G37") {
        this.isRegion = false;
        if (this.regionPath) {
          this.paths.push({ d: this.regionPath + " Z", type: "region", polarity: this.polarity });
          this.regionPath = "";
        }
        continue;
      }

      if (line.startsWith("%AD")) {
        const match = line.match(/ADD(\d+)\s*([a-zA-Z0-9_]+)[, ]?([0-9.X-]+)?/);
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

      if (line.match(/^(G|X|Y|I|J|D)/)) {
        const xMatch = line.match(/X([-+]?\d+)/);
        const yMatch = line.match(/Y([-+]?\d+)/);
        const iMatch = line.match(/I([-+]?\d+)/);
        const jMatch = line.match(/J([-+]?\d+)/);
        const dMatch = line.match(/D(\d+)/);

        const valX = xMatch
          ? this.parseCoordinate(xMatch[0], this.format.coordFormat)
          : null;
        const valY = yMatch
          ? this.parseCoordinate(yMatch[0], this.format.coordFormat)
          : null;

        let newX = this.x;
        let newY = this.y;

        if (this.coordinateMode === "G91") {
          if (valX !== null) newX += valX;
          if (valY !== null) newY += valY;
        } else {
          if (valX !== null) newX = valX;
          if (valY !== null) newY = valY;
        }

        const iVal = iMatch
          ? this.parseCoordinate(iMatch[0], this.format.coordFormat)
          : 0;
        const jVal = jMatch
          ? this.parseCoordinate(jMatch[0], this.format.coordFormat)
          : 0;

        if (dMatch) {
          const op = dMatch[1];
          if (this.isRegion) {
            if (op === "01" || op === "02") {
              if (op === "02") {
                // Move
                this.regionPath += ` M ${newX} ${newY}`;
              } else {
                // Draw
                if (this.interpolationMode === "G01") {
                  this.regionPath += ` L ${newX} ${newY}`;
                } else {
                  // Arc
                  this.regionPath +=
                    " " +
                    this.getArcCommand(
                      this.x,
                      this.y,
                      newX,
                      newY,
                      iVal,
                      jVal,
                      this.interpolationMode
                    );
                }
              }
            }
          } else {
            if (op === "02") {
              flushPath();
              currentPath = `M ${newX} ${newY}`;
            } else if (op === "01") {
              if (!currentPath) currentPath = `M ${this.x} ${this.y}`;

              if (this.interpolationMode === "G01") {
                currentPath += ` L ${newX} ${newY}`;
              } else {
                currentPath +=
                  " " +
                  this.getArcCommand(
                    this.x,
                    this.y,
                    newX,
                    newY,
                    iVal,
                    jVal,
                    this.interpolationMode
                  );
              }
            } else if (op === "03") {
              flushPath();
              this.paths.push({
                x: newX,
                y: newY,
                aperture: this.currentAperture,
                type: "flash",
                polarity: this.polarity,
              });
            }
          }
        } else {
          // No D code, assume previous D01 (draw) if we have coordinates
          // But strictly Gerber requires D01/D02/D03.
          // However, modal coordinates often imply D01 if inside a sequence.
          // Let's assume D01 if we have movement and we are in a path.
          if ((xMatch || yMatch) && (this.isRegion || currentPath)) {
            if (this.isRegion) {
              if (this.interpolationMode === "G01") {
                this.regionPath += ` L ${newX} ${newY}`;
              } else {
                this.regionPath +=
                  " " +
                  this.getArcCommand(
                    this.x,
                    this.y,
                    newX,
                    newY,
                    iVal,
                    jVal,
                    this.interpolationMode
                  );
              }
            } else {
              if (this.interpolationMode === "G01") {
                currentPath += ` L ${newX} ${newY}`;
              } else {
                currentPath +=
                  " " +
                  this.getArcCommand(
                    this.x,
                    this.y,
                    newX,
                    newY,
                    iVal,
                    jVal,
                    this.interpolationMode
                  );
              }
            }
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
    macros: parser.macros || {},
    bounds: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
    units: "mm",
  };
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
              fillRule="nonzero"
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

            if (type === "C") {
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
            } else if (type === "P") {
              // Polygon
              const diameter = params[0] || size;
              const vertices = params[1] || 6;
              const rotation = params[2] || 0; // Rotation in degrees
              const r = diameter / 2;

              // Generate polygon points
              const pts = [];
              for (let v = 0; v < vertices; v++) {
                const angle =
                  (v * 2 * Math.PI) / vertices + (rotation * Math.PI) / 180;
                pts.push(
                  `${p.x + r * Math.cos(angle)},${p.y + r * Math.sin(angle)}`
                );
              }

              return (
                <polygon
                  key={`flash-${i}`}
                  points={pts.join(" ")}
                  fill="currentColor"
                />
              );
            } else {
              // Check for Macros
              const macro = data.macros?.[type];
              if (macro) {
                const maskId = `mask-${i}-${p.x}-${p.y}`;

                // We need to parse all primitives first to calculate bounds and render them in the mask
                let minX = 0,
                  minY = 0,
                  maxX = 0,
                  maxY = 0;
                let first = true;

                const expand = (x, y, r = 0) => {
                  if (first) {
                    minX = x - r;
                    minY = y - r;
                    maxX = x + r;
                    maxY = y + r;
                    first = false;
                  } else {
                    minX = Math.min(minX, x - r);
                    minY = Math.min(minY, y - r);
                    maxX = Math.max(maxX, x + r);
                    maxY = Math.max(maxY, y + r);
                  }
                };

                const primitives = macro.map((block, idx) => {
                  const rawParts = block.replace(/\*$/, "").split(",");

                  // Helper to resolve value
                  const val = (v) => {
                    if (!v) return 0;
                    let expr = v.toString();
                    if (!expr.includes("$") && !isNaN(parseFloat(expr)))
                      return parseFloat(expr);
                    expr = expr.replace(/\$(\d+)/g, (m, n) => {
                      const val = params[parseInt(n) - 1];
                      return val !== undefined ? val : 0;
                    });
                    try {
                      return new Function("return " + expr)();
                    } catch {
                      return 0;
                    }
                  };

                  const primType = parseInt(rawParts[0], 10);
                  let el = null;

                  // 1: Circle
                  if (primType === 1) {
                    const exposure = val(rawParts[1]);
                    const diam = val(rawParts[2]);
                    const cx = val(rawParts[3]);
                    const cy = val(rawParts[4]);
                    expand(cx, cy, diam / 2);
                    el = (
                      <circle
                        cx={cx}
                        cy={cy}
                        r={diam / 2}
                        fill={exposure === 1 ? "white" : "black"}
                      />
                    );
                  }
                  // 20: Vector Line
                  else if (primType === 20) {
                    const exposure = val(rawParts[1]);
                    const width = val(rawParts[2]);
                    const sx = val(rawParts[3]);
                    const sy = val(rawParts[4]);
                    const ex = val(rawParts[5]);
                    const ey = val(rawParts[6]);
                    const rot = val(rawParts[7]);
                    expand(sx, sy, width / 2);
                    expand(ex, ey, width / 2);
                    el = (
                      <line
                        x1={sx}
                        y1={sy}
                        x2={ex}
                        y2={ey}
                        stroke={exposure === 1 ? "white" : "black"}
                        strokeWidth={width}
                        strokeLinecap="round"
                        transform={`rotate(${rot})`}
                      />
                    );
                  }
                  // 21: Center Rect
                  else if (primType === 21) {
                    const exposure = val(rawParts[1]);
                    const w = val(rawParts[2]);
                    const h = val(rawParts[3]);
                    const cx = val(rawParts[4]);
                    const cy = val(rawParts[5]);
                    const rot = val(rawParts[6]);
                    const r = Math.sqrt(w * w + h * h) / 2;
                    expand(cx, cy, r);
                    el = (
                      <rect
                        x={cx - w / 2}
                        y={cy - h / 2}
                        width={w}
                        height={h}
                        transform={`rotate(${rot}, ${cx}, ${cy})`}
                        fill={exposure === 1 ? "white" : "black"}
                      />
                    );
                  }
                  // 4: Outline
                  else if (primType === 4) {
                    const exposure = val(rawParts[1]);
                    const count = val(rawParts[2]);
                    const pts = [];
                    for (let k = 0; k < count; k++) {
                      const x = val(rawParts[3 + k * 2]);
                      const y = val(rawParts[4 + k * 2]);
                      pts.push(`${x},${y}`);
                      expand(x, y);
                    }
                    const rot = val(rawParts[rawParts.length - 1]);
                    el = (
                      <polygon
                        points={pts.join(" ")}
                        transform={`rotate(${rot})`}
                        fill={exposure === 1 ? "white" : "black"}
                      />
                    );
                  }
                  // 5: Polygon
                  else if (primType === 5) {
                    const exposure = val(rawParts[1]);
                    const vertices = val(rawParts[2]);
                    const cx = val(rawParts[3]);
                    const cy = val(rawParts[4]);
                    const diam = val(rawParts[5]);
                    const rot = val(rawParts[6]);
                    expand(cx, cy, diam / 2);
                    const r = diam / 2;
                    const pts = [];
                    for (let v = 0; v < vertices; v++) {
                      const angle = (v * 2 * Math.PI) / vertices;
                      pts.push(
                        `${cx + r * Math.cos(angle)},${
                          cy + r * Math.sin(angle)
                        }`
                      );
                    }
                    el = (
                      <polygon
                        points={pts.join(" ")}
                        transform={`rotate(${rot}, ${cx}, ${cy})`}
                        fill={exposure === 1 ? "white" : "black"}
                      />
                    );
                  }
                  // 7: Thermal
                  else if (primType === 7) {
                    const cx = val(rawParts[1]);
                    const cy = val(rawParts[2]);
                    const outer = val(rawParts[3]);
                    const inner = val(rawParts[4]);
                    expand(cx, cy, outer / 2);
                    el = (
                      <g>
                        <circle cx={cx} cy={cy} r={outer / 2} fill="white" />
                        <circle cx={cx} cy={cy} r={inner / 2} fill="black" />
                      </g>
                    );
                  }

                  return { el, idx };
                });

                // Add some padding to bounds
                minX -= 0.1;
                minY -= 0.1;
                maxX += 0.1;
                maxY += 0.1;
                const width = maxX - minX;
                const height = maxY - minY;

                return (
                  <g key={`flash-${i}`} transform={`translate(${p.x}, ${p.y})`}>
                    <defs>
                      <mask id={maskId}>
                        <rect
                          x={minX}
                          y={minY}
                          width={width}
                          height={height}
                          fill="black"
                        />
                        {primitives.map((p) => (
                          <React.Fragment key={p.idx}>{p.el}</React.Fragment>
                        ))}
                      </mask>
                    </defs>
                    <rect
                      x={minX}
                      y={minY}
                      width={width}
                      height={height}
                      fill="currentColor"
                      mask={`url(#${maskId})`}
                    />
                  </g>
                );
              }

              // Fallback for unknown types - render as circle
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
              <g fill="black" style={{ color: "black" }}>{content}</g>
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

  // Regex for Top
  if (
    lower.match(/\.gt[losp]/) ||
    lower.match(/f[._-](cu|silk|mask|paste)/) ||
    lower.includes("front") ||
    lower.includes("top")
  ) {
    return "top";
  }

  // Regex for Bottom
  if (
    lower.match(/\.gb[losp]/) ||
    lower.match(/b[._-](cu|silk|mask|paste)/) ||
    lower.includes("back") ||
    lower.includes("bottom")
  ) {
    return "bottom";
  }

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
  allowMirror = false,
}) => {
  // Default to mirrored if allowed (for Bottom view)
  const [mirrored, setMirrored] = useState(allowMirror);

  const transform = useMemo(() => {
    if (!mirrored) return "scale(1, -1)";
    
    // Calculate center X to flip around it
    let centerX = 0;
    if (boardBounds) {
      centerX = (boardBounds.minX + boardBounds.maxX) / 2;
    } else {
      // Fallback if no bounds (e.g. use viewBox center)
      centerX = viewBox.x + viewBox.w / 2;
    }
    
    // Translate to center, flip X, translate back
    // Combined with Y flip: scale(-1, -1) and translate(2*centerX, 0)
    return `translate(${2 * centerX}, 0) scale(-1, -1)`;
  }, [mirrored, boardBounds, viewBox]);

  return (
    <div className="flex-1 relative border-r border-slate-800 last:border-r-0">
      <div className="absolute top-2 left-2 right-2 flex justify-between items-start z-10 px-2 pointer-events-none">
        <div className="flex items-center gap-2 pointer-events-auto">
          <div className="text-xs font-bold text-slate-500 bg-slate-900/50 px-2 rounded">
            {title}
          </div>
          {allowMirror && (
            <button
              onClick={() => setMirrored(!mirrored)}
              className={`p-1 rounded border transition-colors ${
                mirrored
                  ? "bg-blue-600 text-white border-blue-500"
                  : "bg-slate-800 text-slate-400 border-slate-600 hover:bg-slate-700"
              }`}
              title="Odbij lustrzanie (Mirror)"
            >
              <FlipHorizontal size={14} />
            </button>
          )}
        </div>
        <button
          onClick={() => onExport(mirrored)}
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

        <g transform={transform}>
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
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const boardBounds = useMemo(() => {
    const profile = layers.find(
      (l) =>
        l.name.toLowerCase().includes("profile") ||
        l.name.toLowerCase().includes("outline") ||
        l.name.toLowerCase().includes("edge") ||
        l.name.toLowerCase().includes("gm1") ||
        l.name.toLowerCase().includes("gko")
    );
    if (profile && profile.data && profile.data.bounds) return profile.data.bounds;

    // Fallback: combined bounds of all layers
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let hasContent = false;
    layers.forEach((l) => {
      if (!l.data || !l.data.bounds) return;
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

    // 1. Drills (Blue)
    if (
      lower.includes(".drl") ||
      lower.includes(".xln") ||
      lower.includes("drill") ||
      lower.includes(".drd")
    ) {
      return { color: "#00a0ff", opacity: 0.9, order: 100 };
    }

    // 2. Profile / Outline (Dark Orange)
    if (
      lower.includes("profile") ||
      lower.includes("outline") ||
      lower.includes("edge") ||
      lower.includes("gm1") ||
      lower.includes("gko")
    ) {
      return { color: "#c08000", order: 90 };
    }

    // 3. Paste (Dark Yellow)
    if (
      lower.includes("paste") ||
      lower.includes("gtp") ||
      lower.includes("gbp") ||
      lower.includes("stencil")
    ) {
      return { color: "#a0a000", opacity: 0.8, order: 60 };
    }

    // 4. Soldermask (Dark Green)
    if (
      lower.includes("mask") ||
      lower.includes("gts") ||
      lower.includes("gbs")
    ) {
      return { color: "#00a000", opacity: 0.5, order: 50 };
    }

    // 5. Silkscreen (Gray)
    if (
      lower.includes("silk") ||
      lower.includes("gto") ||
      lower.includes("gbo") ||
      lower.includes("legend")
    ) {
      return { color: "#808080", order: 80 };
    }

    // 6. Copper (Red/Blue)
    if (
      lower.includes("top") ||
      lower.includes("front") ||
      lower.match(/f[._-]cu/) ||
      lower.endsWith(".gtl")
    ) {
      return { color: "#a00000", opacity: 0.9, order: 10, inverted: true };
    }

    if (
      lower.includes("bottom") ||
      lower.includes("back") ||
      lower.match(/b[._-]cu/) ||
      lower.endsWith(".gbl")
    ) {
      return { color: "#0000a0", opacity: 0.9, order: 10, inverted: true };
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
          id: crypto.randomUUID(),
          name: file.name,
          visible: true,
          color: style.color,
          opacity: style.opacity || 0.9,
          data: data,
          order: style.order,
          inverted: style.inverted || false,
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
      
      // Calculate the actual scale factor used by preserveAspectRatio="xMidYMid meet"
      // "meet" scales the viewBox to fit within the viewport while maintaining aspect ratio.
      // The scale factor (pixels per unit) is determined by the dimension that is "filled".
      // We need the inverse: units per pixel.
      // It is the maximum of (viewBox.w / width) and (viewBox.h / height).
      const scale = Math.max(viewBox.w / width, viewBox.h / height);

      setViewBox((prev) => ({
        ...prev,
        x: prev.x - dx * scale,
        y: prev.y - dy * scale,
      }));
      setStartPan({ x: e.clientX, y: e.clientY });
    }
  };

  const handleExport = async (layersToExport, name, mirrored = false) => {
    setIsExporting(true);
    setExportProgress(0);

    // Allow UI to update
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Use the global boardBounds (calculated from Profile or all visible layers)
    // This ensures inversion uses the correct board size
    const exportBounds = boardBounds;

    // Calculate transform for export
    let transform = "scale(1, -1)";
    if (mirrored) {
        let centerX = 0;
        if (exportBounds) {
            centerX = (exportBounds.minX + exportBounds.maxX) / 2;
        } else {
            // Fallback if no bounds, use viewBox center
            centerX = viewBox.x + viewBox.w / 2;
        }
        transform = `translate(${2 * centerX}, 0) scale(-1, -1)`;
    }

    // Create a temporary SVG string
    // We use the current viewBox for dimensions
    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}" width="${viewBox.w}mm" height="${viewBox.h}mm">`;
    svgContent += `<g transform="${transform}">`;

    const visibleLayers = layersToExport.filter((l) => l.visible);
    const total = visibleLayers.length;
    let current = 0;

    for (const layer of visibleLayers) {
      const isProfile =
        layer.name.toLowerCase().includes("profile") ||
        layer.name.toLowerCase().includes("outline") ||
        layer.name.toLowerCase().includes("edge") ||
        layer.name.toLowerCase().includes("gm1") ||
        layer.name.toLowerCase().includes("gko");

      if (isProfile) {
        // For profile layers, we want the centerline (stroke) without thickness
        const d = generateProfilePath(layer);
        if (d) {
           // Use stroke instead of fill, thin line (0.1mm)
           svgContent += `<path d="${d}" stroke="${layer.color}" stroke-width="0.1" fill="none" />`;
        }
      } else {
        // Generate path using Paper.js logic (synchronous but heavy)
        const d = generateMergedPath(layer, boardBounds);
        if (d) {
          svgContent += `<path d="${d}" fill="${layer.color}" fill-rule="nonzero" />`;
        }
      }
      
      current++;
      setExportProgress(Math.round((current / total) * 100));
      // Yield to UI
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    svgContent += `</g></svg>`;

    const blob = new Blob([svgContent], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setIsExporting(false);
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
      <div 
        className={`w-72 bg-slate-900 border-r border-slate-800 flex flex-col shadow-xl z-10 ${
          dragActive ? "bg-slate-800 ring-2 ring-blue-500 ring-inset" : ""
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
        <div className="p-4 border-b border-slate-800 bg-slate-900 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2 text-blue-400">
              <Layers className="w-6 h-6" />
              Gerber Viewer
            </h1>
            <p className="text-xs text-slate-500 mt-1">Podgląd Gerber & Drill</p>
          </div>
          {layers.length > 0 && (
            <button
              onClick={() => {
                if (confirm("Czy na pewno chcesz usunąć wszystkie warstwy?")) {
                  setLayers([]);
                }
              }}
              className="p-2 text-slate-500 hover:text-red-400 hover:bg-slate-800 rounded transition-colors"
              title="Wyczyść wszystkie warstwy"
            >
              <Trash2 size={20} />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 relative">
          {dragActive && (
            <div className="absolute inset-0 z-50 bg-blue-500/20 flex items-center justify-center backdrop-blur-sm rounded-lg pointer-events-none">
              <div className="text-center p-4">
                <Upload className="w-12 h-12 mx-auto mb-2 text-blue-200" />
                <p className="text-blue-100 font-bold">Upuść pliki tutaj</p>
              </div>
            </div>
          )}
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
        {isExporting && (
          <div className="absolute inset-0 z-[100] bg-black/70 flex flex-col items-center justify-center backdrop-blur-sm">
            <div className="bg-slate-800 p-6 rounded-xl shadow-2xl border border-slate-700 w-80 text-center">
              <h3 className="text-lg font-bold text-white mb-4">
                Generowanie SVG...
              </h3>
              <div className="w-full bg-slate-700 rounded-full h-4 mb-2 overflow-hidden">
                <div
                  className="bg-blue-500 h-full"
                  style={{ width: `${exportProgress}%` }}
                />
              </div>
              <p className="text-sm text-slate-400">{exportProgress}%</p>
            </div>
          </div>
        )}
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
          className="flex-1 bg-slate-950 relative overflow-hidden flex flex-row"
        >
          {layers.length === 0 && (
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
            onExport={() =>
              handleExport(
                layers.filter((l) => {
                  const side = getLayerSide(l.name);
                  return side === "top" || side === "both";
                }),
                "pcb_top"
              )
            }
            boardBounds={boardBounds}
          />

          <GerberView
            title="BOTTOM"
            allowMirror={true}
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
            onExport={(isMirrored) =>
              handleExport(
                layers.filter((l) => {
                  const side = getLayerSide(l.name);
                  return side === "bottom" || side === "both";
                }),
                "pcb_bottom",
                isMirrored
              )
            }
            boardBounds={boardBounds}
          />
        </div>

        {/* FOOTER INFO */}
        <div className="bg-slate-900 text-slate-500 text-[10px] px-4 py-1 flex justify-between items-center border-t border-slate-800">
          <span>
            Pozycja: {Math.round(viewBox.x + viewBox.w / 2)},{" "}
            {Math.round(viewBox.y + viewBox.h / 2)}
          </span>
          <span>Autor: Sagan (2025)</span>
          <span>Skala: {(100 / viewBox.w).toFixed(2)}x</span>
        </div>
      </div>
    </div>
  );
}
