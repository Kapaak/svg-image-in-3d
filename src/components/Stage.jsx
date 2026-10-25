import { useEffect, useImperativeHandle, useRef } from 'react'
import { SvgScene } from '../scene/SvgScene.js'

// React wrapper around SvgScene. The parent drives rotation and export through
// `ref` (setRotation / resetView / exportSvg) and hears about drag &
// auto-rotate via onRotate, and about each finished build via onBuilt.
export default function Stage({ ref, svg, shape, look, display, autoRotate, onRotate, onBuilt, children }) {
  const viewportRef = useRef(null)
  const sceneRef = useRef(null)

  useEffect(() => {
    const scene = new SvgScene(viewportRef.current)
    sceneRef.current = scene
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
  }, [])

  useImperativeHandle(ref, () => ({
    setRotation: (axis, degrees) => sceneRef.current?.setRotation(axis, degrees),
    resetView: () => sceneRef.current?.resetView(),
    exportSvg: (style) => sceneRef.current?.exportSvg(style) ?? null,
  }), [])

  // Shape and look go in before the SVG so the first build already uses them.
  useEffect(() => {
    sceneRef.current.onRotate = onRotate
  }, [onRotate])

  useEffect(() => {
    sceneRef.current.onBuilt = onBuilt
  }, [onBuilt])

  useEffect(() => {
    sceneRef.current.setLook(look)
  }, [look])

  useEffect(() => {
    sceneRef.current.setShape(shape)
  }, [shape])

  useEffect(() => {
    sceneRef.current.setDisplay(display)
  }, [display])

  useEffect(() => {
    sceneRef.current.setAutoRotate(autoRotate)
  }, [autoRotate])

  useEffect(() => {
    sceneRef.current.setSvg(svg)
  }, [svg])

  return (
    <section className="stage" aria-label="3D preview">
      <div className="stage-viewport" ref={viewportRef} />
      {children}
    </section>
  )
}
