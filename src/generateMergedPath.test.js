import { generateMergedPath } from './utils/gerberUtils.js';
import paper from 'paper-jsdom';
import assert from 'assert';

// Setup paper-jsdom environment
paper.setup(new paper.Size(1000, 1000));

// Mock Gerber Layer Data
const mockLayerData = {
  data: {
    paths: [
      {
        type: 'trace',
        d: 'M 0 0 L 10 0',
        aperture: { params: [1] } // 1mm width
      },
      {
        type: 'flash',
        x: 20,
        y: 0,
        aperture: { type: 'C', params: [2] } // 2mm circle
      }
    ],
    macros: {}
  }
};

console.log("Running generateMergedPath test...");

try {
  const svgPath = generateMergedPath(mockLayerData);
  console.log("Generated SVG Path:", svgPath);

  if (svgPath && typeof svgPath === 'string' && svgPath.length > 0) {
    console.log("✅ Test Passed: SVG path generated successfully.");
  } else {
    console.error("❌ Test Failed: No SVG path generated.");
    process.exit(1);
  }
} catch (error) {
  console.error("❌ Test Failed with error:", error);
  process.exit(1);
}
