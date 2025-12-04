import paper from "paper";
import ClipperLib from "clipper-lib";

// Helper to parse points from SVG path data is no longer needed as we use Paper.js flatten

export const traceToOutlinePath = (d, width) => {
  // This function is kept for reference or other uses, but generateMergedPath uses its own logic
  // We can update this to use the same flatten logic if needed, but for now let's focus on generateMergedPath
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
  // ... (rest of traceToOutlinePath is unchanged for now as it's likely not the main one used)
  if (points.length < 2) return "";

  let path = "";
  const r = width / 2;

  points.forEach((p) => {
    path += `M ${p.x} ${p.y} m -${r}, 0 a ${r},${r} 0 1,1 ${
      r * 2
    },0 a ${r},${r} 0 1,1 -${r * 2},0 `;
  });

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) continue;

    const nx = (-dy / len) * r;
    const ny = (dx / len) * r;

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

export const generateMergedPath = (layerData, boardBounds = null) => {
  if (!layerData || !layerData.data) return "";
  const { data, inverted } = layerData;

  // Setup Paper.js
  if (typeof document !== 'undefined') {
      const canvas = document.createElement("canvas");
      paper.setup(canvas);
  } else {
      if (!paper.project) {
          paper.setup(new paper.Size(1000, 1000));
      }
  }

  // Scale factor to improve boolean operation precision
  // Reduced from 1000 to 100 to avoid potential overflow with large boards
  const SCALE = 100;

  // Helper: Convert Paper.js item to Clipper Paths
  const itemToClipperPaths = (item) => {
      const paths = [];
      
      // Helper to process a single Path
      const processPathItem = (pathItem) => {
          // Flatten to linear segments
          // We use a small tolerance relative to the scale
          // Lower value = smoother curves (more segments)
          pathItem.flatten(0.005 * SCALE);
          
          const path = [];
          if (pathItem.segments) {
              pathItem.segments.forEach(s => {
                  path.push({
                      X: Math.round(s.point.x),
                      Y: Math.round(s.point.y)
                  });
              });
              // Ensure closed? Gerber regions are usually closed.
              // If it's a trace converted to outline, it's closed.
              if (pathItem.closed && path.length > 0) {
                  paths.push(path);
              }
          }
      };

      if (item instanceof paper.CompoundPath) {
          item.children.forEach(child => processPathItem(child));
      } else if (item instanceof paper.Path) {
          processPathItem(item);
      } else if (item instanceof paper.Group) {
           item.children.forEach(child => {
               if (child instanceof paper.CompoundPath) {
                   child.children.forEach(c => processPathItem(c));
               } else if (child instanceof paper.Path) {
                   processPathItem(child);
               }
           });
      }
      return paths;
  };

  // Helper: Convert Clipper Paths to SVG Path Data
  const clipperPathsToSVG = (paths) => {
      if (!paths || paths.length === 0) return "";
      
      let d = "";
      paths.forEach(path => {
          if (path.length === 0) return;
          d += `M ${path[0].X / SCALE} ${path[0].Y / SCALE} `;
          for (let i = 1; i < path.length; i++) {
              d += `L ${path[i].X / SCALE} ${path[i].Y / SCALE} `;
          }
          d += "Z ";
      });
      return d;
  };

  let currentSubject = []; // Array of Clipper Paths


  const processPath = (p) => {
    let item = null;

    try {
      if (p.type === "trace") {
        const width = p.aperture?.params[0] || 0.2;
        if (width > 0) {
          // Use Paper.js to parse and flatten the path (handles Arcs/Curves)
          const tempPath = new paper.Path(p.d);
          // Scale up for precision
          tempPath.scale(SCALE, [0, 0]);
          // Flatten curves to line segments.
          // Lower value = smoother curves
          tempPath.flatten(0.01 * SCALE);  
          
          const points = tempPath.segments.map(s => ({x: s.point.x, y: s.point.y}));
          tempPath.remove();

          if (points.length > 0) {
             const r = (width * SCALE) / 2;
             const parts = [];

             // 1. Add circles at Start and End points
             parts.push(new paper.Path.Circle({ center: [points[0].x, points[0].y], radius: r }));
             if (points.length > 1) {
                 parts.push(new paper.Path.Circle({ center: [points[points.length-1].x, points[points.length-1].y], radius: r }));
             }

             // 2. Create rects for segments and circles for sharp corners
             for(let i=0; i<points.length-1; i++) {
                 const p1 = points[i];
                 const p2 = points[i+1];
                 const dx = p2.x - p1.x;
                 const dy = p2.y - p1.y;
                 const len = Math.sqrt(dx * dx + dy * dy);
                 if (len === 0) continue;

                 const nx = (-dy / len) * r;
                 const ny = (dx / len) * r;

                 const c1 = [p1.x + nx, p1.y + ny];
                 const c2 = [p1.x - nx, p1.y - ny];
                 const c3 = [p2.x - nx, p2.y - ny];
                 const c4 = [p2.x + nx, p2.y + ny];

                 const rect = new paper.Path({ segments: [c1, c2, c3, c4], closed: true });
                 parts.push(rect);

                 // Add circle at joint if angle is sharp enough or just to be safe
                 if (i < points.length - 2) {
                     const p3 = points[i+2];
                     const dx2 = p3.x - p2.x;
                     const dy2 = p3.y - p2.y;
                     
                     const angle1 = Math.atan2(dy, dx);
                     const angle2 = Math.atan2(dy2, dx2);
                     let diff = Math.abs(angle1 - angle2);
                     if (diff > Math.PI) diff = 2 * Math.PI - diff;
                     
                     if (diff > 0.1) { // ~5.7 degrees
                         parts.push(new paper.Path.Circle({ center: [p2.x, p2.y], radius: r }));
                     }
                 }
             }
             
             // Use Group to hold parts. We don't need CompoundPath logic here as we convert to Clipper immediately.
             item = new paper.Group({ children: parts });
          }
        }
      } else if (p.type === "region") {
        // Use CompoundPath for regions to handle holes correctly.
        // Regions in Gerber (G36/G37) can have multiple contours (holes).
        item = new paper.CompoundPath(p.d);
        item.fillRule = 'nonzero';
        // Fix winding order for nonzero fill rule
        item.reorient(true, 'nonzero');
        item.scale(SCALE, [0, 0]);
      } else if (p.type === "flash") {
        const params = p.aperture?.params || [];
        const type = p.aperture?.type || "C";
        let size = params[0] || 0.8;
        if (size <= 0) size = 0.001;

        // Scale size
        size *= SCALE;
        const px = p.x * SCALE;
        const py = p.y * SCALE;

        if (type === "C") {
          item = new paper.Path.Circle({
            center: [px, py],
            radius: size / 2,
          });
        } else if (type === "R") {
          const rawW = params[0] !== undefined ? params[0] : (size / SCALE);
          const rawH = params[1] !== undefined ? params[1] : rawW;
          
          const w = rawW * SCALE;
          const h = rawH * SCALE;
          
          if (w > 0 && h > 0) {
            item = new paper.Path.Rectangle({
              point: [px - w / 2, py - h / 2],
              size: [w, h],
            });
          }
        } else if (type === "O") {
          const rawSize = params[0] || 0.8;
          const w = (params[0] || rawSize) * SCALE;
          const h = (params[1] || (params[0] || rawSize)) * SCALE;
          const r = Math.min(w, h) / 2;
          if (w > 0 && h > 0) {
            item = new paper.Path.Rectangle({
              point: [px - w / 2, py - h / 2],
              size: [w, h],
              radius: r,
            });
          }
        } else if (type === "P") {
          const diameter = (params[0] || 0.8) * SCALE;
          const vertices = params[1] || 6;
          const rotation = params[2] || 0;
          const r = diameter / 2;
          if (r > 0) {
            item = new paper.Path.RegularPolygon({
              center: [px, py],
              sides: vertices,
              radius: r,
            });
            if (rotation) item.rotate(rotation);
          }
        } else {
          // Macros
          const macro = data.macros?.[type];
          if (macro) {
             // Helper to resolve value
             const val = (v) => {
              if (!v) return 0;
              let expr = v.toString();
              // Do NOT scale here. We scale the final macroItem.
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

            let macroItem = null;

            macro.forEach((block) => {
              const rawParts = block.replace(/\*$/, "").split(",");
              const primType = parseInt(rawParts[0], 10);
              let pm = null;
              let exposure = 1;

              if (primType === 1) {
                // Circle
                exposure = val(rawParts[1]);
                const diam = val(rawParts[2]);
                const cx = val(rawParts[3]);
                const cy = val(rawParts[4]);
                if (diam > 0) {
                  pm = new paper.Path.Circle({
                    center: [cx, cy],
                    radius: diam / 2
                  });
                }
              } else if (primType === 21) {
                 // Center Rect
                 exposure = val(rawParts[1]);
                 const w = val(rawParts[2]);
                 const h = val(rawParts[3]);
                 const cx = val(rawParts[4]);
                 const cy = val(rawParts[5]);
                 const rot = val(rawParts[6]);
                 if (w > 0 && h > 0) {
                    pm = new paper.Path.Rectangle({
                        point: [-w/2, -h/2],
                        size: [w, h]
                    });
                    pm.position = new paper.Point(cx, cy);
                    if (rot) pm.rotate(rot, [0, 0]);
                 }
              } else if (primType === 22) {
                 // Lower Left Rect
                 exposure = val(rawParts[1]);
                 const w = val(rawParts[2]);
                 const h = val(rawParts[3]);
                 const x = val(rawParts[4]);
                 const y = val(rawParts[5]);
                 const rot = val(rawParts[6]);
                 if (w > 0 && h > 0) {
                    pm = new paper.Path.Rectangle({
                        point: [x, y],
                        size: [w, h]
                    });
                    if (rot) pm.rotate(rot, [0, 0]);
                 }
              } else if (primType === 4) {
                 // Outline
                 exposure = val(rawParts[1]);
                 const count = val(rawParts[2]);
                 const pts = [];
                 for (let k = 0; k < count; k++) {
                   pts.push([
                     val(rawParts[3 + k * 2]),
                     val(rawParts[4 + k * 2]),
                   ]);
                 }
                 const rot = val(rawParts[rawParts.length - 1]);
                 if (pts.length > 1) {
                   pm = new paper.Path({ segments: pts, closed: true });
                   if (rot) pm.rotate(rot, [0, 0]);
                 }
              } else if (primType === 5) {
                 // Polygon
                 exposure = val(rawParts[1]);
                 const vertices = val(rawParts[2]);
                 const cx = val(rawParts[3]);
                 const cy = val(rawParts[4]);
                 const diam = val(rawParts[5]);
                 const rot = val(rawParts[6]);
                 if (diam > 0) {
                   pm = new paper.Path.RegularPolygon({
                     center: [cx, cy],
                     sides: vertices,
                     radius: diam / 2
                   });
                   if (rot) pm.rotate(rot, [0, 0]);
                 }
              } else if (primType === 7) {
                 // Thermal
                 const cx = val(rawParts[1]);
                 const cy = val(rawParts[2]);
                 const outer = val(rawParts[3]);
                 const inner = val(rawParts[4]);
                 const gap = val(rawParts[5]);
                 const rot = val(rawParts[6]);
                 
                 if (outer > 0) {
                   const outerCircle = new paper.Path.Circle({ center: [cx, cy], radius: outer / 2 });
                   const innerCircle = new paper.Path.Circle({ center: [cx, cy], radius: inner / 2 });
                   
                   // Create crosshair gaps
                   const gapRectH = new paper.Path.Rectangle({ point: [cx - outer/2, cy - gap/2], size: [outer, gap] });
                   const gapRectV = new paper.Path.Rectangle({ point: [cx - gap/2, cy - outer/2], size: [gap, outer] });
                   if (rot) {
                       gapRectH.rotate(rot, [0, 0]);
                       gapRectV.rotate(rot, [0, 0]);
                   }
                   
                   let temp = outerCircle.subtract(innerCircle);
                   temp = temp.subtract(gapRectH);
                   pm = temp.subtract(gapRectV);
                   
                   // Cleanup
                   outerCircle.remove();
                   innerCircle.remove();
                   gapRectH.remove();
                   gapRectV.remove();
                   if (temp !== pm) temp.remove();
                 }
              } else if (primType === 20 || primType === 2) {
                 // Vector Line
                 exposure = val(rawParts[1]);
                 const width = val(rawParts[2]);
                 const sx = val(rawParts[3]);
                 const sy = val(rawParts[4]);
                 const ex = val(rawParts[5]);
                 const ey = val(rawParts[6]);
                 const rot = val(rawParts[7]);
                 
                 if (width > 0) {
                     // Create line segment shape (circle ends + rect body)
                     const r = width / 2;
                     const c1 = new paper.Path.Circle({ center: [sx, sy], radius: r });
                     const c2 = new paper.Path.Circle({ center: [ex, ey], radius: r });
                     
                     const dx = ex - sx;
                     const dy = ey - sy;
                     const len = Math.sqrt(dx*dx + dy*dy);
                     
                     if (len > 0) {
                         const nx = (-dy / len) * r;
                         const ny = (dx / len) * r;
                         const p1 = [sx + nx, sy + ny];
                         const p2 = [sx - nx, sy - ny];
                         const p3 = [ex - nx, ey - ny];
                         const p4 = [ex + nx, ey + ny];
                         const rect = new paper.Path({ segments: [p1, p2, p3, p4], closed: true });
                         
                         let temp = c1.unite(c2);
                         pm = temp.unite(rect);
                         
                         c1.remove();
                         c2.remove();
                         rect.remove();
                         if (temp !== pm) temp.remove();
                     } else {
                         pm = c1;
                         c2.remove();
                     }
                     
                     if (rot) pm.rotate(rot, [0, 0]);
                 }
              }
              
              if (pm) {
                  if (!macroItem) {
                      macroItem = pm;
                  } else {
                      if (exposure === 1) {
                          const res = macroItem.unite(pm);
                          macroItem.remove();
                          pm.remove();
                          macroItem = res;
                      } else {
                          const res = macroItem.subtract(pm);
                          macroItem.remove();
                          pm.remove();
                          macroItem = res;
                      }
                  }
              }
            });
            
            if (macroItem) {
                macroItem.position = macroItem.position.add(new paper.Point(p.x, p.y));
                // Scale the macro item
                macroItem.scale(SCALE, [0, 0]); // Scale relative to origin (0,0) because position was added?
                // Wait, position was added (p.x, p.y).
                // If we scale relative to 0,0, the position will be scaled too.
                // p.x, p.y are raw.
                // So macroItem is at raw position.
                // Scaling it by SCALE relative to 0,0 will move it to scaled position and scale its size.
                // This is correct.
                item = macroItem;
            }
          }
        }
      }

      if (item) {
          const newPaths = itemToClipperPaths(item);
          item.remove(); // Cleanup Paper item
          
          if (p.polarity === 'clear') {
              // Difference
              const clipper = new ClipperLib.Clipper();
              clipper.AddPaths(currentSubject, ClipperLib.PolyType.ptSubject, true);
              clipper.AddPaths(newPaths, ClipperLib.PolyType.ptClip, true);
              
              const solution = new ClipperLib.Paths();
              clipper.Execute(ClipperLib.ClipType.ctDifference, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
              currentSubject = solution;
          } else {
              // Union (Lazy - just add to list)
              currentSubject.push(...newPaths);
          }
      }
    } catch (e) {
      console.warn("Skipping invalid path in PaperJS generation", e);
    }
  };

  data.paths.forEach(processPath);

  // Final Union
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(currentSubject, ClipperLib.PolyType.ptSubject, true);
  const finalSolution = new ClipperLib.Paths();
  clipper.Execute(ClipperLib.ClipType.ctUnion, finalSolution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  
  // Handle Inversion
  if (inverted && boardBounds) {
    const boundsPath = new ClipperLib.Path();
    
    const minX = Math.round(boardBounds.minX * SCALE);
    const minY = Math.round(boardBounds.minY * SCALE);
    const maxX = Math.round(boardBounds.maxX * SCALE);
    const maxY = Math.round(boardBounds.maxY * SCALE);

    // Clockwise rectangle
    boundsPath.push(new ClipperLib.IntPoint(minX, minY));
    boundsPath.push(new ClipperLib.IntPoint(maxX, minY));
    boundsPath.push(new ClipperLib.IntPoint(maxX, maxY));
    boundsPath.push(new ClipperLib.IntPoint(minX, maxY));

    const boundsPaths = new ClipperLib.Paths();
    boundsPaths.push(boundsPath);

    const invertedSolution = new ClipperLib.Paths();
    const invertClipper = new ClipperLib.Clipper();
    
    // Subject: The Bounds (The "Board Material")
    invertClipper.AddPaths(boundsPaths, ClipperLib.PolyType.ptSubject, true);
    
    // Clip: The Content (The "Copper to Remove" - which is what we have in finalSolution)
    invertClipper.AddPaths(finalSolution, ClipperLib.PolyType.ptClip, true);
    
    // Execute Difference: Bounds - Content
    invertClipper.Execute(ClipperLib.ClipType.ctDifference, invertedSolution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    
    return clipperPathsToSVG(invertedSolution);
  }

  return clipperPathsToSVG(finalSolution);
};

export const generateProfilePath = (layerData) => {
  if (!layerData || !layerData.data || !layerData.data.paths) return "";
  // Simply concatenate all path data strings. 
  // This preserves the centerline without expanding to aperture width.
  return layerData.data.paths.map(p => p.d).join(" ");
};