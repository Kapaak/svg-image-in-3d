import ClipperLib from 'clipper-lib'
import * as THREE from 'three'
import { CREASE } from './edgeLines.js'
import { fitPathData } from './fitCurves.js'
import { textOutlines } from './textLabel.js'

// Longest side of the image the export is worked out at, in pixels.
const EXPORT_SIZE = 2048
// Clipper works on integers: 1/16 px.
const SCALE = 16
// Cell size (px) of the grid used to find triangles near each other on screen.
const CELL = 32
// Line drawings: stroke width (px).
const LINE_WIDTH = 1.5
// How far (px) the smooth curves written to the file may stray from the
// exact outlines.
const CURVE_TOLERANCE = 0.25

const screenArea = ([[ax, ay], [bx, by], [cx, cy]]) => Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2

export const EXPORT_STYLES = {
  shaded: { label: 'Shaded', suffix: '-3d' },
  edges: { label: 'Edges (visible)', suffix: '-3d-edges' },
  wireframe: { label: 'Wireframe (see-through)', suffix: '-3d-wireframe' },
}

// Exports what the camera sees as a flat vector image, in one of three styles:
// - shaded: one filled shape per visible flat face, coloured like the preview;
// - edges: a line drawing of the visible edges only;
// - wireframe: a line drawing of all edges, including hidden ones.
//
// Visibility is exact geometry rather than pixels:
// - An ID render (each triangle in its own colour) tells which triangles are
//   visible at all; hidden ones are left out.
// - Each visible triangle is then cut down to exactly its visible part: from
//   it, the parts of nearby triangles that are nearer to the camera are cut
//   away. So shapes never overlap and lines stop exactly where something
//   passes in front of them.
// Colours come from a normal render (without cast shadows), averaged over
// each flat face.
export function sceneToSvg({ renderer, scene, camera, model, style = 'shaded' }) {
  const width = camera.aspect >= 1 ? EXPORT_SIZE : Math.round(EXPORT_SIZE * camera.aspect)
  const height = camera.aspect >= 1 ? Math.round(EXPORT_SIZE / camera.aspect) : EXPORT_SIZE
  camera.updateMatrixWorld()
  model.updateMatrixWorld(true)

  const { triangles, groups, idScene, texts } = collectTriangles(model)
  if (!triangles.length) {
    disposeScene(idScene)
    return null
  }

  const point = new THREE.Vector3()
  const screen = triangles.map(({ vertices }) => vertices.map((v) => {
    point.copy(v).project(camera)
    return [((point.x + 1) / 2) * width, ((1 - point.y) / 2) * height]
  }))

  if (style === 'wireframe') {
    disposeScene(idScene)
    // Every feature edge once, in full.
    const { features, edgeIds } = featureEdges(triangles, screen)
    const drawn = new Set()
    const segments = []
    screen.forEach((corners, t) => {
      for (let e = 0; e < 3; e++) {
        if (!features[t][e] || drawn.has(edgeIds[t][e].id)) continue
        drawn.add(edgeIds[t][e].id)
        const [ax, ay] = corners[e]
        const [bx, by] = corners[(e + 1) % 3]
        segments.push([Math.round(ax * SCALE), Math.round(ay * SCALE), Math.round(bx * SCALE), Math.round(by * SCALE)])
      }
    })
    return lineDrawing(segments)
  }

  const ids = renderIds(renderer, idScene, camera, width, height)
  const shades = style === 'shaded' ? renderShades(renderer, scene, camera, width, height) : null
  disposeScene(idScene)

  // Count each triangle's visible pixels and add their colours to its face.
  const visiblePixels = new Uint32Array(triangles.length)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    const id = (ids[o] << 16) | (ids[o + 1] << 8) | ids[o + 2]
    if (!id || id > triangles.length) continue
    visiblePixels[id - 1]++
    const alpha = shades?.[o + 3]
    if (!alpha) continue
    // Edge pixels are blended with the transparent background (premultiplied).
    const group = groups[triangles[id - 1].group]
    const sums = alpha === 255 ? group.full : group.edge
    const scale = 255 / alpha
    sums[0] += shades[o] * scale
    sums[1] += shades[o + 1] * scale
    sums[2] += shades[o + 2] * scale
    sums[3]++
  }

  const depth = depthInfo(triangles, screen, camera)

  // For lines, also take triangles that cover no pixel if they carry a line
  // that might show: slivers can be long (outlines of thin strokes, rounded
  // edges seen edge-on) and carry the silhouette.
  const edgeInfo = style === 'edges' ? featureEdges(triangles, screen) : null
  const features = edgeInfo?.features
  const lineMayShow = (t) => {
    for (let e = 0; e < 3; e++) {
      if (!features[t][e]) continue
      const [ax, ay] = screen[t][e]
      const [bx, by] = screen[t][(e + 1) % 3]
      const wa = depth.inverse[t][e]
      const wb = depth.inverse[t][(e + 1) % 3]
      for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const x = ax + (bx - ax) * f
        const y = ay + (by - ay) * f
        const px = Math.floor(x)
        const py = Math.floor(y)
        if (px < 0 || py < 0 || px >= width || py >= height) return true
        const o = ((height - 1 - py) * width + px) * 4 // read back bottom-up
        const id = (ids[o] << 16) | (ids[o + 1] << 8) | ids[o + 2]
        // Shows unless what the render has there is clearly in front of it.
        if (!id || id - 1 === t || depth.near(id - 1, x, y) <= (wa + (wb - wa) * f) * (1 + 1e-4)) return true
      }
    }
    return false
  }
  const visible = []
  triangles.forEach((_, t) => {
    if (visiblePixels[t] || (features?.[t].some(Boolean) && lineMayShow(t))) visible.push(t)
  })
  // The exact cut-out still removes whatever is hidden.
  const { shown, splits } = visibleParts(visible, screen, depth, width, height)

  if (style === 'edges') return lineDrawing(visibleEdgeSegments(visible, shown, splits, screen, edgeInfo))
  const lettering = letteringPieces(texts, shown, camera, width, height)
  return shadedDrawing(triangles, groups, visible, shown, screen, camera, lettering)
}

/* ---------- Visibility ---------- */

// How near (1 / depth) each triangle is: at its corners (`inverse`), its
// nearest and farthest corner, and `near(t, x, y)` at a screen point inside it.
function depthInfo(triangles, screen, camera) {
  const point = new THREE.Vector3()
  const inverse = triangles.map(({ vertices }) => vertices.map((v) => -1 / point.copy(v).applyMatrix4(camera.matrixWorldInverse).z))
  const planes = inverse.map((w, t) => nearnessPlane(screen[t], w))
  const nearest = inverse.map((w) => Math.max(...w))
  const farthest = inverse.map((w) => Math.min(...w))
  // Clamped to the corners' range: for slivers (triangles seen edge-on) the
  // plane through the corners is numerically shaky.
  const near = (t, x, y) => {
    const [a, b, c] = planes[t]
    return Math.min(nearest[t], Math.max(farthest[t], a * x + b * y + c))
  }
  return { inverse, nearest, farthest, near }
}

// A tiny margin, so triangles that merely touch don't count as in front.
const DEPTH_MARGIN = 1 + 1e-5

// For every visible triangle, the polygons (Clipper paths) of its visible part
// (`shown`), and the lines where another triangle passes through it
// (`splits`: [occluder, x1, y1, x2, y2] in Clipper units).
function visibleParts(visible, screen, { nearest, farthest, near }, width, height) {
  const boxes = screen.map((points) => boundingBox(points))
  // Anything that hides part of a triangle is visible somewhere itself (or is
  // hidden by something that is), so only visible triangles can hide others.
  const nearby = screenGrid(visible, boxes, width, height)

  const shown = new Map()
  const splits = new Map()
  for (const t of visible) {
    // Only the part of another triangle that is actually nearer than this
    // one hides it (they may touch along an edge or pass through each other).
    const hiding = []
    const lines = []
    for (const o of nearby(boxes[t], t)) {
      if (nearest[o] <= farthest[t]) continue
      const hidden = hiddenPart(screen[t], screen[o], (x, y) => near(o, x, y) - near(t, x, y) * DEPTH_MARGIN)
      if (!hidden) continue
      hiding.push(toClipperPath(hidden.part))
      if (hidden.split) lines.push([o, ...hidden.split.flat().map((v) => v * SCALE)])
    }
    if (lines.length) splits.set(t, lines)
    if (!hiding.length) {
      shown.set(t, [toClipperPath(screen[t])])
      continue
    }
    const clipper = new ClipperLib.Clipper()
    clipper.AddPath(toClipperPath(screen[t]), ClipperLib.PolyType.ptSubject, true)
    clipper.AddPaths(hiding, ClipperLib.PolyType.ptClip, true)
    const parts = []
    clipper.Execute(ClipperLib.ClipType.ctDifference, parts, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
    shown.set(t, parts)
  }
  return { shown, splits }
}

// For a flat triangle, 1 / depth changes linearly across the screen. Returns
// that function as [a, b, c] (a·x + b·y + c) from the corners' values.
function nearnessPlane([[x0, y0], [x1, y1], [x2, y2]], [w0, w1, w2]) {
  const denominator = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
  if (!denominator) return [0, 0, (w0 + w1 + w2) / 3]
  const a = ((w1 - w0) * (y2 - y0) - (w2 - w0) * (y1 - y0)) / denominator
  const b = ((x1 - x0) * (w2 - w0) - (x2 - x0) * (w1 - w0)) / denominator
  return [a, b, w0 - a * x0 - b * y0]
}

// The part of triangle `occluder` that hides triangle `subject`: where it is
// nearer (`ahead(x, y)` > 0). Depths are only compared where the two overlap
// on screen, inside both triangles, where they are interpolated rather than
// extrapolated (that matters for slivers, triangles seen edge-on). Nearness
// is linear on screen for flat triangles, so the boundary is a straight line;
// `split` (two points) is the stretch of it where the two pass through each
// other. The part returned extends over the whole occluder, so cutting it out
// of the subject leaves clean edges.
function hiddenPart(subject, occluder, ahead) {
  const [[ax, ay], [bx, by], [cx, cy]] = occluder
  const sign = Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax))
  if (!sign) return null
  let overlap = subject
  for (let e = 0; e < 3 && overlap.length >= 3; e++) {
    const [px, py] = occluder[e]
    const [qx, qy] = occluder[(e + 1) % 3]
    overlap = clipPolygon(overlap, ([x, y]) => sign * ((qx - px) * (y - py) - (qy - py) * (x - px))).part
  }
  if (overlap.length < 3 || polygonArea(overlap) < 1e-4) return null

  const values = overlap.map(([x, y]) => ahead(x, y))
  if (values.every((v) => v <= 0)) return null
  if (values.every((v) => v > 0)) return { part: occluder, split: null }
  const { part, crossings } = clipPolygon(overlap, ([x, y]) => ahead(x, y))
  if (crossings.length !== 2 || polygonArea(part) < 1e-4) return null

  // Extend the boundary line across the occluder.
  const [[x1, y1], [x2, y2]] = crossings
  const across = ([x, y]) => (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
  const side = Math.sign(across(overlap[values.findIndex((v) => v > 0)]))
  if (!side) return null
  const hiding = clipPolygon(occluder, (p) => side * across(p)).part
  return hiding.length >= 3 ? { part: hiding, split: crossings } : null
}

// Sutherland–Hodgman: the part of a convex polygon where `value` > 0, and the
// points where its outline crosses value = 0.
function clipPolygon(points, value) {
  const part = []
  const crossings = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    const dp = value(p)
    const dq = value(q)
    if (dp > 0) part.push(p)
    if ((dp > 0) !== (dq > 0)) {
      const t = dp / (dp - dq)
      const crossing = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
      part.push(crossing)
      crossings.push(crossing)
    }
  }
  return { part, crossings }
}

function polygonArea(points) {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]
    const [x2, y2] = points[(i + 1) % points.length]
    area += x1 * y2 - x2 * y1
  }
  return Math.abs(area) / 2
}

// A polygon in Clipper's integer units, always wound the same way so that
// overlapping polygons add up instead of cancelling out.
function toClipperPath(points) {
  const path = points.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }))
  return ClipperLib.Clipper.Orientation(path) ? path : path.reverse()
}

function boundingBox(points) {
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const boxesOverlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]

// Buckets triangles by the screen cells their bounding boxes touch, and
// returns a lookup of the other triangles whose boxes overlap a given box.
function screenGrid(indices, boxes, width, height) {
  const columns = Math.ceil(width / CELL)
  const rows = Math.ceil(height / CELL)
  const cells = Array.from({ length: columns * rows }, () => [])
  const cellRange = ([x0, y0, x1, y1]) => [
    Math.max(0, Math.floor(x0 / CELL)), Math.max(0, Math.floor(y0 / CELL)),
    Math.min(columns - 1, Math.floor(x1 / CELL)), Math.min(rows - 1, Math.floor(y1 / CELL)),
  ]
  for (const t of indices) {
    const [c0, r0, c1, r1] = cellRange(boxes[t])
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * columns + c].push(t)
  }

  const seen = new Int32Array(boxes.length).fill(-1)
  return (box, self) => {
    const found = []
    const [c0, r0, c1, r1] = cellRange(box)
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const t of cells[r * columns + c]) {
          if (t === self || seen[t] === self) continue
          seen[t] = self
          if (boxesOverlap(boxes[t], box)) found.push(t)
        }
      }
    }
    return found
  }
}

/* ---------- Lettering ---------- */

// The lettering as shapes on screen, per text material: each outline loop is
// cut to the triangle it lies on (in the texture), carried onto that triangle
// in 3D and the screen (exactly, as the triangle is flat), then cut to the part
// of the triangle that is visible.
function letteringPieces(texts, shown, camera, width, height) {
  const point = new THREE.Vector3()
  const toScreen = (v) => {
    point.copy(v).project(camera)
    return { X: Math.round(((point.x + 1) / 2) * width * SCALE), Y: Math.round(((1 - point.y) / 2) * height * SCALE) }
  }
  const pieces = []
  for (const [material, items] of texts) {
    const { width: textureWidth, height: textureHeight, loops } = textOutlines(material)
    const collected = []
    for (const { t, world, uv } of items) {
      const regions = shown.get(t)
      if (!regions?.length) continue
      const [p0, p1, p2] = uv.map(([u, v]) => [u * textureWidth, v * textureHeight])
      const e1 = [p1[0] - p0[0], p1[1] - p0[1]]
      const e2 = [p2[0] - p0[0], p2[1] - p0[1]]
      const det = e1[0] * e2[1] - e1[1] * e2[0]
      if (Math.abs(det) < 1e-9) continue
      const box = boundingBox([p0, p1, p2])
      const near = loops.filter((loop) => boxesOverlap(loop.box, box))
      if (!near.length) continue

      const cut = new ClipperLib.Clipper()
      cut.AddPaths(near.map((loop) => loop.path), ClipperLib.PolyType.ptSubject, true)
      cut.AddPath([p0, p1, p2].map(([x, y]) => ({ X: Math.round(x * 16), Y: Math.round(y * 16) })), ClipperLib.PolyType.ptClip, true)
      const inside = []
      cut.Execute(ClipperLib.ClipType.ctIntersection, inside, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
      if (!inside.length) continue

      const onScreen = inside.map((path) => path.map(({ X, Y }) => {
        const dx = X / 16 - p0[0]
        const dy = Y / 16 - p0[1]
        const a = (dx * e2[1] - dy * e2[0]) / det
        const b = (e1[0] * dy - e1[1] * dx) / det
        return toScreen(new THREE.Vector3(
          world[0].x + a * (world[1].x - world[0].x) + b * (world[2].x - world[0].x),
          world[0].y + a * (world[1].y - world[0].y) + b * (world[2].y - world[0].y),
          world[0].z + a * (world[1].z - world[0].z) + b * (world[2].z - world[0].z),
        ))
      }))
      const visible = new ClipperLib.Clipper()
      visible.AddPaths(onScreen, ClipperLib.PolyType.ptSubject, true)
      visible.AddPaths(regions, ClipperLib.PolyType.ptClip, true)
      const part = []
      visible.Execute(ClipperLib.ClipType.ctIntersection, part, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
      collected.push(...part)
    }
    if (!collected.length) continue
    const union = new ClipperLib.Clipper()
    union.AddPaths(collected, ClipperLib.PolyType.ptSubject, true)
    const merged = []
    union.Execute(ClipperLib.ClipType.ctUnion, merged, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
    const contours = merged.filter((contour) => Math.abs(ClipperLib.Clipper.Area(contour)) >= SCALE * SCALE * 0.05)
    if (contours.length) pieces.push({ color: material.userData.color, contours })
  }
  return pieces
}

/* ---------- Shaded drawing ---------- */

// One filled shape per flat face: the visible parts of its triangles, merged.
function shadedDrawing(triangles, groups, visible, shown, screen, camera, lettering) {
  const pieces = groups.map(() => [])
  for (const t of visible) {
    const triangle = triangles[t]
    const area = screenArea(screen[t])
    const group = groups[triangle.group]
    const centre = triangle.vertices[0].clone().add(triangle.vertices[1]).add(triangle.vertices[2]).divideScalar(3)
    group.depth += centre.applyMatrix4(camera.matrixWorldInverse).z * area
    group.area += area
    pieces[triangle.group].push(...shown.get(t))
  }

  const faces = []
  groups.forEach((group, g) => {
    if (!pieces[g].length) return
    const clipper = new ClipperLib.Clipper()
    clipper.AddPaths(pieces[g], ClipperLib.PolyType.ptSubject, true)
    const contours = []
    clipper.Execute(ClipperLib.ClipType.ctUnion, contours, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
    // Slivers under a quarter pixel can't be seen (the neighbours' thin
    // outlines cover them) and would only add points.
    const kept = contours.filter((contour) => Math.abs(ClipperLib.Clipper.Area(contour)) >= SCALE * SCALE * 0.25)
    if (kept.length) faces.push({ group, contours: kept, depth: group.area ? group.depth / group.area : -Infinity })
  })
  if (!faces.length) return null

  // Far to near (only matters for the hairline strokes where faces meet).
  faces.sort((a, b) => a.depth - b.depth)

  const crop = cropBox(faces.flatMap(({ contours }) => contours.flat()))
  const paths = faces.map(({ group, contours }) => {
    const d = contours.map((contour) => fitPathData(toPixels(contour, crop), { closed: true, tolerance: CURVE_TOLERANCE })).join('')
    const color = faceColor(group)
    const opacity = group.opacity < 1 ? ` fill-opacity="${group.opacity}" stroke-opacity="${group.opacity}"` : ''
    return `<path fill="${color}" stroke="${color}"${opacity} d="${d}"/>`
  })
  // The lettering lies on top; a hairline stroke closes the seams between the
  // triangles it was cut along.
  for (const { color, contours } of lettering) {
    const d = contours.map((contour) => fitPathData(toPixels(contour, crop), { closed: true, tolerance: CURVE_TOLERANCE })).join('')
    paths.push(`<path fill="${color}" stroke="${color}" stroke-width="0.3" d="${d}"/>`)
  }

  // The thin stroke in each face's own colour closes the hairline seams that
  // anti-aliasing would otherwise show where faces meet.
  return svgDocument(crop, '<g fill-rule="evenodd" stroke-width="0.6" stroke-linejoin="round">', paths)
}

function faceColor(group) {
  const sums = group.full[3] ? group.full : group.edge
  if (!sums[3]) return `#${group.fallback.getHexString()}`
  const channel = (i) => Math.round(Math.min(255, sums[i] / sums[3])).toString(16).padStart(2, '0')
  return `#${channel(0)}${channel(1)}${channel(2)}`
}

/* ---------- Line drawings ---------- */

// Which edges of each triangle belong in a line drawing (`features`, per
// triangle, for its edges 0→1, 1→2, 2→0): creases where faces meet at an angle
// or change material (front face vs side), open boundaries, and silhouettes
// where the surface turns away from the camera. Edges inside smooth or flat
// surfaces (just the triangulation) are left out. `edgeIds` names each edge
// shared by neighbouring triangles once ({ id, forward }: whether this
// triangle runs along it in its canonical direction).
function featureEdges(triangles, screen) {
  const keyOf = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`
  const edges = new Map()
  const edgeIds = triangles.map(() => [null, null, null])
  triangles.forEach((triangle, t) => {
    const keys = triangle.vertices.map(keyOf)
    for (let e = 0; e < 3; e++) {
      const a = keys[e]
      const b = keys[(e + 1) % 3]
      if (a === b) continue
      const key = `${triangle.mesh}|${a < b ? `${a}|${b}` : `${b}|${a}`}`
      if (!edges.has(key)) edges.set(key, [])
      const sides = edges.get(key)
      sides.push({ t, e, forward: a < b })
      edgeIds[t][e] = { id: key, forward: a < b }
    }
  })

  const normals = triangles.map(({ vertices: [a, b, c] }) => b.clone().sub(a).cross(c.clone().sub(a)).normalize())
  const features = triangles.map(() => [false, false, false])
  for (const sides of edges.values()) {
    let feature = sides.length !== 2
    if (!feature) {
      const [p, q] = sides
      feature = triangles[p.t].material !== triangles[q.t].material
      if (!feature) {
        // Consistently wound neighbours run along their shared edge in
        // opposite directions; otherwise one normal points the other way.
        const facing = p.forward !== q.forward ? 1 : -1
        feature = normals[p.t].dot(normals[q.t]) * facing < CREASE
      }
      if (!feature) {
        // A silhouette: on screen, both faces lie on the same side of the edge.
        const [ax, ay] = screen[p.t][p.e]
        const [bx, by] = screen[p.t][(p.e + 1) % 3]
        const side = ([x, y]) => Math.sign((bx - ax) * (y - ay) - (by - ay) * (x - ax))
        feature = side(screen[p.t][(p.e + 2) % 3]) === side(screen[q.t][(q.e + 2) % 3])
      }
    }
    if (feature) for (const { t, e } of sides) features[t][e] = true
  }
  return { features, edgeIds }
}

// Distance (Clipper units) from point p to the infinite line through a and b.
function offLine([ax, ay], [bx, by], { X, Y }) {
  const length = Math.hypot(bx - ax, by - ay)
  return length ? Math.abs((bx - ax) * (Y - ay) - (by - ay) * (X - ax)) / length : Math.hypot(X - ax, Y - ay)
}

// Whether segment p–q lies on the line through a and b and overlaps the
// stretch between them (it may reach beyond: outlines of neighbouring pieces
// get merged into longer segments).
function alongStretch(a, b, p, q, tolerance) {
  if (offLine(a, b, p) > tolerance || offLine(a, b, q) > tolerance) return false
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length = Math.hypot(dx, dy)
  if (!length) return false
  const at = ({ X, Y }) => ((X - a[0]) * dx + (Y - a[1]) * dy) / length
  return Math.max(at(p), at(q)) >= -tolerance && Math.min(at(p), at(q)) <= length + tolerance
}

// The visible parts of the drawing's lines, as segments (Clipper units),
// read off the outlines of every triangle's visible part:
// - along a feature edge of the triangle: that edge is visible there. Each
//   edge is collected from both faces that share it and drawn once;
// - along a line where another triangle passes through it: kept as cut
//   (duplicates from the two triangles merge when the lines are chained);
// - anywhere else the outline marks where a surface in front hides this one;
//   that line is the front surface's own edge, which it draws itself.
function visibleEdgeSegments(visible, shown, splits, screen, { features, edgeIds }) {
  const tolerance = 1.5
  const segments = []
  // Visible stretches per edge, as fractions along it.
  const lines = new Map()
  const addSpan = (key, from, to, p, q) => {
    let line = lines.get(key)
    if (!line) lines.set(key, (line = { from, to, spans: [] }))
    const [ax, ay] = line.from
    const dx = line.to[0] - ax
    const dy = line.to[1] - ay
    const lengthSq = dx * dx + dy * dy
    if (!lengthSq) return
    const at = ({ X, Y }) => ((X - ax) * dx + (Y - ay) * dy) / lengthSq
    const s = at(p)
    const u = at(q)
    line.spans.push(s < u ? [s, u] : [u, s])
  }

  for (const t of visible) {
    const corners = screen[t].map(([x, y]) => [x * SCALE, y * SCALE])
    const crossings = splits.get(t) ?? []
    for (const contour of shown.get(t)) {
      if (!ClipperLib.Clipper.Area(contour)) continue
      for (let i = 0; i < contour.length; i++) {
        const p = contour[i]
        const q = contour[(i + 1) % contour.length]
        // On a sliver (a triangle seen edge-on) a piece of outline can run
        // along several of its edges at once; it counts for a feature edge if
        // it runs along one.
        let edge = -1
        let along = false
        for (let e = 0; e < 3; e++) {
          const a = corners[e]
          const b = corners[(e + 1) % 3]
          if (offLine(a, b, p) > tolerance || offLine(a, b, q) > tolerance) continue
          along = true
          if (features[t][e] && edgeIds[t][e]) {
            edge = e
            break
          }
        }
        if (along) {
          if (edge === -1) continue
          const { id, forward } = edgeIds[t][edge]
          const a = corners[edge]
          const b = corners[(edge + 1) % 3]
          addSpan(`e|${id}`, forward ? a : b, forward ? b : a, p, q)
          continue
        }
        // Only where the other triangle really is: along the stretch of the
        // crossing line that lies within it.
        if (crossings.some(([, x1, y1, x2, y2]) => alongStretch([x1, y1], [x2, y2], p, q, tolerance))) {
          segments.push([p.X, p.Y, q.X, q.Y])
        }
      }
    }
  }

  // Merge each edge's stretches and turn them back into segments.
  for (const { from, to, spans } of lines.values()) {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1])
    const gap = tolerance / length
    spans.sort((a, b) => a[0] - b[0])
    const merged = []
    for (const span of spans) {
      const last = merged[merged.length - 1]
      if (last && span[0] <= last[1] + gap) last[1] = Math.max(last[1], span[1])
      else merged.push([...span])
    }
    for (const [s, u] of merged) {
      const point = (f) => [Math.round(from[0] + (to[0] - from[0]) * f), Math.round(from[1] + (to[1] - from[1]) * f)]
      // Snap to the corners so neighbouring edges join up exactly.
      const [x1, y1] = point(s * length < tolerance ? 0 : s)
      const [x2, y2] = point((1 - u) * length < tolerance ? 1 : u)
      segments.push([x1, y1, x2, y2])
    }
  }
  return segments
}

// Turns loose segments (Clipper units) into an SVG of smooth curves.
function lineDrawing(segments) {
  const lines = chainSegments(segments).filter((line) => polylineLength(line) >= 0.5 * SCALE)
  if (!lines.length) return null
  const crop = cropBox(lines.flat())
  const paths = lines.map((line) => {
    const closed = line.length > 2 && line[0].X === line[line.length - 1].X && line[0].Y === line[line.length - 1].Y
    return `<path d="${fitPathData(toPixels(line, crop), { closed, tolerance: CURVE_TOLERANCE })}"/>`
  })
  return svgDocument(crop, `<g fill="none" stroke="#000" stroke-width="${LINE_WIDTH}" stroke-linecap="round" stroke-linejoin="round">`, paths)
}

// Drops duplicate segments and joins the rest end to end into polylines. Ends
// are snapped to a quarter-pixel grid first, so pieces that were worked out
// separately but meet (to within rounding) join up.
function chainSegments(segments) {
  const keyOf = (x, y) => `${x},${y}`
  const snap = (v) => Math.round(v / (SCALE / 4)) * (SCALE / 4)
  const unique = new Map()
  for (const segment of segments) {
    const [x1, y1, x2, y2] = segment.map(snap)
    if (x1 === x2 && y1 === y2) continue
    const a = keyOf(x1, y1)
    const b = keyOf(x2, y2)
    const key = a < b ? `${a};${b}` : `${b};${a}`
    if (!unique.has(key)) unique.set(key, [x1, y1, x2, y2])
  }
  const list = [...unique.values()]
  const at = new Map()
  list.forEach(([x1, y1, x2, y2], i) => {
    for (const key of [keyOf(x1, y1), keyOf(x2, y2)]) {
      if (!at.has(key)) at.set(key, [])
      at.get(key).push(i)
    }
  })

  const used = new Uint8Array(list.length)
  // Walks on from a point along unused segments, collecting the points passed.
  const walk = (x, y) => {
    const points = []
    for (;;) {
      const next = (at.get(keyOf(x, y)) ?? []).find((i) => !used[i])
      if (next === undefined) return points
      used[next] = 1
      const [x1, y1, x2, y2] = list[next]
      ;[x, y] = x1 === x && y1 === y ? [x2, y2] : [x1, y1]
      points.push({ X: x, Y: y })
    }
  }
  const lines = []
  list.forEach(([x1, y1, x2, y2], i) => {
    if (used[i]) return
    used[i] = 1
    const forward = walk(x2, y2)
    const backward = walk(x1, y1).reverse()
    lines.push([...backward, { X: x1, Y: y1 }, { X: x2, Y: y2 }, ...forward])
  })
  return lines
}

const polylineLength = (points) => points.reduce((sum, p, i) => (i ? sum + Math.hypot(p.X - points[i - 1].X, p.Y - points[i - 1].Y) : 0), 0)

/* ---------- SVG output ---------- */

// The drawing's extent (Clipper units) with a small margin.
function cropBox(points) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { X, Y } of points) {
    minX = Math.min(minX, X)
    minY = Math.min(minY, Y)
    maxX = Math.max(maxX, X)
    maxY = Math.max(maxY, Y)
  }
  const margin = Math.max(maxX - minX, maxY - minY) * 0.02
  return {
    x: minX - margin,
    y: minY - margin,
    width: Math.ceil((maxX - minX + 2 * margin) / SCALE),
    height: Math.ceil((maxY - minY + 2 * margin) / SCALE),
  }
}

// Clipper points to [x, y] pixels within the cropped drawing.
const toPixels = (points, crop) => points.map(({ X, Y }) => [(X - crop.x) / SCALE, (Y - crop.y) / SCALE])

function svgDocument(crop, group, paths) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width}" height="${crop.height}" viewBox="0 0 ${crop.width} ${crop.height}">`,
    group,
    ...paths,
    '</g>',
    '</svg>',
    '',
  ].join('\n')
}

/* ---------- Scene capture ---------- */

// Every triangle of the model in world space, grouped into flat faces (same
// mesh, same material, same direction), plus a copy of the model for the ID
// render where each triangle carries its index as a colour.
function collectTriangles(model) {
  const triangles = []
  const groups = []
  const groupIndex = new Map()
  const idScene = new THREE.Scene()
  // Same depth offset on the walls as the real materials, so IDs match the preview.
  const idMaterials = [
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
  ]
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const normal = new THREE.Vector3()
  // Triangles by mesh and corners, to find the ones that carry lettering.
  const byCorners = new Map()
  const cornersKey = (meshIndex, ...corners) => `${meshIndex}|${corners.map((p) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`).sort().join('|')}`

  model.children.forEach((mesh, meshIndex) => {
    if (!mesh.isMesh || !mesh.visible) return
    const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()
    for (const name of Object.keys(geometry.attributes)) if (name !== 'position') geometry.deleteAttribute(name)
    const position = geometry.attributes.position
    const colors = new Float32Array(position.count * 3)
    const ranges = geometry.groups.length ? geometry.groups : [{ start: 0, count: position.count, materialIndex: 0 }]
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]

    for (const { start, count, materialIndex } of ranges) {
      for (let v = start; v + 2 < start + count; v += 3) {
        a.fromBufferAttribute(position, v).applyMatrix4(mesh.matrixWorld)
        b.fromBufferAttribute(position, v + 1).applyMatrix4(mesh.matrixWorld)
        c.fromBufferAttribute(position, v + 2).applyMatrix4(mesh.matrixWorld)
        normal.subVectors(c, b).cross(a.clone().sub(b))
        if (normal.lengthSq() === 0) continue
        normal.normalize()

        const key = `${meshIndex}|${materialIndex}|${Math.round(normal.x * 20)},${Math.round(normal.y * 20)},${Math.round(normal.z * 20)}`
        if (!groupIndex.has(key)) {
          const material = materials[materialIndex] ?? materials[0]
          groupIndex.set(key, groups.length)
          groups.push({ full: [0, 0, 0, 0], edge: [0, 0, 0, 0], depth: 0, area: 0, fallback: material.color, opacity: material.opacity ?? 1 })
        }

        triangles.push({ vertices: [a.clone(), b.clone(), c.clone()], group: groupIndex.get(key), mesh: meshIndex, material: materialIndex })
        byCorners.set(cornersKey(meshIndex, a, b, c), triangles.length - 1)
        const id = triangles.length
        for (let k = 0; k < 3; k++) {
          colors[(v + k) * 3] = ((id >> 16) & 255) / 255
          colors[(v + k) * 3 + 1] = ((id >> 8) & 255) / 255
          colors[(v + k) * 3 + 2] = (id & 255) / 255
        }
      }
    }

    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    const idMesh = new THREE.Mesh(geometry, idMaterials)
    idMesh.matrixAutoUpdate = false
    idMesh.matrix.copy(mesh.matrixWorld)
    idScene.add(idMesh)
  })

  // The lettering: the triangles of each text overlay (the same as ones of
  // their layer), with the texture position of their corners.
  const texts = new Map()
  model.children.forEach((mesh, meshIndex) => {
    const overlay = mesh.userData.text
    if (!overlay?.visible || !mesh.visible) return
    const { position, uv } = overlay.geometry.attributes
    for (let v = 0; v + 2 < position.count; v += 3) {
      const world = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(position, v + k).applyMatrix4(overlay.matrixWorld))
      const t = byCorners.get(cornersKey(meshIndex, ...world))
      if (t === undefined) continue
      if (!texts.has(overlay.material)) texts.set(overlay.material, [])
      texts.get(overlay.material).push({ t, world, uv: [0, 1, 2].map((k) => [uv.getX(v + k), uv.getY(v + k)]) })
    }
  })

  return { triangles, groups, idScene, texts }
}

// Renders triangle IDs into an off-screen target (no anti-aliasing, no colour
// conversion, so every pixel holds an exact ID; 0 is the background).
function renderIds(renderer, idScene, camera, width, height) {
  const target = new THREE.WebGLRenderTarget(width, height)
  const clearColor = renderer.getClearColor(new THREE.Color())
  const clearAlpha = renderer.getClearAlpha()
  renderer.setRenderTarget(target)
  renderer.setClearColor(0x000000, 0)
  renderer.render(idScene, camera)
  const pixels = new Uint8Array(width * height * 4)
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)
  renderer.setRenderTarget(null)
  renderer.setClearColor(clearColor, clearAlpha)
  target.dispose()
  return pixels
}

// Renders the scene as the preview does (tone mapping, sRGB) at the export
// size, without cast shadows, and reads the pixels back.
function renderShades(renderer, scene, camera, width, height) {
  const size = renderer.getSize(new THREE.Vector2())
  const pixelRatio = renderer.getPixelRatio()
  const casters = []
  // The lettering is exported as shapes of its own, so it must not tint the faces.
  const lettering = []
  scene.traverse((object) => {
    if (object.isLight && object.castShadow) {
      casters.push(object)
      object.castShadow = false
    }
    if (object.userData.isText && object.visible) {
      lettering.push(object)
      object.visible = false
    }
  })

  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  renderer.render(scene, camera)
  const gl = renderer.getContext()
  const pixels = new Uint8Array(width * height * 4)
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

  for (const light of casters) light.castShadow = true
  for (const object of lettering) object.visible = true
  renderer.setPixelRatio(pixelRatio)
  renderer.setSize(size.x, size.y, false)
  // Redraw right away so the preview doesn't flash empty.
  renderer.render(scene, camera)
  return pixels
}

function disposeScene(idScene) {
  const materials = new Set()
  for (const mesh of idScene.children) {
    mesh.geometry.dispose()
    for (const material of mesh.material) materials.add(material)
  }
  for (const material of materials) material.dispose()
}
