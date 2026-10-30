import * as THREE from 'three'

// Resolution of the silhouette the text is laid out in, and of the texture it
// is drawn into.
const MASK = 768
const TEXTURE = 2048
const NEWLINE = Symbol('newline')
const LINE_HEIGHT = 1.2
export const TEXT_WEIGHTS = { 100: 'Thin', 300: 'Light', 400: 'Regular', 700: 'Bold' }

const fontOf = (size, { weight, italic }) => `${italic ? 'italic ' : ''}${weight} ${size}px "LL Brown", "Helvetica Neue", Arial, sans-serif`

// Sets the font on a canvas; letter spacing is a percentage of the size.
function setFont(ctx, size, text) {
  ctx.font = fontOf(size, text)
  ctx.letterSpacing = `${(size * text.spacing) / 100}px`
}

export const textFontLoaded = (text) => document.fonts.check(fontOf(64, text), 'Aáčěž')

// Resolves once the text font is ready to draw with (it loads on first use).
export const textFontReady = (text) => document.fonts.load(fontOf(64, text), 'Aáčěž')

// The union of all layers as a MASK × MASK grid (1 = covered) over the square
// of side maxDim around the SVG. `mirror` flips it left to right, for text
// that is read from behind.
function silhouette({ layers, center, maxDim }, mirror) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = MASK
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const scale = MASK / maxDim
  const x0 = center.x - maxDim / 2
  const y0 = center.y - maxDim / 2
  const trace = (points) => {
    points.forEach((p, i) => {
      const x = (p.x - x0) * scale
      const px = mirror ? MASK - x : x
      if (i) ctx.lineTo(px, (p.y - y0) * scale)
      else ctx.moveTo(px, (p.y - y0) * scale)
    })
    ctx.closePath()
  }
  ctx.fillStyle = '#000'
  for (const layer of layers) {
    ctx.beginPath()
    for (const shape of layer.shapes) {
      trace(shape.getPoints(12))
      for (const hole of shape.holes) trace(hole.getPoints(12))
    }
    ctx.fill('evenodd')
  }
  const { data } = ctx.getImageData(0, 0, MASK, MASK)
  const mask = new Uint8Array(MASK * MASK)
  let top = MASK
  let bottom = 0
  for (let i = 0; i < mask.length; i++) {
    if (data[i * 4 + 3] < 128) continue
    mask[i] = 1
    const row = (i / MASK) | 0
    if (row < top) top = row
    if (row > bottom) bottom = row
  }
  return { mask, top, bottom: bottom + 1 }
}

// The stretches of a text line (a band of height `lh` starting at `y`) that
// lie fully inside the shape, narrowed by `pad` on both sides.
function runsAt(mask, y, lh, pad) {
  const rows = [0.2, 0.4, 0.6, 0.8].map((f) => Math.min(MASK - 1, Math.floor(y + lh * f)) * MASK)
  const runs = []
  let start = -1
  for (let x = 0; x <= MASK; x++) {
    const inside = x < MASK && rows.every((row) => mask[row + x])
    if (inside && start < 0) start = x
    if (!inside && start >= 0) {
      if (x - start - 2 * pad >= lh * 0.5) runs.push({ x: start + pad, width: x - start - 2 * pad })
      start = -1
    }
  }
  return runs
}

// Flows the words line by line into the shape at one font size, filling every
// stretch of a line in turn.
function layout(ctx, { mask }, tokens, text, size, startY, bottom) {
  setFont(ctx, size, text)
  const lh = size * LINE_HEIGHT
  const placed = []
  let i = 0
  let y = startY
  while (i < tokens.length && y + lh <= bottom) {
    let newline = false
    for (const run of runsAt(mask, y, lh, size * 0.12)) {
      let line = ''
      let width = 0
      while (i < tokens.length) {
        if (tokens[i] === NEWLINE) {
          i++
          newline = true
          break
        }
        const next = line ? `${line} ${tokens[i]}` : tokens[i]
        const nextWidth = ctx.measureText(next).width
        if (nextWidth > run.width) break
        line = next
        width = nextWidth
        i++
      }
      if (line) placed.push({ text: line, x: run.x + (run.width - width) / 2, y: y + lh / 2 })
      if (newline) break
    }
    y += lh
  }
  return { fits: i >= tokens.length, placed, endY: y }
}

function tokenize(text) {
  const tokens = []
  text.split(/\r?\n/).forEach((line, i) => {
    if (i) tokens.push(NEWLINE)
    tokens.push(...line.split(/\s+/).filter(Boolean))
  })
  return tokens
}

// A material showing `value` laid out inside the shape's silhouette at the
// largest size that fits, to be put on the faces from `faceUvs`. Returns null
// if there is nothing to show.
export function createTextMaterial(svg, text) {
  const { value, side, color } = text
  const tokens = tokenize(value)
  if (!tokens.length) return null

  const back = side === 'back'
  const shape = silhouette(svg, back)
  if (shape.top >= shape.bottom) return null

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = TEXTURE
  const ctx = canvas.getContext('2d')

  // Binary search for the largest size that fits (at least 6 px, and not
  // absurdly large for a few words).
  let lo = 6
  let hi = Math.max(lo, Math.floor((shape.bottom - shape.top) * 0.4))
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (layout(ctx, shape, tokens, text, mid, shape.top, shape.bottom).fits) lo = mid
    else hi = mid - 1
  }
  // The size setting shrinks the text from that largest size.
  lo = Math.max(6, Math.round(lo * Math.min(1, text.size / 100)))
  let result = layout(ctx, shape, tokens, text, lo, shape.top, shape.bottom)
  // Centre a block that doesn't fill the shape vertically.
  const shift = Math.floor((shape.bottom - result.endY) / 2)
  if (shift > 0) {
    const centred = layout(ctx, shape, tokens, text, lo, shape.top + shift, shape.bottom)
    if (centred.fits) result = centred
  }

  ctx.scale(TEXTURE / MASK, TEXTURE / MASK)
  setFont(ctx, lo, text)
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  for (const line of result.placed) ctx.fillText(line.text, line.x, line.y)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.flipY = false
  texture.anisotropy = 8
  // The text is drawn on top of the faces it lies on, so it is pulled a
  // little towards the camera in the depth test.
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  material.userData.color = color
  return material
}

// A copy of the front (or back) faces of a layer's geometry, with UVs that
// map the text over the SVG, so the text follows each part's own height.
export function createTextFaces(geometry, { center, maxDim }, side) {
  const back = side === 'back'
  const position = geometry.attributes.position
  const index = geometry.index
  const caps = geometry.groups.find((group) => group.materialIndex === 0) ?? { start: 0, count: index ? index.count : position.count }
  const x0 = center.x - maxDim / 2
  const y0 = center.y - maxDim / 2
  const positions = []
  const uvs = []
  const corner = (k) => (index ? index.getX(k) : k)
  for (let k = caps.start; k + 2 < caps.start + caps.count; k += 3) {
    const [a, b, c] = [corner(k), corner(k + 1), corner(k + 2)]
    const facing = (position.getX(b) - position.getX(a)) * (position.getY(c) - position.getY(a))
      - (position.getY(b) - position.getY(a)) * (position.getX(c) - position.getX(a))
    if (back ? facing >= 0 : facing <= 0) continue
    for (const v of [a, b, c]) {
      const x = position.getX(v)
      positions.push(x, position.getY(v), position.getZ(v))
      const u = (x - x0) / maxDim
      uvs.push(back ? 1 - u : u, (position.getY(v) - y0) / maxDim)
    }
  }
  if (!positions.length) return null
  const faces = new THREE.BufferGeometry()
  faces.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  faces.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return faces
}

export function disposeTextMaterial(material) {
  material.map.dispose()
  material.dispose()
}

// A material with `value` written in one row, repeated along a wall of a line
// that is `length` long and `thickness` high (SVG units). Returns it with the
// size in SVG units that its texture covers (to give createRibbonWallText).
export function createWallTextMaterial(text, length, thickness) {
  const { value, color } = text
  const words = tokenize(value).filter((token) => token !== NEWLINE)
  if (!words.length) return null

  const width = TEXTURE * 2
  const height = Math.min(width, Math.max(128, Math.round((width * thickness) / length)))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  // A share of the wall's height (never more than the wall has), or shrunk
  // until one copy fits along it.
  const phrase = words.join(' ')
  const unit = (thickness * width) / length
  let size = Math.min(0.4 * unit * (text.size / 100), 0.95 * unit)
  setFont(ctx, size, text)
  const natural = ctx.measureText(phrase).width
  if (natural > width * 0.95) size *= (width * 0.95) / natural
  setFont(ctx, size, text)
  const textWidth = ctx.measureText(phrase).width

  // Repeat the phrase along the wall with the chosen gap (a share of the font
  // size), as many whole copies as fit, centred.
  const gap = (size * text.gap) / 100
  const count = Math.max(1, Math.floor((width + gap) / (textWidth + gap)))
  const start = (width - (count * textWidth + (count - 1) * gap)) / 2
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  for (let i = 0; i < count; i++) ctx.fillText(phrase, start + i * (textWidth + gap), height / 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.flipY = false
  texture.anisotropy = 8
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  material.userData.color = color
  return { material, width: length, height: (length * height) / width }
}

/* ---------- Outlines of the lettering (for export) ---------- */

// Clipper works on integers: 1/16 texture pixel.
const TEXEL = 16
const OUTLINE_TOLERANCE = 0.25

// The edges of the lettering on a text material's texture, as closed loops of
// texture pixels (marching squares at half opacity, so the corners are smooth
// rather than stepped), thinned out within a quarter pixel. Each loop also has
// its box and its path in Clipper units.
export function textOutlines(material) {
  if (material.userData.outlines) return material.userData.outlines
  const canvas = material.map.image
  const { width, height } = canvas
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data
  const loops = traceLoops((x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : data[(y * width + x) * 4 + 3] / 255), width, height)
    .map((loop) => simplifyLoop(loop, OUTLINE_TOLERANCE))
    .filter((points) => points.length >= 3)
    .map((points) => {
      const xs = points.map(([x]) => x)
      const ys = points.map(([, y]) => y)
      return {
        box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        path: points.map(([x, y]) => ({ X: Math.round(x * TEXEL), Y: Math.round(y * TEXEL) })),
      }
    })
  material.userData.outlines = { width, height, loops }
  return material.userData.outlines
}

// Marching squares over `at(x, y)` (0..1), with the covered side always on the
// same side of each loop, so that holes run the other way round.
function traceLoops(at, width, height) {
  const edgeId = (horizontal, x, y) => ((y + 1) * (width + 2) + (x + 1)) * 2 + (horizontal ? 0 : 1)
  const next = new Map()
  const points = new Map()
  for (let y = -1; y < height; y++) {
    for (let x = -1; x < width; x++) {
      // Corners and sides clockwise from the top left.
      const corners = [[x, y, at(x, y)], [x + 1, y, at(x + 1, y)], [x + 1, y + 1, at(x + 1, y + 1)], [x, y + 1, at(x, y + 1)]]
      const inside = corners.map(([, , value]) => value >= 0.5)
      if (inside.every((on) => on === inside[0])) continue
      const ids = [edgeId(true, x, y), edgeId(false, x + 1, y), edgeId(true, x, y + 1), edgeId(false, x, y)]
      const crossings = []
      for (let side = 0; side < 4; side++) {
        const [x0, y0, a] = corners[side]
        const [x1, y1, b] = corners[(side + 1) % 4]
        if (inside[side] === inside[(side + 1) % 4]) continue
        const t = (0.5 - a) / (b - a)
        points.set(ids[side], [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t])
        crossings.push({ id: ids[side], enters: inside[(side + 1) % 4] })
      }
      if (crossings.length === 2) {
        const [from, to] = crossings[0].enters ? crossings : [crossings[1], crossings[0]]
        next.set(from.id, to.id)
        continue
      }
      // A saddle: the centre decides whether the covered corners are joined.
      const joined = corners.reduce((sum, [, , value]) => sum + value, 0) / 4 >= 0.5
      crossings.forEach((crossing, i) => {
        if (crossing.enters) next.set(crossing.id, crossings[(i + (joined ? 3 : 1)) % 4].id)
      })
    }
  }

  const loops = []
  const seen = new Set()
  for (const start of next.keys()) {
    if (seen.has(start)) continue
    const loop = []
    for (let id = start; id !== undefined && !seen.has(id); id = next.get(id)) {
      seen.add(id)
      loop.push(points.get(id))
    }
    if (loop.length >= 3) loops.push(loop)
  }
  return loops
}

// Douglas–Peucker on a closed loop: split at the point farthest from the
// start, then thin out both halves.
function simplifyLoop(loop, tolerance) {
  const distance = (p, a, b) => {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const length = Math.hypot(dx, dy)
    return length ? Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / length : Math.hypot(p[0] - a[0], p[1] - a[1])
  }
  const thin = (chain) => {
    const keep = new Uint8Array(chain.length)
    keep[0] = keep[chain.length - 1] = 1
    const stack = [[0, chain.length - 1]]
    while (stack.length) {
      const [first, last] = stack.pop()
      let worst = 0
      let index = -1
      for (let i = first + 1; i < last; i++) {
        const d = distance(chain[i], chain[first], chain[last])
        if (d > worst) {
          worst = d
          index = i
        }
      }
      if (worst > tolerance) {
        keep[index] = 1
        stack.push([first, index], [index, last])
      }
    }
    return chain.filter((_, i) => keep[i])
  }
  let far = 0
  loop.forEach((p, i) => {
    if (Math.hypot(p[0] - loop[0][0], p[1] - loop[0][1]) > Math.hypot(loop[far][0] - loop[0][0], loop[far][1] - loop[0][1])) far = i
  })
  if (!far) return loop
  const first = thin(loop.slice(0, far + 1))
  const second = thin([...loop.slice(far), loop[0]])
  return [...first.slice(0, -1), ...second.slice(0, -1)]
}
