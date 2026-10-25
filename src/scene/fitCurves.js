// Fits smooth cubic Bézier curves through dense polylines, so exported SVGs
// need far fewer points and curves come out smooth instead of ragged. Sharp
// corners are found first and kept sharp; the runs between them are fitted
// with Philip J. Schneider's algorithm ("An Algorithm for Automatically
// Fitting Digitized Curves", Graphics Gems, 1990): a least-squares cubic,
// refined by Newton–Raphson re-parameterisation, split where it strays too far.

// Turning more than this (measured over CORNER_REACH on each side) is a corner.
const CORNER = Math.cos((40 * Math.PI) / 180)
// How far (px) along the line to look when estimating directions, so tiny
// jitter in the input doesn't count as a corner or skew a tangent.
const CORNER_REACH = 1.5

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
const scale = (a, s) => [a[0] * s, a[1] * s]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1]
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const normalize = (a) => {
  const length = Math.hypot(a[0], a[1])
  return length ? [a[0] / length, a[1] / length] : [0, 0]
}

// SVG path data for a polyline ([x, y] points), as lines and cubic curves
// that stay within `tolerance` of it.
export function fitPathData(input, { closed = false, tolerance = 0.25 } = {}) {
  const points = []
  for (const p of input) {
    if (!points.length || distance(p, points[points.length - 1]) > 1e-6) points.push(p)
  }
  if (closed && points.length > 1 && distance(points[0], points[points.length - 1]) <= 1e-6) points.pop()
  if (points.length < 2) return ''

  const runs = splitAtCorners(points, closed)
  const segments = []
  for (const { run, startTangent, endTangent } of runs) {
    // Too few points to tell a curve from a couple of straight sides.
    if (run.length <= 3) {
      for (const p of run.slice(1)) segments.push({ line: p })
      continue
    }
    const curves = []
    fitCubic(run, 0, run.length - 1, startTangent, endTangent, tolerance * tolerance, curves)
    for (const curve of curves) segments.push(isStraight(curve, tolerance) ? { line: curve[3] } : { curve })
  }

  // A closing straight line is implied by Z.
  const last = segments[segments.length - 1]
  if (closed && segments.length > 1 && last.line && distance(last.line, runs[0].run[0]) <= 1e-6) segments.pop()

  const n = (v) => String(Math.round(v * 100) / 100)
  const xy = ([x, y]) => `${n(x)} ${n(y)}`
  let d = `M${xy(runs[0].run[0])}`
  for (const segment of segments) {
    d += segment.line ? `L${xy(segment.line)}` : `C${xy(segment.curve[1])} ${xy(segment.curve[2])} ${xy(segment.curve[3])}`
  }
  return closed ? `${d}Z` : d
}

// The point `reach` px away from index i, walking in direction `step`. On a
// closed outline it walks at most halfway round, so on tiny shapes the two
// directions never swap sides.
function pointAway(points, i, step, closed, reach) {
  const count = points.length
  const steps = closed ? Math.max(1, Math.floor((count - 1) / 2)) : count - 1
  let j = i
  for (let k = 0; k < steps; k++) {
    const next = j + step
    if (!closed && (next < 0 || next >= count)) break
    j = (next + count) % count
    if (distance(points[j], points[i]) >= reach) break
  }
  return points[j]
}

// Splits the polyline at sharp corners into runs, each with the directions
// the curve should leave its start and enter its end with (Schneider's
// convention: the end tangent points back into the run).
function splitAtCorners(points, closed) {
  const count = points.length
  const turn = points.map((p, i) => {
    if (!closed && (i === 0 || i === count - 1)) return 1
    const before = pointAway(points, i, -1, closed, CORNER_REACH)
    const after = pointAway(points, i, 1, closed, CORNER_REACH)
    if (before === p || after === p) return 1
    return dot(normalize(sub(p, before)), normalize(sub(after, p)))
  })
  // Keep the sharpest point of each corner, not every point near it.
  const corners = []
  for (let i = 0; i < count; i++) {
    if (turn[i] >= CORNER) continue
    let sharpest = true
    for (const step of [-1, 1]) {
      for (let k = 1; k < count && sharpest; k++) {
        const j = closed ? (i + step * k + count) % count : i + step * k
        if (j < 0 || j >= count || distance(points[j], points[i]) > CORNER_REACH) break
        if (turn[j] < turn[i] || (turn[j] === turn[i] && j < i)) sharpest = false
      }
    }
    if (sharpest) corners.push(i)
  }

  const runOf = (from, to) => {
    const run = []
    for (let k = from; ; k = (k + 1) % count) {
      run.push(points[k])
      if (k === to % count && run.length > 1) break
    }
    return run
  }
  const edgeTangents = (run) => ({
    run,
    startTangent: normalize(sub(pointAway(run, 0, 1, false, CORNER_REACH), run[0])),
    endTangent: normalize(sub(pointAway(run, run.length - 1, -1, false, CORNER_REACH), run[run.length - 1])),
  })

  if (!closed) {
    const cuts = [0, ...corners, count - 1]
    const runs = []
    for (let k = 0; k + 1 < cuts.length; k++) runs.push(edgeTangents(points.slice(cuts[k], cuts[k + 1] + 1)))
    return runs
  }
  if (!corners.length) {
    // A smooth loop: start anywhere, and leave and return in the same direction.
    const run = [...points, points[0]]
    const tangent = normalize(sub(pointAway(points, 0, 1, true, CORNER_REACH), pointAway(points, 0, -1, true, CORNER_REACH)))
    return [{ run, startTangent: tangent, endTangent: scale(tangent, -1) }]
  }
  return corners.map((corner, k) => edgeTangents(runOf(corner, k + 1 < corners.length ? corners[k + 1] : corners[0] + count)))
}

// A curve whose control points lie on the chord is just a straight line.
function isStraight([p0, c1, c2, p3], tolerance) {
  const chord = distance(p0, p3)
  if (!chord) return false
  const off = (c) => Math.abs((p3[0] - p0[0]) * (c[1] - p0[1]) - (p3[1] - p0[1]) * (c[0] - p0[0])) / chord
  const along = (c) => dot(sub(c, p0), sub(p3, p0)) / (chord * chord)
  return [c1, c2].every((c) => off(c) <= tolerance * 0.5 && along(c) >= 0 && along(c) <= 1)
}

/* ---------- Schneider's fitting ---------- */

function fitCubic(points, first, last, tHat1, tHat2, errorSq, out) {
  if (last - first === 1) {
    // Keep the curve smooth into its neighbours, unless that would bow it
    // away from the straight segment; then it's simply a straight line.
    const p0 = points[first]
    const p3 = points[last]
    const third = distance(p0, p3) / 3
    const smooth = [p0, add(p0, scale(tHat1, third)), add(p3, scale(tHat2, third)), p3]
    out.push(staysClose(points, first, last, smooth, errorSq) ? smooth : [p0, add(p0, scale(sub(p3, p0), 1 / 3)), add(p0, scale(sub(p3, p0), 2 / 3)), p3])
    return
  }
  // Straight enough for a plain line? (Keeps jitter from becoming wiggles.)
  const p0 = points[first]
  const p3 = points[last]
  const chord = sub(p3, p0)
  const chordSq = dot(chord, chord)
  let straight = chordSq > 0
  for (let i = first + 1; i < last && straight; i++) {
    const f = Math.max(0, Math.min(1, dot(sub(points[i], p0), chord) / chordSq))
    const off = sub(points[i], add(p0, scale(chord, f)))
    straight = dot(off, off) <= errorSq
  }
  if (straight) {
    out.push([p0, add(p0, scale(chord, 1 / 3)), add(p0, scale(chord, 2 / 3)), p3])
    return
  }

  let u = chordLengthParameterize(points, first, last)
  let bezier = generateBezier(points, first, last, u, tHat1, tHat2)
  let { maxError, split } = computeMaxError(points, first, last, bezier, u)
  // The error is only measured at the input points; also make sure the curve
  // doesn't bulge out between them (it can, on runs with few points).
  const accept = () => maxError < errorSq && staysClose(points, first, last, bezier, errorSq)
  if (accept()) {
    out.push(bezier)
    return
  }
  if (maxError < errorSq * 4) {
    for (let i = 0; i < 4; i++) {
      u = reparameterize(points, first, last, u, bezier)
      bezier = generateBezier(points, first, last, u, tHat1, tHat2)
      ;({ maxError, split } = computeMaxError(points, first, last, bezier, u))
      if (accept()) {
        out.push(bezier)
        return
      }
    }
  }
  // Close at the points but bulging between them: split in the middle.
  if (maxError < errorSq) split = Math.floor((first + last) / 2)

  // Split where it strays most, keeping the curve smooth across the split.
  const before = points[split - 1]
  const after = points[split + 1]
  const center = normalize(sub(before, after))
  fitCubic(points, first, split, tHat1, center, errorSq, out)
  fitCubic(points, split, last, scale(center, -1), tHat2, errorSq, out)
}

function chordLengthParameterize(points, first, last) {
  const u = [0]
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + distance(points[i], points[i - 1]))
  const total = u[u.length - 1]
  return u.map((v) => (total ? v / total : 0))
}

// Least-squares control points along the given end tangents.
function generateBezier(points, first, last, u, tHat1, tHat2) {
  const p0 = points[first]
  const p3 = points[last]
  let c00 = 0
  let c01 = 0
  let c11 = 0
  let x0 = 0
  let x1 = 0
  for (let i = 0; i < u.length; i++) {
    const t = u[i]
    const mt = 1 - t
    const b0 = mt * mt * mt
    const b1 = 3 * t * mt * mt
    const b2 = 3 * t * t * mt
    const b3 = t * t * t
    const a0 = scale(tHat1, b1)
    const a1 = scale(tHat2, b2)
    c00 += dot(a0, a0)
    c01 += dot(a0, a1)
    c11 += dot(a1, a1)
    const tmp = sub(points[first + i], add(scale(p0, b0 + b1), scale(p3, b2 + b3)))
    x0 += dot(a0, tmp)
    x1 += dot(a1, tmp)
  }
  const det = c00 * c11 - c01 * c01
  let alphaL = det ? (x0 * c11 - x1 * c01) / det : 0
  let alphaR = det ? (c00 * x1 - c01 * x0) / det : 0
  const segment = distance(p0, p3)
  // Handles longer than the stretch itself only make loops and spikes.
  let length = 0
  for (let i = first + 1; i <= last; i++) length += distance(points[i], points[i - 1])
  if (alphaL < 1e-6 * segment || alphaR < 1e-6 * segment || alphaL > length || alphaR > length) alphaL = alphaR = segment / 3
  return [p0, add(p0, scale(tHat1, alphaL)), add(p3, scale(tHat2, alphaR)), p3]
}

// Whether the curve stays within a few tolerances of the polyline it
// replaces, checked at points along the curve.
function staysClose(points, first, last, bezier, errorSq) {
  const limitSq = 4 * errorSq
  for (let s = 1; s < 16; s++) {
    const p = bezierPoint(bezier, s / 16)
    let best = Infinity
    for (let i = first; i < last && best > limitSq; i++) {
      const a = points[i]
      const ab = sub(points[i + 1], a)
      const lengthSq = dot(ab, ab)
      const f = lengthSq ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / lengthSq)) : 0
      const off = sub(p, add(a, scale(ab, f)))
      best = Math.min(best, dot(off, off))
    }
    if (best > limitSq) return false
  }
  return true
}

function bezierPoint([p0, p1, p2, p3], t) {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]
}

function computeMaxError(points, first, last, bezier, u) {
  let maxError = 0
  let split = Math.floor((first + last) / 2)
  for (let i = first + 1; i < last; i++) {
    const p = bezierPoint(bezier, u[i - first])
    const errorSq = (p[0] - points[i][0]) ** 2 + (p[1] - points[i][1]) ** 2
    if (errorSq >= maxError) {
      maxError = errorSq
      split = i
    }
  }
  return { maxError, split: Math.min(last - 1, Math.max(first + 1, split)) }
}

// One Newton–Raphson step per point towards the closest point on the curve.
function reparameterize(points, first, last, u, bezier) {
  const [p0, p1, p2, p3] = bezier
  const d1 = [scale(sub(p1, p0), 3), scale(sub(p2, p1), 3), scale(sub(p3, p2), 3)]
  const d2 = [scale(sub(d1[1], d1[0]), 2), scale(sub(d1[2], d1[1]), 2)]
  const quadratic = ([a, b, c], t) => add(add(scale(a, (1 - t) * (1 - t)), scale(b, 2 * t * (1 - t))), scale(c, t * t))
  const linear = ([a, b], t) => add(scale(a, 1 - t), scale(b, t))
  return u.map((t, i) => {
    const q = sub(bezierPoint(bezier, t), points[first + i])
    const q1 = quadratic(d1, t)
    const q2 = linear(d2, t)
    const denominator = dot(q1, q1) + dot(q, q2)
    if (!denominator) return t
    return Math.min(1, Math.max(0, t - dot(q, q1) / denominator))
  })
}
