import * as THREE from 'three'

// Self-crossing lines as 3D ribbons.
//
// A line (an SVG stroke, or a filled shape that is an outlined stroke) is
// described as a strip of cross-sections running from its start to its end:
// pairs of points (A[k], B[k]) on its two sides. Walking along the strip, a
// part that comes back over a part drawn earlier is lifted smoothly above it,
// so a loop passes over the line instead of merging into it.

const SHARP_TURN = Math.cos((35 * Math.PI) / 180)

/* ---------- Polyline helpers ---------- */

function polylineLength(points, closed) {
  let length = 0
  const n = points.length
  for (let i = 0; i < (closed ? n : n - 1); i++) length += points[i].distanceTo(points[(i + 1) % n])
  return length
}

function signedArea(points) {
  let area = 0
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

// Points evenly spaced along a polyline.
function resample(points, spacing, closed) {
  const n = points.length
  const out = [points[0].clone()]
  let need = spacing
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    const length = a.distanceTo(b)
    let pos = 0
    while (length - pos >= need) {
      pos += need
      out.push(a.clone().lerp(b, pos / length))
      need = spacing
    }
    need -= length - pos
  }
  if (closed) {
    if (out.length > 1 && out[out.length - 1].distanceTo(out[0]) < spacing * 0.5) out.pop()
  } else if (out[out.length - 1].distanceTo(points[n - 1]) > spacing * 0.25) {
    out.push(points[n - 1].clone())
  }
  return out
}

// Drops points where a closed outline doubles straight back on itself: the
// hairline glitches that outline-stroke exports tend to contain.
function despike(points) {
  for (let pass = 0; pass < 10; pass++) {
    const n = points.length
    const kept = points.filter((p, i) => {
      const a = points[(i - 1 + n) % n]
      const b = points[(i + 1) % n]
      const ux = p.x - a.x
      const uy = p.y - a.y
      const vx = b.x - p.x
      const vy = b.y - p.y
      const lengths = Math.hypot(ux, uy) * Math.hypot(vx, vy)
      return !(lengths > 0 && (ux * vx + uy * vy) / lengths < -0.2)
    })
    if (kept.length === n || kept.length < 8) return kept
    points = kept
  }
  return points
}

const rotate = (points, start) => points.slice(start).concat(points.slice(0, start))

/* ---------- Matching the two sides of an outline ---------- */

// Dynamic time warping between two point sequences, restricted to a band
// around the diagonal so a side can't match a far-away part of the line.
function dtw(a, b, band) {
  const n = a.length
  const m = b.length
  const cost = new Float32Array(n * m).fill(Infinity)
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0
    const j0 = Math.max(0, Math.floor((t - band) * (m - 1)))
    const j1 = Math.min(m - 1, Math.ceil((t + band) * (m - 1)))
    for (let j = j0; j <= j1; j++) {
      let best = i === 0 && j === 0 ? 0 : Infinity
      if (i > 0) best = Math.min(best, cost[(i - 1) * m + j])
      if (j > 0) best = Math.min(best, cost[i * m + j - 1])
      if (i > 0 && j > 0) best = Math.min(best, cost[(i - 1) * m + j - 1])
      cost[i * m + j] = a[i].distanceTo(b[j]) + best
    }
  }
  return cost
}

function dtwPairs(a, b, band) {
  const m = b.length
  const cost = dtw(a, b, band)
  const pairs = []
  let i = a.length - 1
  let j = m - 1
  pairs.push([i, j])
  while (i > 0 || j > 0) {
    const options = []
    if (i > 0 && j > 0) options.push([i - 1, j - 1])
    if (i > 0) options.push([i - 1, j])
    if (j > 0) options.push([i, j - 1])
    ;[i, j] = options.reduce((best, o) => (cost[o[0] * m + o[1]] < cost[best[0] * m + best[1]] ? o : best))
    pairs.push([i, j])
  }
  return pairs.reverse()
}

// Splits a closed outline at indices 0 and `end` into its two sides, both
// running from the start of the line towards its end.
function sides(points, end) {
  const a = points.slice(0, end + 1)
  const b = [points[0], ...points.slice(end).reverse()]
  return [a, b]
}

function splitCost(points, end) {
  const [a, b] = sides(points, end)
  const cost = dtw(a, b, 0.25)
  return cost[a.length * b.length - 1] / (a.length + b.length)
}

function bestSplit(points, candidates, startOffset = 0) {
  let best = null
  for (const end of candidates) {
    const cost = splitCost(rotate(points, startOffset), end)
    if (!best || cost < best.cost) best = { end, cost }
  }
  return best.end
}

// Treats a closed outline as an outlined stroke and recovers its strip, or
// returns null if it doesn't look like one.
function outlineToStrip(raw) {
  const perimeter = polylineLength(raw, true)
  const area = Math.abs(signedArea(raw))
  const width = (2 * area) / perimeter
  if (!(width > 0) || perimeter / 2 / width < 6) return null

  const spacing = Math.max(width / 8, perimeter / 3000)
  const points = resample(despike(resample(raw, spacing, true)), spacing, true)
  const n = points.length
  if (n < 16) return null

  // Find where the outline turns around at the two ends of the line, on a
  // coarser copy. The path is assumed to start near one end, as exports do.
  const step = Math.max(1, Math.round(width / 2 / spacing))
  const coarse = points.filter((_, i) => i % step === 0)
  const nc = coarse.length
  const range = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i)
  const near = Math.ceil((2 * width) / (spacing * step))

  let end = bestSplit(coarse, range(Math.floor(nc * 0.3), Math.ceil(nc * 0.7)))
  let start = 0
  let bestCost = Infinity
  for (let offset = -near; offset <= near; offset++) {
    const s = (offset + nc) % nc
    const e = (end - offset + nc) % nc
    const cost = splitCost(rotate(coarse, s), e)
    if (cost < bestCost) {
      bestCost = cost
      start = s
    }
  }
  end = (end - start + nc) % nc
  end = bestSplit(coarse, range(Math.max(1, end - near), Math.min(nc - 2, end + near)), start)

  const rotated = rotate(points, start * step)
  const [a, b] = sides(rotated, Math.min(n - 2, end * step))
  return { ...regularize(a, b, dtwPairs(a, b, 0.25), spacing, width), outlineArea: area }
}

// Point at fractional index `f` along a polyline.
function pointAt(points, f) {
  const i = Math.max(0, Math.min(Math.floor(f), points.length - 2))
  return points[i].clone().lerp(points[i + 1], f - i)
}

// The matching advances one side at a time, giving ragged cross-sections.
// Smooth how far along each side the sections are, then space them evenly,
// so the surface between the two sides runs without creases.
function regularize(a, b, pairs, spacing, width) {
  const count = pairs.length
  const half = Math.max(1, Math.round(width / spacing))
  const smooth = (values) => values.map((_, k) => {
    const h = Math.min(half, k, count - 1 - k)
    let sum = 0
    for (let d = -h; d <= h; d++) sum += values[k + d]
    return sum / (2 * h + 1)
  })
  const fa = smooth(pairs.map(([i]) => i))
  const fb = smooth(pairs.map(([, j]) => j))

  // Distance travelled along both sides, so rounded ends get enough sections too.
  const travelled = [0]
  for (let k = 1; k < count; k++) {
    const da = pointAt(a, fa[k]).distanceTo(pointAt(a, fa[k - 1]))
    const db = pointAt(b, fb[k]).distanceTo(pointAt(b, fb[k - 1]))
    travelled.push(travelled[k - 1] + (da + db) / 2)
  }
  const total = travelled[count - 1]
  const sections = Math.max(2, Math.round(total / spacing) + 1)
  const A = []
  const B = []
  for (let n = 0, k = 0; n < sections; n++) {
    const target = (n / (sections - 1)) * total
    while (k < count - 2 && travelled[k + 1] < target) k++
    const span = travelled[k + 1] - travelled[k]
    const t = span > 0 ? Math.min(1, Math.max(0, (target - travelled[k]) / span)) : 0
    A.push(pointAt(a, fa[k] + (fa[k + 1] - fa[k]) * t))
    B.push(pointAt(b, fb[k] + (fb[k + 1] - fb[k]) * t))
  }
  return { A, B }
}

// Strip for a stroked centre line with half-width `r`.
function centerlineToStrip(points, r, cap, closed) {
  const unique = points.filter((p, i) => i === 0 || p.distanceTo(points[i - 1]) > 1e-9)
  if (unique.length < 2) return null
  const pts = resample(unique, Math.max(r / 2, polylineLength(unique, closed) / 4000), closed)
  if (pts.length < 2) return null

  const A = []
  const B = []
  const tangents = pts.map((p, k) => {
    const prev = pts[closed ? (k - 1 + pts.length) % pts.length : Math.max(0, k - 1)]
    const next = pts[closed ? (k + 1) % pts.length : Math.min(pts.length - 1, k + 1)]
    return next.clone().sub(prev).normalize()
  })
  const section = (p, t, across, along) => {
    const n = new THREE.Vector2(-t.y, t.x)
    A.push(p.clone().addScaledVector(n, across).addScaledVector(t, along))
    B.push(p.clone().addScaledVector(n, -across).addScaledVector(t, along))
  }
  const capSteps = 6
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (!closed && cap === 'round') {
    for (let s = capSteps; s > 0; s--) {
      const phi = (s / capSteps) * (Math.PI / 2)
      section(first, tangents[0], r * Math.cos(phi), -r * Math.sin(phi))
    }
  }
  pts.forEach((p, k) => {
    const along = closed || cap !== 'square' ? 0 : k === 0 ? -r : k === pts.length - 1 ? r : 0
    section(p, tangents[k], r, along)
  })
  if (closed) section(first, tangents[0], r, 0)
  if (!closed && cap === 'round') {
    for (let s = 1; s <= capSteps; s++) {
      const phi = (s / capSteps) * (Math.PI / 2)
      section(last, tangents[pts.length - 1], r * Math.cos(phi), r * Math.sin(phi))
    }
  }
  return { A, B, closed }
}

/* ---------- Crossings ---------- */

const orient = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
const segmentsCross = (a, b, c, d) => orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0

function crossingPoint(a, b, c, d) {
  if (!segmentsCross(a, b, c, d)) return null
  const r = b.clone().sub(a)
  const s = d.clone().sub(c)
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / (r.x * s.y - r.y * s.x)
  return a.clone().addScaledVector(r, t)
}

// On the inside of a sharp corner or tight bend, a widened side folds back
// over itself in a small loop. Cut each such loop at the point where the side
// crosses itself, the way offsetting an outline keeps an inner corner sharp.
// Only loops shorter than `maxLength` count, so real crossings are left alone.
function untangle(points, maxLength) {
  const out = points.map((p) => p.clone())
  for (let i = 0; i + 1 < out.length; i++) {
    let length = 0
    for (let j = i + 2; j + 1 < out.length; j++) {
      length += out[j - 1].distanceTo(out[j])
      if (length > maxLength) break
      const hit = crossingPoint(out[i], out[i + 1], out[j], out[j + 1])
      if (hit) {
        for (let l = i + 1; l <= j; l++) out[l].copy(hit)
        i = j - 1
        break
      }
    }
  }
  return out
}

// Around a sharp corner the cross-sections fan out; if a side steps backwards
// over the previous cross-section, the two overlap like a bow tie and the
// surface folds. Such a side waits at its last point instead, so the fan pivots
// cleanly around the inside of the corner.
function unfold(strip) {
  const { A, B } = strip
  const tri = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  let balance = 0
  for (let k = 0; k + 1 < A.length; k++) {
    const next = A[k + 1].clone().add(B[k + 1]).multiplyScalar(0.5)
    balance += Math.sign(tri(A[k], B[k], next))
  }
  const forward = balance >= 0 ? 1 : -1
  const tolerance = 1e-9 * A.reduce((max, a, k) => Math.max(max, a.distanceToSquared(B[k])), 0)
  const behind = (k, point) => forward * tri(A[k], B[k], point) < -tolerance
  for (let k = 0; k + 1 < A.length; k++) {
    const aBehind = behind(k, A[k + 1])
    const bBehind = behind(k, B[k + 1])
    if (bBehind && !aBehind) B[k + 1] = B[k].clone()
    else if (aBehind && !bBehind) A[k + 1] = A[k].clone()
  }
}

// Joins strips into one ribbon, finds where later parts overlap earlier ones,
// and returns null unless the line really crosses itself somewhere (lines that
// merely run close to themselves, like outlines with narrow slits, stay flat
// and plain extrusion keeps them exact).
function makeRibbon(strips) {
  for (const strip of strips) {
    const widest = strip.A.reduce((max, a, k) => Math.max(max, a.distanceTo(strip.B[k])), 0)
    strip.A = untangle(strip.A, 3 * widest)
    strip.B = untangle(strip.B, 3 * widest)
    unfold(strip)
  }

  const mid = []
  strips.forEach((strip, index) => {
    strip.start = mid.length
    let s = 0
    for (let k = 0; k < strip.A.length; k++) {
      const p = strip.A[k].clone().add(strip.B[k]).multiplyScalar(0.5)
      if (k > 0) s += p.distanceTo(mid[mid.length - 1].p)
      mid.push({ p, r: strip.A[k].distanceTo(strip.B[k]) / 2, s, strip: index })
    }
  })
  if (mid.length < 4 || mid.length > 20000) return null

  const radii = mid.map((m) => m.r).sort((x, y) => x - y)
  const rMed = radii[Math.floor(radii.length / 2)]
  const rMax = radii[radii.length - 1]
  if (!(rMed > 0)) return null

  // Spatial hash so only nearby samples are compared.
  const cell = 2 * rMax
  const grid = new Map()
  const keyOf = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
  const overlaps = []
  for (let k = 0; k < mid.length; k++) {
    const { p, r, strip } = mid[k]
    const cx = Math.floor(p.x / cell)
    const cy = Math.floor(p.y / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const reach = r + mid[j].r
          if (!(reach > 0) || p.distanceTo(mid[j].p) >= reach) continue
          // Within one strip, only count it if the line went away and came
          // back, which rules out plain neighbours along the line (whether a
          // pair is part of a real crossing is decided below). On a closed
          // line that has to hold both ways round, otherwise the end meeting
          // the start would count.
          if (mid[j].strip === strip) {
            const begin = strips[strip].start
            const end = begin + strips[strip].A.length
            const wanders = (from, to) => {
              for (let l = from; l !== to; l = l + 1 === end ? begin : l + 1) {
                if (mid[l].p.distanceTo(p) > reach) return true
              }
              return false
            }
            if (!wanders(j + 1, k)) continue
            if (strips[strip].closed && !wanders(k + 1 === end ? begin : k + 1, j)) continue
          }
          overlaps.push([k, j])
        }
      }
    }
    const key = keyOf(p.x, p.y)
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key).push(k)
  }

  // Mark the pairs where the line's centre really crosses itself.
  const segmentsAround = (k) => [[k - 1, k], [k, k + 1]].filter(([a, b]) => mid[a]?.strip === mid[k].strip && mid[b]?.strip === mid[k].strip)
  for (const pair of overlaps) {
    const [k, j] = pair
    pair.push(segmentsAround(k).some(([a, b]) => segmentsAround(j).some(([c, d]) => segmentsCross(mid[a].p, mid[b].p, mid[c].p, mid[d].p))))
  }
  if (!overlaps.some(([, , crosses]) => crosses)) return null

  return { strips, mid, overlaps, rMed, profile: null }
}

// Moves both sides of every cross-section `amount` outwards (inwards when
// negative), like offsetting the outline of the line.
function widen(strip, amount) {
  const count = strip.A.length
  const across = strip.A.map((a, k) => a.clone().sub(strip.B[k]))
  // Where the two sides meet (pointed ends), borrow the direction of a neighbour.
  for (let k = 0; k < count; k++) {
    for (let d = 1; across[k].lengthSq() === 0 && d < count; d++) {
      const neighbour = across[k + d] ?? across[k - d]
      if (neighbour?.lengthSq() > 0) across[k].copy(neighbour)
    }
  }
  return {
    ...strip,
    A: strip.A.map((a, k) => {
      const mid = a.clone().add(strip.B[k]).multiplyScalar(0.5)
      const half = Math.max(0, a.distanceTo(strip.B[k]) / 2 + amount)
      return mid.addScaledVector(across[k].clone().normalize(), half)
    }),
    B: strip.B.map((b, k) => {
      const mid = b.clone().add(strip.A[k]).multiplyScalar(0.5)
      const half = Math.max(0, b.distanceTo(strip.A[k]) / 2 + amount)
      return mid.addScaledVector(across[k].clone().normalize(), -half)
    }),
  }
}

// `offset` widens (or narrows) the line by that much on each side.
export function ribbonFromOutline(points, offset = 0) {
  const strip = points.length >= 8 && outlineToStrip(points)
  if (!strip) return null

  // Reject shapes that the strip doesn't actually reproduce.
  let area = 0
  for (let k = 0; k + 1 < strip.A.length; k++) {
    area += Math.abs(signedArea([strip.A[k], strip.A[k + 1], strip.B[k + 1], strip.B[k]]))
  }
  if (Math.abs(area - strip.outlineArea) > 0.12 * strip.outlineArea) return null
  return makeRibbon([offset ? widen(strip, offset) : strip])
}

export function ribbonFromStroke(subPaths, style) {
  const r = style.strokeWidth / 2
  const strips = subPaths
    .map((subPath) => centerlineToStrip(subPath.getPoints(32), r, style.strokeLineCap, subPath.autoClose))
    .filter(Boolean)
  return strips.length ? makeRibbon(strips) : null
}

/* ---------- Lifting ---------- */

// Eases in and out with no kink at either end (zero slope and curvature).
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (6 * t - 15) + 10))

// How high each cross-section is lifted, in units of the ribbon's thickness.
// Later parts go over earlier ones (or the reverse when `flip` is set), with
// `gap` (also in thicknesses) of air in between. The line only ever climbs
// along its drawing order: between the part it will later pass over and the
// crossing itself it rises in one long eased ramp, then stays up, so its end
// can sit higher than its start.
export function liftProfile(ribbon, flip, gap) {
  const key = `${flip}:${gap}`
  if (ribbon.profile?.key === key) return ribbon.profile.z

  const { strips, mid, overlaps, rMed } = ribbon
  const clearance = 1 + gap
  const stripOf = (k) => mid[k].strip
  const stripLength = (strip) => mid[strips[strip].start + strips[strip].A.length - 1].s
  // Position along the drawing order (reversed when flipped).
  const order = (k) => (flip ? stripLength(stripOf(k)) - mid[k].s : mid[k].s)

  // Group overlapping pairs into crossings: runs that stay close on both passes.
  const pairs = overlaps
    .map(([later, earlier, crosses]) => (flip ? [earlier, later, crosses] : [later, earlier, crosses]))
    .sort((p, q) => stripOf(p[0]) - stripOf(q[0]) || order(p[0]) - order(q[0]))
  const join = 3 * rMed
  let crossings = []
  for (const [upper, lower, crosses] of pairs) {
    const u = order(upper)
    const l = order(lower)
    let crossing = crossings.find((c) =>
      c.upperStrip === stripOf(upper) && c.lowerStrip === stripOf(lower) &&
      u - c.upperTo <= join && l >= c.lowerFrom - join && l <= c.lowerTo + join)
    if (!crossing) {
      crossing = { upperStrip: stripOf(upper), lowerStrip: stripOf(lower), upperFrom: u, upperTo: u, lowerFrom: l, lowerTo: l, pairs: [] }
      crossings.push(crossing)
    }
    crossing.upperFrom = Math.min(crossing.upperFrom, u)
    crossing.upperTo = Math.max(crossing.upperTo, u)
    crossing.lowerFrom = Math.min(crossing.lowerFrom, l)
    crossing.lowerTo = Math.max(crossing.lowerTo, l)
    crossing.pairs.push([upper, lower])
    crossing.real ||= crosses
  }
  // Overlaps where the centre line never crosses (the two legs of a sharp
  // corner or hairpin, a thick line in a tight bend) are left flat.
  crossings = crossings.filter((crossing) => crossing.real)
  crossings.sort((c, d) => c.upperStrip - d.upperStrip || c.upperFrom - d.upperFrom)

  // Adds a climb of `amount` to one strip, eased between positions `from` and `to`.
  const z = new Float32Array(mid.length)
  const climb = (strip, from, to, amount) => {
    const { start, A } = strips[strip]
    for (let k = start; k < start + A.length; k++) {
      z[k] += amount * (to > from ? ease((order(k) - from) / (to - from)) : order(k) >= to ? 1 : 0)
    }
  }

  // Climbs only ever add, so a crossing that's already cleared stays cleared.
  for (const crossing of crossings) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const deficit = crossing.pairs.reduce((worst, [upper, lower]) => Math.max(worst, z[lower] + clearance - z[upper]), 0)
      if (deficit <= 1e-6) break
      if (crossing.upperStrip !== crossing.lowerStrip) {
        climb(crossing.upperStrip, -Infinity, -Infinity, deficit)
      } else {
        // Rise over everything between leaving the lower pass and reaching the crossing.
        const to = crossing.upperFrom
        const from = Math.min(crossing.lowerTo, to - 4 * rMed)
        climb(crossing.upperStrip, from, to, deficit)
      }
    }
  }

  ribbon.profile = { key, z }
  return z
}

/* ---------- Geometry ---------- */

// Builds the solid ribbon: each cross-section spans `thickness` above its
// lifted base. Group 0 holds top and bottom, group 1 the walls.
export function createRibbonGeometry(ribbon, lift, thickness) {
  const positions = []
  const faces = []
  const walls = []
  const vertex = (p, z) => positions.push(p.x, p.y, z) / 3 - 1

  for (const strip of ribbon.strips) {
    const count = strip.A.length
    const base = (k) => lift[strip.start + k] * thickness
    let A = strip.A
    let B = strip.B

    // Make A the left side of the direction of travel so faces point outwards.
    let side = 0
    for (let k = 0; k + 1 < count; k++) {
      const m0 = A[k].clone().add(B[k]).multiplyScalar(0.5)
      const m1 = A[k + 1].clone().add(B[k + 1]).multiplyScalar(0.5)
      side += (m1.x - m0.x) * (A[k].y - m0.y) - (m1.y - m0.y) * (A[k].x - m0.x)
    }
    if (side < 0) [A, B] = [B, A]

    const top = []
    const bottom = []
    for (let k = 0; k < count; k++) {
      top.push([vertex(A[k], base(k) + thickness), vertex(B[k], base(k) + thickness)])
      bottom.push([vertex(A[k], base(k)), vertex(B[k], base(k))])
    }
    for (let k = 0; k + 1 < count; k++) {
      faces.push(top[k][0], top[k][1], top[k + 1][1], top[k][0], top[k + 1][1], top[k + 1][0])
      faces.push(bottom[k][0], bottom[k + 1][1], bottom[k][1], bottom[k][0], bottom[k + 1][0], bottom[k + 1][1])
    }

    // Side walls share vertices along the line (smooth shading) except at sharp corners.
    for (const [points, left] of [[A, true], [B, false]]) {
      let prev = null
      for (let k = 0; k < count; k++) {
        const column = () => [vertex(points[k], base(k)), vertex(points[k], base(k) + thickness)]
        const current = column()
        if (prev) {
          const [pb, pt] = prev
          const [cb, ct] = current
          if (left) walls.push(pb, pt, ct, pb, ct, cb)
          else walls.push(pb, ct, pt, pb, cb, ct)
        }
        let sharp = false
        if (k > 0 && k + 1 < count) {
          const u = points[k].clone().sub(points[k - 1])
          const v = points[k + 1].clone().sub(points[k])
          const lengths = u.length() * v.length()
          sharp = lengths > 0 && u.dot(v) / lengths < SHARP_TURN
        }
        prev = sharp ? column() : current
      }
    }

    // Close the ends where the line doesn't taper to a point.
    const ends = [[0, false], [count - 1, true]]
    for (const [k, last] of ends) {
      if (A[k].distanceTo(B[k]) < 1e-9) continue
      const ab = vertex(A[k], base(k))
      const at = vertex(A[k], base(k) + thickness)
      const bb = vertex(B[k], base(k))
      const bt = vertex(B[k], base(k) + thickness)
      if (last) walls.push(ab, bt, bb, ab, at, bt)
      else walls.push(ab, bb, bt, ab, bt, at)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex([...faces, ...walls])
  geometry.addGroup(0, faces.length, 0)
  geometry.addGroup(faces.length, walls.length, 1)
  geometry.computeVertexNormals()
  return geometry
}
