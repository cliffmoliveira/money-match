/**
 * One-off: remove the baked-in checkerboard background from a logo PNG by
 * flood-filling transparency from the image borders inward. Only background
 * connected to the edges is removed, so light pixels enclosed by the logo
 * (e.g. white text) are preserved.
 *
 * Usage: node scripts/strip-bg.js <path-to-png>
 */
const Jimp = require('jimp');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/strip-bg.js <path-to-png>');
  process.exit(1);
}

// A pixel counts as background if it's light and nearly gray (covers the
// white + light-gray checker squares and their anti-aliased blends).
function isBackground(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min <= 18 && min >= 200;
}

(async () => {
  const img = await Jimp.read(file);
  const { width, height, data } = img.bitmap;
  const idx = (x, y) => (y * width + x) * 4;
  const visited = new Uint8Array(width * height);
  const queue = [];

  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (visited[p]) return;
    visited[p] = 1;
    const o = p * 4;
    if (isBackground(data[o], data[o + 1], data[o + 2])) {
      data[o + 3] = 0; // transparent
      queue.push(x, y);
    }
  };

  // Seed from every border pixel.
  for (let x = 0; x < width; x++) { enqueue(x, 0); enqueue(x, height - 1); }
  for (let y = 0; y < height; y++) { enqueue(0, y); enqueue(width - 1, y); }

  let head = 0;
  while (head < queue.length) {
    const x = queue[head++];
    const y = queue[head++];
    enqueue(x + 1, y); enqueue(x - 1, y);
    enqueue(x, y + 1); enqueue(x, y - 1);
  }

  let cleared = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] === 0) cleared++;
  await img.writeAsync(file);
  console.log(`Cleared ${cleared}/${width * height} px (${((cleared / (width * height)) * 100).toFixed(1)}%) to transparent.`);
  process.exit(0);
})();
