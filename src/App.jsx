import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import sampleSvg from './assets/sample.svg?raw'
import RangeControl from './components/RangeControl.jsx'
import Stage from './components/Stage.jsx'
import { EXPORT_STYLES } from './scene/exportSvg.js'
import { FINISHES, INITIAL_ROTATION } from './scene/SvgScene.js'
import { parseSvg } from './scene/svg.js'
import { TEXT_WEIGHTS } from './scene/textLabel.js'
import './App.css'

const isSvgFile = (file) => file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)

// Parses at a line weight (%), falling back to the file as drawn if that makes
// everything shrink away; then it throws with a readable message if the file
// can't be used at all. The result remembers the markup it came from.
async function parseAtWeight(text, weight, signal) {
  let data
  try {
    data = await parseSvg(text, { weight: weight / 100, signal })
  } catch (err) {
    if (signal.aborted || weight === 100) throw err
    data = await parseSvg(text, { signal })
  }
  return { ...data, text }
}

function App() {
  const stageRef = useRef(null)
  const [weight, setWeight] = useState(100)
  // The SVG on show: its name, the line weight it was parsed at, and the result.
  const [current, setCurrent] = useState(null)
  // The file being loaded ({ name, text }), until it is on screen.
  const [loading, setLoading] = useState({ name: 'sample.svg', text: sampleSvg })
  const loadRef = useRef(null)
  const weightRef = useRef(weight)
  const [rotation, setRotation] = useState(INITIAL_ROTATION)
  const [autoRotate, setAutoRotate] = useState(false)
  const [shape, setShape] = useState({ depth: 8, gap: 2, flip: false })
  const [look, setLook] = useState({ finish: 'satin', useSvgColors: true, color: '#5b5bf0' })
  const [text, setText] = useState({ value: '', side: 'front', color: '#ffffff', size: 100, weight: 700, italic: false, spacing: 0 })
  const [style, setStyle] = useState('shaded')
  const [toast, setToast] = useState({ message: '', visible: false })
  const [dragOver, setDragOver] = useState(false)

  const showToast = useCallback((message) => setToast({ message, visible: true }), [])

  // Line weight changes outlines, overlaps and loops, so the SVG is parsed
  // again; a newer weight cancels a parse still running for an older one.
  useEffect(() => {
    weightRef.current = weight
    if (!current || current.weight === weight) return
    const controller = new AbortController()
    parseAtWeight(current.data.text, weight, controller.signal).then((data) => {
      if (!controller.signal.aborted) setCurrent({ ...current, weight, data })
    }, () => {})
    return () => controller.abort()
  }, [current, weight])

  useEffect(() => {
    if (!toast.visible) return
    const id = setTimeout(() => setToast((t) => ({ ...t, visible: false })), 4000)
    return () => clearTimeout(id)
  }, [toast])

  // A new file replaces one still loading. The old model stays on screen,
  // under the loading state, until the new one is built.
  const loadText = useCallback(async (text, name) => {
    loadRef.current?.abort()
    const controller = new AbortController()
    loadRef.current = controller
    setLoading({ name, text })
    const weight = weightRef.current
    try {
      const data = await parseAtWeight(text, weight, controller.signal)
      if (!controller.signal.aborted) setCurrent({ name, weight, data })
    } catch (err) {
      if (controller.signal.aborted) return
      setLoading(null)
      showToast(err.message)
    }
  }, [showToast])

  // The sample, at the initial weight; `loading` already starts out on it.
  useEffect(() => {
    const controller = new AbortController()
    parseAtWeight(sampleSvg, 100, controller.signal).then((data) => {
      if (!controller.signal.aborted) setCurrent((c) => c ?? { name: 'sample.svg', weight: 100, data })
    }, () => {})
    return () => controller.abort()
  }, [])

  const onBuilt = useCallback((built) => {
    setLoading((l) => (l && built?.text === l.text ? null : l))
  }, [])

  const loadFile = useCallback(async (file) => {
    if (!file) return
    if (!isSvgFile(file)) {
      showToast('Please choose an .svg file.')
      return
    }
    loadText(await file.text(), file.name)
  }, [loadText, showToast])

  // Files can be dropped anywhere on the page, and SVG markup can be pasted.
  useEffect(() => {
    let dragDepth = 0
    const handlers = {
      dragenter: (e) => {
        e.preventDefault()
        dragDepth++
        setDragOver(true)
      },
      dragleave: () => {
        dragDepth = Math.max(0, dragDepth - 1)
        if (!dragDepth) setDragOver(false)
      },
      dragover: (e) => e.preventDefault(),
      drop: (e) => {
        e.preventDefault()
        dragDepth = 0
        setDragOver(false)
        loadFile(e.dataTransfer.files[0])
      },
      paste: (e) => {
        const text = e.clipboardData?.getData('text/plain') ?? ''
        if (text.includes('<svg')) loadText(text, 'pasted.svg')
      },
    }
    for (const [type, handler] of Object.entries(handlers)) window.addEventListener(type, handler)
    return () => {
      for (const [type, handler] of Object.entries(handlers)) window.removeEventListener(type, handler)
    }
  }, [loadFile, loadText])

  const rotate = (axis, degrees) => {
    if (axis === 'y') setAutoRotate(false)
    setRotation((r) => ({ ...r, [axis]: degrees }))
    stageRef.current?.setRotation(axis, degrees)
  }

  const resetView = () => {
    setAutoRotate(false)
    stageRef.current?.resetView()
  }

  const exportSvg = () => {
    const markup = stageRef.current?.exportSvg(style)
    if (!markup) {
      showToast('Nothing to export.')
      return
    }
    const fileName = `${current.name.replace(/\.svg$/i, '')}${EXPORT_STYLES[style].suffix}.svg`
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    showToast(`Exported ${fileName}`)
  }

  const updateShape = (key) => (value) => setShape((s) => ({ ...s, [key]: value }))
  const layers = current?.data.layers ?? []
  const layerCount = layers.length
  const hasLines = layers.some((layer) => layer.ribbon)
  const onlyLines = layerCount > 0 && layers.every((layer) => layer.ribbon)
  const hasCrossings = layers.some((layer) => layer.ribbon)
  const updating = !loading && current && current.weight !== weight

  // A drawing made only of lines has just a thin front edge; the text goes on the wide walls.
  const textSide = onlyLines && (text.side === 'front' || text.side === 'back') ? 'right' : text.side
  const shownText = useMemo(() => ({ ...text, side: textSide }), [text, textSide])

  return (
    <main className="app">
      <Stage
        ref={stageRef}
        svg={current?.data ?? null}
        shape={shape}
        look={look}
        text={shownText}
        display={style}
        autoRotate={autoRotate}
        onRotate={setRotation}
        onBuilt={onBuilt}
      >
        {current && (
          <div className="badge">
            {current.name} · {layerCount} {layerCount === 1 ? 'layer' : 'layers'}
            {updating && ' · Updating…'}
          </div>
        )}
        <div className="hint">Drag to rotate · Scroll to zoom</div>
        <div className={`drop-overlay${dragOver ? ' visible' : ''}`} aria-hidden="true">
          <div>Drop your SVG to load it</div>
        </div>
        <div className={`loading-overlay${loading ? ' visible' : ''}`} role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <div className="loading-label">{loading && `Loading ${loading.name}…`}</div>
        </div>
      </Stage>

      <aside className="panel">
        <header className="panel-head">
          <h1>SVG to 3D</h1>
          <p>Upload a flat SVG, then rotate it in space.</p>
        </header>

        <label className="upload">
          <input
            type="file"
            accept=".svg,image/svg+xml"
            onChange={(e) => {
              loadFile(e.target.files[0])
              e.target.value = ''
            }}
          />
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 16V4m0 0-5 5m5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Upload SVG</span>
        </label>
        <p className="muted small upload-note">You can also drop a file onto the preview or paste SVG code.</p>
        <div className="export-row">
          <select
            aria-label="Style"
            title="How the object is shown and exported. Shaded: filled shapes. Edges: a line drawing of what you see. Wireframe: all edges, including hidden ones."
            value={style}
            onChange={(e) => setStyle(e.target.value)}
          >
            {Object.entries(EXPORT_STYLES).map(([key, { label }]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-export"
            title="Saves the current view (rotation and zoom) as a vector SVG"
            onClick={exportSvg}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4v12m0 0-5-5m5 5 5-5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Export SVG
          </button>
        </div>

        <section className="group">
          <h2>Rotation</h2>
          <RangeControl id="rotX" label="X axis" value={rotation.x} unit="°" min={-180} max={180} onChange={(v) => rotate('x', v)} />
          <RangeControl id="rotY" label="Y axis" value={rotation.y} unit="°" min={-180} max={180} onChange={(v) => rotate('y', v)} />
          <div className="row-actions">
            <label className="check">
              <input type="checkbox" checked={autoRotate} onChange={(e) => setAutoRotate(e.target.checked)} /> Auto-rotate
            </label>
            <button type="button" className="btn" onClick={resetView}>Reset to front</button>
          </div>
        </section>

        <section className="group">
          <h2>Shape</h2>
          <RangeControl
            id="weight"
            label="Line weight"
            title="Makes lines and shapes thicker or thinner, like changing a stroke width"
            value={weight}
            unit="%"
            min={25}
            max={500}
            step={5}
            onChange={setWeight}
          />
          <RangeControl id="depth" label="Depth" value={shape.depth} unit="%" min={0} max={40} step={0.5} onChange={updateShape('depth')} />
          <RangeControl
            id="gap"
            label="Gap at crossings"
            title={hasCrossings
              ? 'Space between a line and the part of it that it passes over'
              : 'This SVG has no lines that cross over themselves'}
            value={shape.gap}
            unit="%"
            min={0}
            max={20}
            step={0.5}
            disabled={!hasCrossings}
            onChange={updateShape('gap')}
          />
          <label
            className="check"
            title={hasCrossings
              ? 'A line that loops over itself passes over its earlier part; this makes it pass under instead'
              : 'This SVG has no lines that cross over themselves'}
          >
            <input
              type="checkbox"
              checked={shape.flip}
              disabled={!hasCrossings}
              onChange={(e) => updateShape('flip')(e.target.checked)}
            /> Flip which part of a loop goes on top
          </label>
        </section>

        <section className="group">
          <h2>Look</h2>
          <div className="control">
            <div className="control-row"><label htmlFor="finish">Finish</label></div>
            <select id="finish" value={look.finish} onChange={(e) => setLook({ ...look, finish: e.target.value })}>
              {Object.entries(FINISHES).map(([key, finish]) => (
                <option key={key} value={key}>{finish.label}</option>
              ))}
            </select>
          </div>
          <div className="row-actions">
            <label className="check">
              <input type="checkbox" checked={look.useSvgColors} onChange={(e) => setLook({ ...look, useSvgColors: e.target.checked })} /> Use SVG colors
            </label>
            <input
              type="color"
              aria-label="Custom color"
              value={look.color}
              disabled={look.useSvgColors}
              onChange={(e) => setLook({ ...look, color: e.target.value })}
            />
          </div>
        </section>

        <section className="group">
          <h2>Text</h2>
          <div className="control">
            <textarea
              aria-label="Text"
              placeholder="Type any text. It is fitted to the shape."
              rows={3}
              value={text.value}
              onChange={(e) => setText({ ...text, value: e.target.value })}
            />
          </div>
          <div className="row-actions">
            <select
              aria-label="Side"
              value={textSide}
              onChange={(e) => setText({ ...text, side: e.target.value })}
            >
              {!onlyLines && <option value="front">Front side</option>}
              {!onlyLines && <option value="back">Back side</option>}
              {hasLines && <option value="left">Wide side of line, left</option>}
              {hasLines && <option value="right">Wide side of line, right</option>}
              {hasLines && <option value="both">Wide side of line, both</option>}
            </select>
            <input
              type="color"
              aria-label="Text color"
              value={text.color}
              onChange={(e) => setText({ ...text, color: e.target.value })}
            />
          </div>
          <div className="row-actions">
            <select
              aria-label="Font style"
              value={text.weight}
              onChange={(e) => setText({ ...text, weight: Number(e.target.value) })}
            >
              {Object.entries(TEXT_WEIGHTS).map(([weight, label]) => (
                <option key={weight} value={weight}>{label}</option>
              ))}
            </select>
            <label className="check">
              <input type="checkbox" checked={text.italic} onChange={(e) => setText({ ...text, italic: e.target.checked })} /> Italic
            </label>
          </div>
          <RangeControl id="textSize" label="Font size" value={text.size} unit="%" min={25} max={200} step={5} onChange={(size) => setText({ ...text, size })} />
          <RangeControl id="textSpacing" label="Letter spacing" value={text.spacing} unit="%" min={-10} max={60} step={1} onChange={(spacing) => setText({ ...text, spacing })} />
        </section>
      </aside>

      <div className={`toast${toast.visible ? ' show' : ''}`} role="status" aria-live="polite">{toast.message}</div>
    </main>
  )
}

export default App
