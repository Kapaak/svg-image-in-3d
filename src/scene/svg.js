import * as THREE from 'three'
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js'
import { cleanFill, halfThickness, trianglesToShapes } from './clean.js'
import { createRibbonGeometry, ribbonFromOutline, ribbonFromStroke } from './ribbon.js'
import { runSliced } from './sliced.js'
import { rasterizeFootprints } from './stacking.js'

let colorCtx

// Any CSS color -> { color: THREE.Color (linear), alpha }.
export function cssColor(value) {
  if (!value || !CSS.supports('color', value)) return null
  colorCtx ??= document.createElement('canvas').getContext('2d')
  colorCtx.fillStyle = '#000'
  colorCtx.fillStyle = value
  const normalized = colorCtx.fillStyle
  let r, g, b
  let a = 1
  if (normalized.startsWith('#')) {
    const n = parseInt(normalized.slice(1), 16)
    r = (n >> 16) & 255
    g = (n >> 8) & 255
    b = n & 255
  } else {
    const parts = normalized.match(/[\d.]+/g)
    if (!parts || parts.length < 3) return null
    ;[r, g, b] = parts.map(Number)
    if (parts[3] !== undefined) a = Number(parts[3])
  }
  return { color: new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace), alpha: a }
}

function findById(root, id) {
  return root.querySelector(`[id="${CSS.escape(id)}"]`)
}

// Gradients can't be extruded as-is, so use the average of their stop colors.
function gradientColor(id, root) {
  let el = findById(root, id)
  for (let hops = 0; el && hops < 5; hops++) {
    const stops = [...el.querySelectorAll('stop')]
    if (stops.length) {
      const sum = new THREE.Color(0, 0, 0)
      for (const stop of stops) {
        const styleMatch = stop.getAttribute('style')?.match(/stop-color\s*:\s*([^;]+)/)
        const value = stop.getAttribute('stop-color') ?? styleMatch?.[1]?.trim() ?? '#000'
        sum.add(cssColor(value)?.color ?? new THREE.Color(0, 0, 0))
      }
      return sum.multiplyScalar(1 / stops.length)
    }
    const href = el.getAttribute('href') ?? el.getAttribute('xlink:href')
    el = href?.startsWith('#') ? findById(root, href.slice(1)) : null
  }
  return null
}

function resolvePaint(value, root) {
  if (value == null) return null
  const v = String(value).trim()
  if (!v || v === 'none' || v === 'transparent') return null
  if (v.startsWith('url(')) {
    const id = v.match(/#([^)'"\s]+)/)?.[1]
    return { color: (id && gradientColor(id, root)) || new THREE.Color(0x888888), alpha: 1 }
  }
  if (v.toLowerCase() === 'currentcolor') {
    return cssColor(root.getAttribute('color')) ?? { color: new THREE.Color(0x111111), alpha: 1 }
  }
  return cssColor(v)
}

// Moves <style> rules into each matching element's style attribute. SVGLoader
// reads rules with Object.entries(rule.style), which in Safari only lists the
// property names, not their values, so every class-styled shape (as
// Illustrator exports them) lost its fill and stroke there. Inline styles
// still win over the rules, as in CSS.
function inlineStylesheets(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const styles = [...doc.querySelectorAll('style')]
  if (!styles.length || doc.querySelector('parsererror')) return text

  const declarations = new Map()
  for (const style of styles) {
    for (const rule of style.sheet?.cssRules ?? []) {
      if (!(rule instanceof CSSStyleRule)) continue
      let targets
      try {
        targets = doc.querySelectorAll(rule.selectorText)
      } catch {
        continue
      }
      let css = ''
      for (let i = 0; i < rule.style.length; i++) {
        const name = rule.style[i]
        css += `${name}:${rule.style.getPropertyValue(name)};`
      }
      for (const target of targets) declarations.set(target, (declarations.get(target) ?? '') + css)
    }
    style.remove()
  }
  for (const [target, css] of declarations) target.setAttribute('style', css + (target.getAttribute('style') ?? ''))
  return new XMLSerializer().serializeToString(doc)
}

// Turns SVG markup into a flat list of layers (fills and strokes) in paint
// order. `weight` scales how thick lines and shapes are drawn (1 = as in the file).
// Large files take a while, so the work is spread over several tasks and the
// page stays responsive; aborting `signal` stops it.
export function parseSvg(text, { weight = 1, signal } = {}) {
  return runSliced(parseSteps(text, weight), { signal })
}

function* parseSteps(text, weight) {
  let data
  try {
    data = new SVGLoader().parse(inlineStylesheets(text))
  } catch {
    throw new Error('This file could not be read as an SVG.')
  }

  const root = data.xml
  const parts = []

  for (const path of data.paths) {
    yield
    const style = path.userData.style
    if (style.visibility === 'hidden') continue
    const opacity = style.opacity ?? 1

    const fill = resolvePaint(style.fill, root)
    if (fill) {
      const shapes = cleanFill(path, style.fillRule)
      if (shapes.length) {
        parts.push({ kind: 'fill', path, style, shapes, half: halfThickness(shapes), color: fill.color, opacity: (style.fillOpacity ?? 1) * opacity * fill.alpha })
      }
    }

    const stroke = resolvePaint(style.stroke, root)
    if (stroke && style.strokeWidth > 0) {
      parts.push({ kind: 'stroke', path, style, color: stroke.color, opacity: (style.strokeOpacity ?? 1) * opacity * stroke.alpha })
    }
  }

  // Line weight: strokes scale their width; filled shapes grow or shrink by the
  // same share of their own thickness, but never by more than a typical line
  // in the drawing would, so large areas (backgrounds) don't balloon.
  const halves = parts.filter((part) => part.kind === 'fill').map((part) => part.half).sort((a, b) => a - b)
  const typicalHalf = halves[Math.floor((halves.length - 1) / 2)] ?? 0

  const layers = []
  for (const { kind, path, style, shapes, half, color, opacity } of parts) {
    yield
    if (kind === 'fill') {
      const offset = (weight - 1) * Math.min(half, typicalHalf)
      const sized = offset ? cleanFill(path, style.fillRule, offset) : shapes
      if (!sized.length) continue
      const layer = { kind, shapes: sized, color, opacity }
      // A single outline may be an outlined stroke that loops over itself.
      if (path.subPaths.length === 1) layer.ribbon = ribbonFromOutline(path.subPaths[0].getPoints(24), offset)
      layers.push(layer)
      continue
    }

    // Strokes are triangulated in 2D here and extruded later.
    const sizedStyle = { ...style, strokeWidth: style.strokeWidth * weight }
    const tri = []
    for (const subPath of path.subPaths) {
      const geometry = SVGLoader.pointsToStroke(subPath.getPoints(32), sizedStyle)
      if (!geometry) continue
      const pos = geometry.attributes.position.array
      for (let i = 0; i < pos.length; i += 3) tri.push(pos[i], pos[i + 1])
      geometry.dispose()
    }
    if (tri.length >= 6) {
      const triangles = new Float32Array(tri)
      layers.push({
        kind,
        // The triangles give the footprint for stacking; the merged shapes the solid.
        tri: triangles,
        shapes: trianglesToShapes(triangles),
        ribbon: ribbonFromStroke(path.subPaths, sizedStyle),
        color,
        opacity,
      })
    }
  }

  if (!layers.length) {
    throw new Error('No drawable shapes found. If the SVG contains text, convert it to outlines first.')
  }

  const bounds = new THREE.Box2()
  for (const layer of layers) {
    layer.bounds = layerBounds(layer)
    bounds.union(layer.bounds)
  }
  const size = bounds.getSize(new THREE.Vector2())
  const maxDim = Math.max(size.x, size.y) || 1
  const grid = yield* rasterizeFootprints(layers, bounds, maxDim)

  return { layers, center: bounds.getCenter(new THREE.Vector2()), maxDim, grid }
}

function layerBounds(layer) {
  const box = new THREE.Box2()
  if (layer.kind === 'fill') {
    for (const shape of layer.shapes) for (const p of shape.getPoints()) box.expandByPoint(p)
  } else {
    const point = new THREE.Vector2()
    for (let i = 0; i < layer.tri.length; i += 2) box.expandByPoint(point.set(layer.tri[i], layer.tri[i + 1]))
  }
  return box
}

// Solid geometry for one layer, in SVG units, spanning z = 0..thickness (plus
// `lift` × thickness where a self-crossing line passes over itself).
export function createLayerGeometry(layer, { thickness, bevel, lift }) {
  if (layer.ribbon) return createRibbonGeometry(layer.ribbon, lift, thickness)
  if (layer.kind === 'stroke') return new THREE.ExtrudeGeometry(layer.shapes, { depth: thickness, bevelEnabled: false })

  // The bevel is cut inwards (negative offset) so the silhouette stays exactly
  // on the SVG outline and never spreads over neighbouring lines.
  const b = Math.min(bevel, thickness * 0.25)
  const geometry = new THREE.ExtrudeGeometry(layer.shapes, {
    depth: thickness - 2 * b,
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments: 4,
    curveSegments: 24,
  })
  geometry.translate(0, 0, b)
  return geometry
}
