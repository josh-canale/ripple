# Ripple

An interactive dot-field that responds to your cursor, clicks, and text. Each click fires an expanding ring of displaced dots; double-click to loop it. Export the result as a live GLSL shader.

**[ripple-sandbox.vercel.app](https://ripple-sandbox.vercel.app)**

---

## Interactions

| Action | Effect |
|---|---|
| Move cursor | Subtle local lift under the pointer |
| Click | One-shot expanding ripple ring |
| Double-click / double-tap | Looping (pinned) ripple at that point |
| Eraser button | Sweep ring clears the field |
| Type button → enter text | Text rasterized into dot heights, fades in as ripple |
| Shape buttons (○ □ ◇) | Switch ring distance metric for subsequent ripples |
| Weight / Speed sliders | Adjust amplitude and propagation speed |
| Download button | Export current state as a standalone GLSL shader |

---

## How it works

### Rendering

The field is a single Three.js [`InstancedMesh`](https://threejs.org/docs/#api/en/objects/InstancedMesh) — one draw call regardless of dot count. Each frame, the CPU walks every dot, computes its height scalar `h`, then writes:

- a `Matrix4` (translation + uniform scale derived from `h`)
- a `Color` (linearly interpolated between a dark base and a bright peak by `h`)

into the instance buffers, then marks `instanceMatrix.needsUpdate = true`. The camera is an `OrthographicCamera` positioned at `(0, 40, 11)` looking at the origin, giving a mild top-down perspective tilt.

Grid size adapts to `navigator.hardwareConcurrency` at startup:

| CPU cores | Grid | Dot count |
|---|---|---|
| ≤ 2 | 70 × 50 | 3 500 |
| ≤ 4 | 100 × 72 | 7 200 |
| > 4 | 140 × 100 | 14 000 |

### Height field physics

For every dot at world position `(bx, bz)`, height `h` is the sum of four contributions:

**1. Ambient noise** — a very-low-amplitude `sin` wave drifting over the grid, giving the field a faint breathing quality at rest.

**2. Cursor lift** — a smooth Gaussian bump centered on the lerp-smoothed cursor position (`CURSOR_LERP = 0.08`), radius-squared gated to avoid computing for far dots.

**3. Ripple rings** — for each active ripple, the ring front advances as `front = ringAge * speed`. Dot height contribution:

```
h += amp * ramp * exp(-((d - front)² / RING_SIGMA_SQ))
```

where `d` is the shape-aware distance from the dot to the ripple origin, `ramp = 1 - exp(-ringAge * RING_RAMP)` provides a soft attack on spawn, and `RING_SIGMA_SQ = 1.8` controls ring width. Pinned (looping) ripples use `mod(ringAge, PINNED_PERIOD)` and sample `k ∈ {-1 … 4}` period offsets so rings are always visible at the edges of the field.

Distance metrics per shape:
- **Circle** — Euclidean `√(rx² + rz²)`
- **Square** — Chebyshev `max(|rx|, |rz|)`
- **Diamond** — Manhattan `|rx| + |rz|`

**4. Text layer** — `alpha * letterH[i]`, where `letterH` is a `Float32Array` sampled from an offscreen canvas render of the input text (see below). Alpha follows a `fadein → hold → fadeout → done` state machine.

### Text rasterizer

`rasterizeText()` renders the input string in italic bold Georgia onto a 900 × 320 offscreen canvas, auto-sizes the font to fill ~85% of the canvas width, then samples the red channel of each pixel (5 × 5 box filter) at the world position of every dot. The result is a `Float32Array` of per-dot brightness values `[0, 1]` used directly as height contribution weights.

### Clear ring

The eraser fires a dedicated ring at `CLEAR_SPEED = 10` (faster than the normal `RING_SPEED = 7`). Every dot *behind* the sweep front (`d < clearFront`) is gated out of all ripple and text height accumulation (`insideClear` flag), so the field appears cleanly zeroed in the ring's wake. When the front travels past the grid diagonal, all ripples and text layers are dropped and the ring deactivates.

### Shader export

The Download button calls `generateShader()`, which bakes the current ripple list into a self-contained GLSL fragment shader. Each ripple is encoded as a `vec4(worldX, worldZ, timeOffset, code)` where `code = shape + isPinned * 3`. The shader replicates the exact same Gaussian ring physics in GLSL and runs live in [Shadertoy](https://shadertoy.com) — paste the exported file into the Image shader with no extra buffers.

---

## Stack

| | |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Rendering | Three.js `InstancedMesh` + `OrthographicCamera` |
| UI | Tailwind CSS v4, Lucide React icons |
| Language | TypeScript (strict) |
| Deployment | Vercel |

No UI component library, no state management library, no animation library. The entire interactive canvas is a single component: `components/canvas/DotGrid.tsx`.

---

## Project structure

```
app/
  layout.tsx          # root layout, metadata, Geist font
  page.tsx            # dynamic import of DotGrid (SSR disabled)
  globals.css         # Tailwind base + CSS custom properties
components/
  canvas/
    DotGrid.tsx       # everything — rendering, physics, controls, export
```

All rendering, physics simulation, input handling, text rasterization, shader generation, and UI live in `DotGrid.tsx`. It is intentionally a single-file component — the logic is tightly coupled and splitting it would add indirection without benefit.

---

## Running locally

```bash
git clone https://github.com/josh-canale/ripple.git
cd ripple
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

No environment variables are required to run the project locally. The `.env.local` file (git-ignored) is only needed for Vercel CLI deploys.

---

## License

MIT
