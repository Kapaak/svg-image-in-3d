# SVG to 3D

Upload a flat SVG and rotate it in 3D. Every filled shape and stroke in the SVG is
extruded into a solid with depth, bevels and lighting, and the view can be exported as a
vector SVG.

Built with [Vite](https://vite.dev), React and [three.js](https://threejs.org).

## Run

Requires Node.js and Yarn (the project pins Yarn 4 via `packageManager`).

```sh
yarn          # install dependencies
yarn dev      # start the dev server at http://localhost:5173
```

Other scripts:

```sh
yarn build    # production build into dist/
yarn preview  # serve the production build locally
yarn lint     # run oxlint
```

## Use

- **Upload SVG**, drop a file onto the preview, or paste SVG code.
- **Style** (next to *Export SVG*) switches both the preview and the export between
  *Shaded*, *Edges (visible)* (a white object with its visible edges drawn) and
  *Wireframe (see-through)* (all edges, no fill).
- **Export SVG** saves the current view (rotation and zoom) as a vector image in that
  style. See below.
- **Rotation**: use the X / Y sliders, or drag on the preview. Scroll to zoom.
  *Auto-rotate* spins the object around Y, and *Reset to front* returns it to 0° / 0°.
- **Shape**
  - *Line weight* (25–500%): makes lines thicker or thinner, like changing a stroke width
    (100% = as drawn). Strokes scale their width. Filled shapes grow or shrink their outline
    by the same share of their own thickness, but at most as much as a typical line in the
    drawing, so a line drawn as a filled outline scales exactly while large areas
    (backgrounds) don't balloon.
  - *Depth*: thickness, as a percentage of the SVG's longest side, of anything that isn't
    drawn on top of something else.
  - *Gap at crossings*: the space between a line and the part of it that it passes over,
    as a percentage of the SVG's longest side (0% = resting on it). Greyed out when the
    SVG has no lines that cross themselves.
  - *Flip which part of a loop goes on top*: see below.

## How layering works

SVG has no depth, only paint order: later elements are drawn over earlier ones. The app
turns that into height, like stacking paper cut-outs:

- Each fill and each stroke is a layer, in paint order.
- A layer that overlaps nothing drawn before it is *Depth* tall.
- A layer drawn over earlier layers sits above the highest of them: 1.5% of the SVG's
  size higher for fills, 0.5% for lines (`LAYER_STEP` and `LINE_LIFT` in
  `src/scene/SvgScene.js`). Where one outline crosses another, the later line passes over
  the earlier one instead of merging with it.
- Filled shapes get a small rounded edge (`BEVEL`), kept inside their outline.
- Shapes that only touch along an edge are not stacked.
- Filled shapes are solid down to the back. Lines are ridges sitting on the surface they
  are drawn on, so the sides of the object show the shapes' colours, not walls of ink.

Overlaps are found by rasterising each layer's footprint onto a grid (`src/scene/stacking.js`).

### Lines that loop over themselves

A single line can cross itself, like the loop of a handwritten 6. Paint order says nothing
about which part is on top there, so such a line is rebuilt as a 3D ribbon that follows
it from start to end (`src/scene/ribbon.js`). The line only ever climbs along its drawing
order: between leaving the part it will later cross and reaching the crossing, it rises in
one long eased ramp to clear it by the *Gap at crossings* and then stays at that height.
So the loop passes over the line instead of merging into it, and the end of the line can
sit higher than its start.

This works for SVG strokes and for filled shapes that are outlined strokes (for example
Illustrator's *Object → Path → Outline Stroke*). For an outline, the two sides of the line
are matched up to recover the line itself, and the line is assumed to start where
the path starts. If the wrong part ends up on top, tick *Flip which part of a loop goes on top*.

Lines that only touch themselves without crossing stay flat. Filled shapes whose outline
crosses itself are first resolved with the SVG fill rule (`src/scene/clean.js`, using
clipper-lib), the same way a browser fills them.
- **Look**: choose the finish (matte, satin, glossy, metal), and either keep the SVG's own colors or use one custom color.

## SVG export

*Export SVG* turns what you see into a flat vector image (`src/scene/exportSvg.js`),
cropped to the object, on a transparent background. Pick the style next to the button:

- **Shaded** (`<name>-3d.svg`): every visible flat face of the 3D model becomes one filled
  shape; curved surfaces are made of narrow bands, one per slightly different direction.
  Colours come from a render of the scene, so they match the preview, but each face gets
  one even colour, and the object's own shadows are left out. Each shape has a thin outline
  in its own colour, which hides hairline gaps between neighbouring shapes.
- **Edges (visible)** (`<name>-3d-edges.svg`): a black line drawing of what you see, with
  hidden lines removed.
- **Wireframe (see-through)** (`<name>-3d-wireframe.svg`): the same lines, including the
  ones at the back and inside.

The line drawings show the lines a designer would draw, not the triangle mesh: creases
where faces meet at an angle (sharper than 30°) or where a front face meets a side, open
edges, silhouettes where a curved surface turns away from the camera, and (edges only)
where one surface goes into another. Lines are joined into continuous paths.

All outlines and lines are written as smooth cubic Bézier curves rather than dense
polylines (`src/scene/fitCurves.js`): sharp corners are found and kept sharp, and the
stretches between them are fitted with Philip Schneider's curve-fitting algorithm. Every
curve passes within 0.25 px of the original points and is checked along its length to stay
within 0.5 px of the outline (it is split, or becomes a straight line, if it would bulge).
That gives far fewer points and smooth, easily editable curves.

In the preview, the line styles show the same kinds of lines (`src/scene/edgeLines.js`):
creases and open edges always, and silhouettes of curved surfaces worked out on the GPU
every frame as the object turns. Lines where one surface goes into another only appear in
the exported file.

How it works: an ID render (every triangle in its own colour) tells which triangles are
visible. Each visible triangle is then cut down to exactly its visible part with
clipper-lib, comparing depths only where two triangles overlap on screen. The shaded style
merges those parts per face; the edge style reads its lines off their outlines.

## Notes

- `<text>` is ignored. Convert text to outlines/paths in your editor first.
- Gradients are rendered as one solid color, the average of their stops.
- Raster images embedded in the SVG are ignored.

## Project layout

```
src/
  App.jsx                  page layout and UI state
  components/Stage.jsx     mounts the 3D scene and passes UI state to it
  components/RangeControl.jsx
  scene/SvgScene.js        three.js scene, lights, extrusion build, drag/zoom, render loop
  scene/svg.js             SVG parsing (fills, strokes, colors) and layer geometry
  scene/stacking.js        overlap detection and per-layer heights
  scene/ribbon.js          self-crossing lines rebuilt as ribbons that pass over themselves
  scene/clean.js           resolves self-intersecting fill outlines (clipper-lib)
  scene/exportSvg.js       exports the current view as a vector SVG
  scene/fitCurves.js       fits smooth Bézier curves through the exported outlines
  scene/edgeLines.js       edge lines for the Edges / Wireframe preview
  assets/sample.svg        the SVG shown on first load
```
