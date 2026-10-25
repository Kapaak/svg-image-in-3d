import * as THREE from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'

// Faces meeting at a sharper angle than this get a line between them.
export const CREASE = Math.cos((30 * Math.PI) / 180)

// The edges of a mesh that belong in a line drawing, as fat line segments:
// - always drawn: creases (faces meeting at an angle or changing material,
//   e.g. front face vs side) and open boundaries;
// - drawn while they are a silhouette: edges inside smooth surfaces, shown
//   only where one of their two faces turns away from the camera. That
//   depends on the view, so it is decided per frame on the GPU.
// Edges inside flat areas (just the triangulation) are left out.
export function createEdgeLines(geometry, material) {
  const source = geometry.index ? geometry.toNonIndexed() : geometry
  const position = source.attributes.position
  const ranges = source.groups.length ? source.groups : [{ start: 0, count: position.count, materialIndex: 0 }]
  if (!source.boundingBox) source.computeBoundingBox()
  const size = source.boundingBox.getSize(new THREE.Vector3())
  const quantum = Math.max(size.x, size.y, size.z, 1e-9) * 1e-6
  const keyOf = (v) => `${Math.round(v.x / quantum)},${Math.round(v.y / quantum)},${Math.round(v.z / quantum)}`

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const edges = new Map()
  for (const { start, count, materialIndex } of ranges) {
    for (let v = start; v + 2 < start + count; v += 3) {
      a.fromBufferAttribute(position, v)
      b.fromBufferAttribute(position, v + 1)
      c.fromBufferAttribute(position, v + 2)
      const normal = b.clone().sub(a).cross(c.clone().sub(a))
      if (normal.lengthSq() === 0) continue
      normal.normalize()
      const corners = [a.clone(), b.clone(), c.clone()]
      const keys = corners.map(keyOf)
      for (let e = 0; e < 3; e++) {
        const k1 = keys[e]
        const k2 = keys[(e + 1) % 3]
        if (k1 === k2) continue
        const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`
        if (!edges.has(key)) edges.set(key, [])
        edges.get(key).push({ from: corners[e], to: corners[(e + 1) % 3], forward: k1 < k2, normal, materialIndex })
      }
    }
  }
  if (source !== geometry) source.dispose()

  const positions = []
  const normalsA = []
  const normalsB = []
  const always = []
  for (const sides of edges.values()) {
    const [p, q] = sides
    let normalB = p.normal
    let isAlways = sides.length !== 2 || p.materialIndex !== q.materialIndex
    if (sides.length === 2) {
      // Consistently wound neighbours run along their shared edge in opposite
      // directions; otherwise one of the normals points the other way.
      normalB = p.forward !== q.forward ? q.normal : q.normal.clone().negate()
      const cos = p.normal.dot(normalB)
      if (cos < CREASE) isAlways = true
      // Flat: can never be a silhouette.
      else if (!isAlways && cos > 0.99999) continue
    }
    positions.push(p.from.x, p.from.y, p.from.z, p.to.x, p.to.y, p.to.z)
    normalsA.push(p.normal.x, p.normal.y, p.normal.z)
    normalsB.push(normalB.x, normalB.y, normalB.z)
    always.push(isAlways ? 1 : 0)
  }
  if (!always.length) return null

  const lines = new LineSegmentsGeometry()
  lines.setPositions(positions)
  lines.setAttribute('instanceNormalA', new THREE.InstancedBufferAttribute(new Float32Array(normalsA), 3))
  lines.setAttribute('instanceNormalB', new THREE.InstancedBufferAttribute(new Float32Array(normalsB), 3))
  lines.setAttribute('instanceAlways', new THREE.InstancedBufferAttribute(new Float32Array(always), 1))
  const segments = new LineSegments2(lines, material)
  // After the surfaces, so the lines on them are drawn on top.
  segments.renderOrder = 1
  return segments
}

// A fat-line material that hides silhouette candidates while both their faces
// look the same way (both towards or both away from the camera).
export function createEdgeMaterial() {
  // Double-sided: the model is mirrored (SVG y points down), which flips the
  // winding of the line quads.
  const material = new LineMaterial({ linewidth: 1.5, depthWrite: false, side: THREE.DoubleSide })
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        'attribute vec3 instanceEnd;',
        `attribute vec3 instanceEnd;
        attribute vec3 instanceNormalA;
        attribute vec3 instanceNormalB;
        attribute float instanceAlways;
        varying float vHidden;`,
      )
      .replace(
        'vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );',
        `vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );
        vec3 toEye = - ( start.xyz + end.xyz ) * 0.5;
        float facingA = dot( normalize( normalMatrix * instanceNormalA ), toEye );
        float facingB = dot( normalize( normalMatrix * instanceNormalB ), toEye );
        vHidden = ( instanceAlways > 0.5 || facingA * facingB < 0.0 ) ? 0.0 : 1.0;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `varying float vHidden;
        void main() {
          if ( vHidden > 0.5 ) discard;`)
  }
  material.customProgramCacheKey = () => 'svg3d-edge-lines'
  return material
}
