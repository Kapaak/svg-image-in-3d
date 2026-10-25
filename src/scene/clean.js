import ClipperLib from 'clipper-lib'
import * as THREE from 'three'

// Clipper works on integers; coordinates are scaled so the path spans ~1e7 units.
const PRECISION = 1e7

// Resolves self-intersections and overlapping sub-paths with the SVG fill rule
// (the way browsers fill them) and returns simple shapes with holes. Without
// this, a self-crossing outline is triangulated wrongly (e.g. a filled-in loop)
// and tiny glitches in exported outlines turn into spikes. A non-zero `offset`
// (SVG units) then grows or shrinks the outline, with rounded corners.
export function cleanFill(path, fillRule, offset = 0) {
  const polygons = path.subPaths.map((subPath) => subPath.getPoints(24)).filter((points) => points.length >= 3)
  if (!polygons.length) return []

  const box = new THREE.Box2()
  for (const points of polygons) for (const p of points) box.expandByPoint(p)
  const size = box.getSize(new THREE.Vector2())
  const scale = PRECISION / (Math.max(size.x, size.y) || 1)

  const paths = polygons.map((points) => points.map((p) => ({ X: Math.round(p.x * scale), Y: Math.round(p.y * scale) })))
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(ClipperLib.Clipper.CleanPolygons(paths, PRECISION * 1e-4), ClipperLib.PolyType.ptSubject, true)
  const rule = fillRule === 'evenodd' ? ClipperLib.PolyFillType.pftEvenOdd : ClipperLib.PolyFillType.pftNonZero
  const tree = new ClipperLib.PolyTree()
  if (offset) {
    const merged = []
    clipper.Execute(ClipperLib.ClipType.ctUnion, merged, rule, rule)
    const grow = new ClipperLib.ClipperOffset(2, PRECISION * 1e-4)
    grow.AddPaths(merged, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
    grow.Execute(tree, offset * scale)
  } else {
    clipper.Execute(ClipperLib.ClipType.ctUnion, tree, rule, rule)
  }
  return shapesFromTree(tree, scale)
}

// Merges a pile of overlapping triangles (x,y pairs, as SVGLoader triangulates
// strokes) into clean shapes with holes, outlining only the outside.
export function trianglesToShapes(tri) {
  const box = new THREE.Box2()
  const point = new THREE.Vector2()
  for (let i = 0; i < tri.length; i += 2) box.expandByPoint(point.set(tri[i], tri[i + 1]))
  const size = box.getSize(new THREE.Vector2())
  const scale = PRECISION / (Math.max(size.x, size.y) || 1)

  const paths = []
  for (let i = 0; i < tri.length; i += 6) {
    const path = [0, 2, 4].map((k) => ({ X: Math.round(tri[i + k] * scale), Y: Math.round(tri[i + k + 1] * scale) }))
    if (!ClipperLib.Clipper.Area(path)) continue
    // Wind every triangle the same way so overlaps add up instead of cancelling.
    paths.push(ClipperLib.Clipper.Orientation(path) ? path : path.reverse())
  }
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const tree = new ClipperLib.PolyTree()
  clipper.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return shapesFromTree(tree, scale)
}

function shapesFromTree(tree, scale) {
  const toPoints = (contour) => contour.map((p) => new THREE.Vector2(p.X / scale, p.Y / scale))
  const shapes = []
  // Top-level nodes are outlines, their children holes, and holes' children islands.
  const collect = (node) => {
    for (const outline of node.Childs()) {
      const shape = new THREE.Shape(toPoints(outline.Contour()))
      for (const hole of outline.Childs()) {
        shape.holes.push(new THREE.Path(toPoints(hole.Contour())))
        collect(hole)
      }
      shapes.push(shape)
    }
  }
  collect(tree)
  return shapes
}

// Half the typical thickness of filled shapes: area / perimeter, which is
// exactly half the width for a line drawn as a filled outline.
export function halfThickness(shapes) {
  let area = 0
  let perimeter = 0
  const length = (points) => points.reduce((sum, p, i) => sum + p.distanceTo(points[(i + 1) % points.length]), 0)
  for (const shape of shapes) {
    const outline = shape.getPoints()
    area += Math.abs(THREE.ShapeUtils.area(outline))
    perimeter += length(outline)
    for (const hole of shape.holes) {
      const points = hole.getPoints()
      area -= Math.abs(THREE.ShapeUtils.area(points))
      perimeter += length(points)
    }
  }
  return perimeter > 0 ? area / perimeter : 0
}
