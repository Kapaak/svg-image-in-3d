import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { createEdgeLines, createEdgeMaterial } from './edgeLines.js'
import { sceneToSvg } from './exportSvg.js'
import { liftProfile } from './ribbon.js'
import { stackHeights } from './stacking.js'
import { createLayerGeometry, cssColor } from './svg.js'

// The longest side of every SVG is scaled to this many world units.
const FIT_SIZE = 10
// Above this many layers, rebuilds are debounced instead of done every frame.
const LIVE_REBUILD_LIMIT = 150
const DEG = Math.PI / 180
// Fixed proportions, as a percentage of the SVG's longest side: the rounded
// edge on filled shapes, and how far a shape or a line stands above whatever
// it is drawn over.
const BEVEL = 0.45
const LAYER_STEP = 1.5
const LINE_LIFT = 0.5

export const INITIAL_ROTATION = { x: 18, y: -32 }

export const FINISHES = {
  matte: { label: 'Matte', roughness: 0.85, metalness: 0, clearcoat: 0 },
  satin: { label: 'Satin', roughness: 0.45, metalness: 0.05, clearcoat: 0 },
  glossy: { label: 'Glossy', roughness: 0.25, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06 },
  metal: { label: 'Metal', roughness: 0.28, metalness: 1, clearcoat: 0 },
}

export const wrapDeg = (a) => ((((a + 180) % 360) + 360) % 360) - 180

// Owns the Three.js scene: renders the extruded SVG, handles drag-to-rotate and
// wheel zoom on `container`, and reports rotation changes through `onRotate`.
export class SvgScene {
  svg = null
  shape = { depth: 8, gap: 2, flip: false }
  look = { finish: 'satin', useSvgColors: true, color: '#5b5bf0' }
  // 'shaded', 'edges' (white with visible edges) or 'wireframe' (all edges).
  display = 'shaded'
  autoRotate = false
  onRotate = null

  // Targets are unbounded degrees so turning past ±180° never spins the long way round.
  rotation = { target: { ...INITIAL_ROTATION }, current: { x: 0, y: 0 } }
  zoom = { target: 1, current: 1 }
  drag = null
  lastTime = null
  reported = { ...INITIAL_ROTATION }
  pendingBuild = null
  cleanups = []

  constructor(container) {
    this.container = container

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.toneMapping = THREE.NeutralToneMapping
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.domElement.className = 'stage-canvas'
    container.prepend(renderer.domElement)
    this.renderer = renderer

    const scene = new THREE.Scene()
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.7
    pmrem.dispose()
    this.scene = scene

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 500)

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.8)
    keyLight.position.set(-8, 14, 16)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(2048, 2048)
    keyLight.shadow.radius = 4
    keyLight.shadow.bias = -0.0004
    keyLight.shadow.normalBias = 0.02
    Object.assign(keyLight.shadow.camera, { near: 1, far: 60 })
    scene.add(keyLight)
    this.keyLight = keyLight

    const rimLight = new THREE.DirectionalLight(0xc8d6ff, 0.7)
    rimLight.position.set(10, -4, -12)
    scene.add(rimLight)

    // pivot carries the user's rotation; model holds the centred, scaled SVG meshes.
    this.pivot = new THREE.Group()
    this.model = new THREE.Group()
    this.pivot.add(this.model)
    scene.add(this.pivot)

    // Line display modes. The white "paper" fill is pushed back a little in
    // the depth test so the lines lying on it always show; behind it they don't.
    this.edgeMaterial = createEdgeMaterial()
    this.edgeMaterial.toneMapped = false
    this.paperMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, toneMapped: false })
    this.hiddenMaterial = new THREE.MeshBasicMaterial({ visible: false })
    // The wireframe uses the page's text colour, so follow light/dark mode.
    const darkMode = window.matchMedia('(prefers-color-scheme: dark)')
    this.listen(darkMode, 'change', () => this.applyDisplay())

    this.listen(container, 'pointerdown', this.onPointerDown)
    this.listen(container, 'pointermove', this.onPointerMove)
    this.listen(container, 'pointerup', this.onPointerUp)
    this.listen(container, 'pointercancel', this.onPointerUp)
    this.listen(container, 'wheel', this.onWheel, { passive: false })

    const resizeObserver = new ResizeObserver(() => this.resize())
    resizeObserver.observe(container)
    this.cleanups.push(() => resizeObserver.disconnect())
    this.resize()

    renderer.setAnimationLoop((time) => this.frame(time))
  }

  listen(target, type, handler, options) {
    target.addEventListener(type, handler, options)
    this.cleanups.push(() => target.removeEventListener(type, handler, options))
  }

  /* ---------- Public API ---------- */

  setSvg(svg) {
    this.svg = svg
    this.cancelBuild()
    this.build()
  }

  setShape(shape) {
    this.shape = shape
    this.queueBuild()
  }

  setLook(look) {
    this.look = look
    for (const mesh of this.model.children) {
      for (const material of mesh.userData.materials) this.styleMaterial(material, mesh.userData.layer)
    }
  }

  setDisplay(display) {
    this.display = display
    this.applyDisplay()
  }

  // Puts the meshes into the current display mode. Edge lines are only built
  // once a line mode is used, and then kept until the geometry changes.
  applyDisplay() {
    const lineMode = this.display !== 'shaded'
    if (lineMode) {
      const text = getComputedStyle(document.documentElement).getPropertyValue('--text').trim()
      this.edgeMaterial.color.set(this.display === 'edges' || !text ? '#111111' : text)
    }
    for (const mesh of this.model.children) {
      if (lineMode && mesh.userData.edges === undefined) {
        mesh.userData.edges = createEdgeLines(mesh.geometry, this.edgeMaterial)
        if (mesh.userData.edges) mesh.add(mesh.userData.edges)
      }
      if (mesh.userData.edges) mesh.userData.edges.visible = lineMode
      const fill = { shaded: null, edges: this.paperMaterial, wireframe: this.hiddenMaterial }[this.display]
      mesh.material = fill ? [fill, fill] : mesh.userData.materials
    }
  }

  setAutoRotate(on) {
    this.autoRotate = on
  }

  setRotation(axis, degrees) {
    this.rotation.target[axis] += wrapDeg(degrees - this.rotation.target[axis])
    // The UI already shows this value (180 stays 180 rather than becoming -180).
    this.reported[axis] = degrees
  }

  resetView() {
    this.rotation.target.x -= wrapDeg(this.rotation.target.x)
    this.rotation.target.y -= wrapDeg(this.rotation.target.y)
    this.zoom.target = 1
  }

  // The current view as SVG markup in one of EXPORT_STYLES (null if there is
  // nothing to export).
  exportSvg(style) {
    // The export renders the shaded scene for its colours.
    const display = this.display
    if (display !== 'shaded') this.setDisplay('shaded')
    try {
      return sceneToSvg({ renderer: this.renderer, scene: this.scene, camera: this.camera, model: this.model, style })
    } finally {
      if (display !== 'shaded') {
        this.setDisplay(display)
        this.renderer.render(this.scene, this.camera)
      }
    }
  }

  dispose() {
    this.renderer.setAnimationLoop(null)
    this.cancelBuild()
    for (const cleanup of this.cleanups) cleanup()
    this.clearModel()
    this.edgeMaterial.dispose()
    this.paperMaterial.dispose()
    this.hiddenMaterial.dispose()
    this.scene.environment.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  /* ---------- Geometry ---------- */

  clearModel() {
    for (const mesh of this.model.children) {
      mesh.geometry.dispose()
      mesh.userData.edges?.geometry.dispose()
      for (const material of mesh.userData.materials) material.dispose()
    }
    this.model.clear()
  }

  build() {
    this.clearModel()
    if (!this.svg) return

    const { model } = this
    const { layers, center, maxDim, grid } = this.svg
    const n = layers.length
    const base = Math.max(maxDim * (this.shape.depth / 100), maxDim * 0.002)
    // Every rise gets a hair of extra height so stacked faces never z-fight.
    const minRise = maxDim * 0.0005
    const bevel = maxDim * (BEVEL / 100)
    // Self-crossing lines: how high each part climbs over the parts drawn before it.
    // Air between a line and the part of it that it passes over (never quite
    // zero, so touching faces don't z-fight).
    const gap = Math.max(maxDim * (this.shape.gap / 100), minRise)
    const lifts = []
    const ranges = stackHeights(layers, grid, {
      base,
      step: maxDim * (LAYER_STEP / 100) + minRise,
      lift: maxDim * (LINE_LIFT / 100) + minRise,
      // Deep enough that lines also cover the bevelled rim they sit on.
      embed: bevel + maxDim * 0.002,
      rise: (i, thickness) => {
        if (!layers[i].ribbon) return 0
        lifts[i] = liftProfile(layers[i].ribbon, this.shape.flip, gap / thickness)
        return lifts[i].reduce((max, z) => Math.max(max, z), 0)
      },
    })
    // Backs are staggered by a hair for the same reason.
    const epsilon = Math.min(minRise, (base * 0.5) / n)

    layers.forEach((layer, i) => {
      const floor = Math.max(ranges[i].floor, i * epsilon)
      const thickness = ranges[i].top - floor
      let geometry
      try {
        geometry = createLayerGeometry(layer, { thickness, bevel, lift: lifts[i] })
      } catch (err) {
        console.warn('Skipping a layer that could not be extruded', err)
        return
      }

      // Walls are pushed back in the depth test so they never bleed through the
      // front face where they meet it (or where stroke triangles overlap).
      // Only back faces cast shadows, which keeps lit faces free of shadow acne.
      const materials = [
        new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, shadowSide: THREE.BackSide }),
        new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, shadowSide: THREE.BackSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      ]
      for (const material of materials) this.styleMaterial(material, layer)

      const mesh = new THREE.Mesh(geometry, materials)
      mesh.position.z = floor
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData.layer = layer
      mesh.userData.materials = materials
      model.add(mesh)
    })
    this.applyDisplay()

    // Centre the model on the pivot (SVG y points down, so flip it).
    const box = new THREE.Box3()
    for (const mesh of model.children) {
      mesh.geometry.computeBoundingBox()
      box.union(mesh.geometry.boundingBox.clone().translate(mesh.position))
    }
    const s = FIT_SIZE / maxDim
    const zCenter = (box.min.z + box.max.z) / 2
    model.scale.set(s, -s, s)
    model.position.set(-center.x * s, center.y * s, -zCenter * s)

    // Fit the shadow map tightly around the object, in any orientation, for
    // crisper self-shadows.
    const radius = 0.5 * Math.hypot(maxDim, maxDim, box.max.z - box.min.z) * s
    const shadowCamera = this.keyLight.shadow.camera
    Object.assign(shadowCamera, { left: -radius, right: radius, top: radius, bottom: -radius })
    shadowCamera.updateProjectionMatrix()
  }

  queueBuild() {
    if (!this.svg) return
    this.cancelBuild()
    if (this.svg.layers.length > LIVE_REBUILD_LIMIT) {
      const id = setTimeout(() => this.build(), 200)
      this.pendingBuild = () => clearTimeout(id)
    } else {
      const id = requestAnimationFrame(() => this.build())
      this.pendingBuild = () => cancelAnimationFrame(id)
    }
  }

  cancelBuild() {
    this.pendingBuild?.()
    this.pendingBuild = null
  }

  styleMaterial(material, layer) {
    const finish = FINISHES[this.look.finish] ?? FINISHES.satin
    material.roughness = finish.roughness
    material.metalness = finish.metalness
    material.clearcoat = finish.clearcoat
    material.clearcoatRoughness = finish.clearcoatRoughness ?? 0

    const custom = !this.look.useSvgColors && cssColor(this.look.color)
    material.color.copy(custom ? custom.color : layer.color)

    const transparent = layer.opacity < 1
    if (material.transparent !== transparent) {
      material.transparent = transparent
      material.needsUpdate = true
    }
    material.opacity = layer.opacity
  }

  /* ---------- Interaction ---------- */

  onPointerDown = (e) => {
    this.drag = { x: e.clientX, y: e.clientY }
    this.container.setPointerCapture(e.pointerId)
    this.container.classList.add('grabbing')
  }

  onPointerMove = (e) => {
    if (!this.drag) return
    this.rotation.target.y += (e.clientX - this.drag.x) * 0.4
    this.rotation.target.x += (e.clientY - this.drag.y) * 0.4
    this.drag = { x: e.clientX, y: e.clientY }
  }

  onPointerUp = () => {
    this.drag = null
    this.container.classList.remove('grabbing')
  }

  onWheel = (e) => {
    e.preventDefault()
    this.zoom.target = THREE.MathUtils.clamp(this.zoom.target * Math.exp(e.deltaY * 0.001), 0.4, 2.5)
  }

  /* ---------- Rendering ---------- */

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.edgeMaterial.resolution.set(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  // Distance at which the object fills a comfortable part of the view.
  fitDistance() {
    const visible = FIT_SIZE * 1.6
    return visible / 2 / Math.tan((this.camera.fov * DEG) / 2) / Math.min(1, this.camera.aspect)
  }

  frame(time) {
    const dt = this.lastTime === null ? 0 : Math.min((time - this.lastTime) / 1000, 0.05)
    this.lastTime = time
    const { rotation, zoom, camera } = this

    if (this.autoRotate && !this.drag) rotation.target.y += dt * 35

    // Frame-rate independent easing toward the target.
    const k = 1 - Math.exp(-dt * 12)
    rotation.current.x += (rotation.target.x - rotation.current.x) * k
    rotation.current.y += (rotation.target.y - rotation.current.y) * k
    zoom.current += (zoom.target - zoom.current) * k

    this.pivot.rotation.set(rotation.current.x * DEG, rotation.current.y * DEG, 0)
    camera.position.set(0, 0, this.fitDistance() * zoom.current)
    camera.lookAt(0, 0, 0)
    this.renderer.render(this.scene, camera)

    // Report whole-degree changes (from dragging, auto-rotate, reset) to the UI.
    const x = Math.round(wrapDeg(rotation.target.x))
    const y = Math.round(wrapDeg(rotation.target.y))
    if (x !== wrapDeg(this.reported.x) || y !== wrapDeg(this.reported.y)) {
      this.reported = { x, y }
      this.onRotate?.({ x, y })
    }
  }
}
