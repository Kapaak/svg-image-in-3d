// Works out how high each layer stands, so anything painted over another shape
// or line sits physically above it, like stacked paper cut-outs. Footprints are
// rasterised once per SVG; heights are recomputed cheaply on every rebuild.

// Upper bound on the total number of footprint pixels kept in memory.
const PIXEL_BUDGET = 40e6
const PAD = 2

// Footprint mask values.
const PARTIAL = 1 // touched by the layer's (antialiased) edge
const FULL = 2 // completely inside the layer

function addPolygon(path, points) {
  path.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y)
  path.closePath()
}

function drawLayer(ctx, layer) {
  if (layer.kind === 'fill') {
    for (const shape of layer.shapes) {
      const path = new Path2D()
      addPolygon(path, shape.getPoints())
      for (const hole of shape.holes) addPolygon(path, hole.getPoints())
      ctx.fill(path, 'evenodd')
    }
    return
  }
  // Stroke triangles come in mixed winding; flip them to one orientation so
  // 'nonzero' fills their union instead of cancelling overlaps out.
  const path = new Path2D()
  const t = layer.tri
  for (let i = 0; i < t.length; i += 6) {
    let [ax, ay, bx, by, cx, cy] = t.subarray(i, i + 6)
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0) [bx, by, cx, cy] = [cx, cy, bx, by]
    path.moveTo(ax, ay)
    path.lineTo(bx, by)
    path.lineTo(cx, cy)
    path.closePath()
  }
  ctx.fill(path, 'nonzero')
}

// Grows a mask by one pixel so hairline strokes still register as overlapping
// the shapes they are drawn across.
function dilate(data, w, h) {
  const out = data.slice()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && !out[ny * w + nx]) out[ny * w + nx] = PARTIAL
        }
      }
    }
  }
  return out
}

// Attaches `footprint` ({ x0, y0, w, h, data }) to every layer and returns the
// grid size. A generator that pauses between layers (see runSliced).
export function* rasterizeFootprints(layers, bounds, maxDim) {
  const normalizedArea = layers.reduce((sum, { bounds: b }) => sum + ((b.max.x - b.min.x) * (b.max.y - b.min.y)) / maxDim ** 2, 0)
  const resolution = Math.floor(Math.min(1024, Math.max(256, Math.sqrt(PIXEL_BUDGET / Math.max(normalizedArea, 1e-6)))))
  const scale = (resolution - 2 * PAD) / maxDim
  const width = Math.ceil((bounds.max.x - bounds.min.x) * scale) + 2 * PAD
  const height = Math.ceil((bounds.max.y - bounds.min.y) * scale) + 2 * PAD

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const toGrid = (v, min) => (v - min) * scale + PAD

  for (const layer of layers) {
    const b = layer.bounds
    const x0 = Math.max(0, Math.floor(toGrid(b.min.x, bounds.min.x)) - 2)
    const y0 = Math.max(0, Math.floor(toGrid(b.min.y, bounds.min.y)) - 2)
    const x1 = Math.min(width, Math.ceil(toGrid(b.max.x, bounds.min.x)) + 2)
    const y1 = Math.min(height, Math.ceil(toGrid(b.max.y, bounds.min.y)) + 2)
    const w = x1 - x0
    const h = y1 - y0
    yield
    if (w <= 0 || h <= 0) {
      layer.footprint = null
      continue
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(x0, y0, w, h)
    ctx.setTransform(scale, 0, 0, scale, PAD - bounds.min.x * scale, PAD - bounds.min.y * scale)
    drawLayer(ctx, layer)

    const pixels = ctx.getImageData(x0, y0, w, h).data
    let data = new Uint8Array(w * h)
    for (let i = 0; i < data.length; i++) {
      const alpha = pixels[i * 4 + 3]
      data[i] = alpha === 255 ? FULL : alpha > 0 ? PARTIAL : 0
    }
    if (layer.kind === 'stroke') data = dilate(data, w, h)
    layer.footprint = { x0, y0, w, h, data, hasFull: data.includes(FULL) }
  }

  return { width, height }
}

// The z range ({ floor, top }, SVG units) of every layer. A layer resting on
// nothing spans 0..base; otherwise it stands `step` (fills) or `lift` (strokes)
// above the highest thing under it. Fills stay solid down to the back, while
// strokes become ridges sunk `embed` into the surface they're drawn on, so the
// sides of the object show the shapes' colours rather than walls of ink.
// `rise(i, thickness)` says how far (in multiples of its thickness) layer i
// climbs over itself where it self-crosses; later layers have to clear that too.
// A generator that pauses between layers (see runSliced).
export function* stackHeights(layers, grid, { base, step, lift, embed, rise = () => 0 }) {
  const heights = new Float32Array(grid.width * grid.height)
  const ranges = []

  for (const [index, layer] of layers.entries()) {
    yield
    const fp = layer.footprint
    if (!fp) {
      rise(index, base)
      ranges.push({ floor: 0, top: base })
      continue
    }

    // Fills only look at pixels fully inside them, so shapes that merely touch
    // along an edge are not stacked; strokes count every pixel they touch.
    const queryMin = layer.kind === 'stroke' || !fp.hasFull ? PARTIAL : FULL
    let under = 0
    for (let y = 0; y < fp.h; y++) {
      const row = (fp.y0 + y) * grid.width + fp.x0
      for (let x = 0; x < fp.w; x++) {
        if (fp.data[y * fp.w + x] >= queryMin && heights[row + x] > under) under = heights[row + x]
      }
    }

    const isStroke = layer.kind === 'stroke'
    const top = under > 0 ? Math.max(base, under + (isStroke ? lift : step)) : base
    const floor = isStroke && under > 0 ? Math.max(0, under - embed) : 0
    const highest = top + rise(index, top - floor) * (top - floor)
    for (let y = 0; y < fp.h; y++) {
      const row = (fp.y0 + y) * grid.width + fp.x0
      for (let x = 0; x < fp.w; x++) {
        if (fp.data[y * fp.w + x] && heights[row + x] < highest) heights[row + x] = highest
      }
    }
    ranges.push({ floor, top })
  }
  return ranges
}
