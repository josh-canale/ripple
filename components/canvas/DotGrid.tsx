'use client'

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import {
  Undo2, Redo2, Eraser,
  SlidersHorizontal, X,
  Circle, Square, Diamond,
  Download, Type,
  Waves, Gauge,
} from 'lucide-react'

// ─── Device-adaptive grid ─────────────────────────────────────────────────────
function getGridDims() {
  const cores = navigator.hardwareConcurrency ?? 4
  if (cores <= 2) return { cols: 70,  rows: 50  }
  if (cores <= 4) return { cols: 100, rows: 72  }
  return              { cols: 140, rows: 100 }
}
const { cols: COLS, rows: ROWS } = getGridDims()
const DOT_COUNT      = COLS * ROWS
const SPACING        = 0.4
const MAX_RISE       = 3.8
const DOT_BASE_SCALE = 0.072
const AMBIENT_AMP    = 0.006
const FRUSTUM_H      = 28

// ─── Colors ───────────────────────────────────────────────────────────────────
const BASE_R = 0.03, BASE_G = 0.03, BASE_B = 0.055
const PEAK_R = 0.72, PEAK_G = 0.78, PEAK_B = 1.00

// ─── Cursor ───────────────────────────────────────────────────────────────────
const CURSOR_LERP = 0.08
const CURSOR_AMP  = 0.28
const CURSOR_R_SQ = 8

// ─── Pinned ripple ────────────────────────────────────────────────────────────
const PINNED_PERIOD = 1.8
const MAX_PINNED    = 8

// ─── Ripple shared ────────────────────────────────────────────────────────────
const RING_SPEED      = 7.0
const RING_SIGMA_SQ   = 1.8
const RING_AMP        = 0.60
const RING_TRAVEL_MAX = 70
const RING_RAMP       = 10
const CLEAR_SPEED     = 10   // fixed erase-ring speed (faster than RING_SPEED=7)

// ─── Click disambiguation ─────────────────────────────────────────────────────
const CLICK_DELAY = 160

// ─── Shape ────────────────────────────────────────────────────────────────────
type Shape = 'circle' | 'square' | 'diamond'

function rippleDist(rx: number, rz: number, shape: Shape): number {
  if (shape === 'square')  return Math.max(Math.abs(rx), Math.abs(rz))
  if (shape === 'diamond') return Math.abs(rx) + Math.abs(rz)
  return Math.sqrt(rx * rx + rz * rz)
}

interface Ripple {
  id: number; x: number; z: number
  pinned: boolean; born: number; shape: Shape
}
interface Settings  { amp: number; speed: number }
interface TextLayer {
  alpha: number
  phase: 'fadein' | 'hold' | 'fadeout' | 'done'
  phaseStart: number; heights: Float32Array
}

// ─── Shader export ────────────────────────────────────────────────────────────
// Ripple vec4 encoding: (worldX, worldZ, timeOffset, code)
// code = shape + isPinned * 3  →  0–2 transient, 3–5 pinned
// shapes: 0=circle, 1=square, 2=diamond
const SHADER_TEMPLATE = `/*
 * Ripple Field — generated fragment shader
 * ─────────────────────────────────────────
 * Paste the entire contents of this file into shadertoy.com/new
 * as the "Image" shader (no extra buffers needed).
 *
 * Amplitude : {{AMP}}
 * Speed     : {{SPEED}}
 * Grid      : {{COLS}} × {{ROWS}} dots
 * Exported  : {{DATE}}
 */

// ── Grid ─────────────────────────────────────────────────────────────────────
#define COLS        {{COLS}}.0
#define ROWS        {{ROWS}}.0
#define SPACING     0.4
#define MAX_RISE    3.8
#define DOT_R       0.072
#define FRUSTUM_H   28.0

// ── Camera axes (position 0,40,11 → lookAt origin) ───────────────────────────
//   right = (1, 0, 0)
//   up    = (0, 0.2653, -0.9641)
#define CAM_UP_Y    0.2653
#define CAM_UP_Z   -0.9641

// ── Colors ───────────────────────────────────────────────────────────────────
#define BASE_COL    vec3(0.030, 0.030, 0.055)
#define PEAK_COL    vec3(0.720, 0.780, 1.000)
#define BG_COL      vec3(0.031, 0.031, 0.055)

// ── Ripple physics ────────────────────────────────────────────────────────────
#define RING_SIGMA_SQ   1.8
#define RING_TRAVEL     70.0
#define RING_RAMP       10.0
#define PINNED_PERIOD   1.8
#define AMBIENT_AMP     0.006
#define RING_AMP        (0.60 * {{AMP}})
#define RING_SPEED      (7.0  * {{SPEED}})

// ── Baked ripple sources ──────────────────────────────────────────────────────
// vec4(worldX, worldZ, timeOffset, code)
// code 0–2 = one-shot (circle/square/diamond)
// code 3–5 = looping  (circle/square/diamond)
// timeOffset: negative = already born that many seconds before export
#define NUM_RIPPLES {{NUM_RIPPLES}}
vec4 rippleData[NUM_RIPPLES] = vec4[NUM_RIPPLES](
{{RIPPLE_LINES}}
);

// ── Distance metric per shape ─────────────────────────────────────────────────
float shapeDist(vec2 d, int shape) {
    if (shape == 1) return max(abs(d.x), abs(d.y));   // square (Chebyshev)
    if (shape == 2) return abs(d.x) + abs(d.y);        // diamond (Manhattan)
    return length(d);                                    // circle (Euclidean)
}

// ── Height field at world position pos at time t ──────────────────────────────
float computeH(vec2 pos, float t) {
    float h = 0.0;

    for (int i = 0; i < NUM_RIPPLES; i++) {
        float rx   = rippleData[i].x;
        float rz   = rippleData[i].y;
        float tOff = rippleData[i].z;
        float code = rippleData[i].w;

        // Decode: shape is code mod 3, pinned when code >= 2.5
        int  shape  = int(mod(code, 3.0));
        bool pinned = code > 2.5;

        float d = shapeDist(pos - vec2(rx, rz), shape);

        if (pinned) {
            // Looping source: compute rings for the current period window
            // and its immediate neighbours so no ring ever disappears.
            float age    = t - tOff;
            float modAge = mod(age, PINNED_PERIOD);

            for (int k = -1; k <= 4; k++) {
                float ringAge = modAge + float(k) * PINNED_PERIOD;
                if (ringAge <= 0.0) continue;
                float front = ringAge * RING_SPEED;
                if (front <= 0.0 || front > RING_TRAVEL) continue;
                float ramp = min(1.0, 1.0 - exp(-ringAge * RING_RAMP));
                h += RING_AMP * ramp * exp(-pow(d - front, 2.0) / RING_SIGMA_SQ);
            }
        } else {
            // One-shot ripple
            float ringAge = t - tOff;
            if (ringAge <= 0.0) continue;
            float front = ringAge * RING_SPEED;
            if (front > RING_TRAVEL) continue;
            float ramp = 1.0 - exp(-ringAge * RING_RAMP);
            h += RING_AMP * ramp * exp(-pow(d - front, 2.0) / RING_SIGMA_SQ);
        }
    }
    return h;
}

// ── Main image ────────────────────────────────────────────────────────────────
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    float aspect = iResolution.x / iResolution.y;
    float halfH  = FRUSTUM_H * 0.5;
    float halfW  = halfH * aspect;

    // NDC: x in [-aspect, aspect], y in [-1, 1]
    vec2 ndc = (fragCoord - 0.5 * iResolution.xy) / (0.5 * iResolution.y);

    // Approximate world XZ on ground plane (worldY = 0):
    //   ndcX = worldX / halfW
    //   ndcY = worldZ * CAM_UP_Z / halfH  (since worldY = 0, camRight.z = 0)
    float gx = ndc.x * halfW;
    float gz = ndc.y * halfH / CAM_UP_Z;   // CAM_UP_Z < 0

    float halfGridW = (COLS - 1.0) * SPACING * 0.5;
    float halfGridD = (ROWS - 1.0) * SPACING * 0.5;

    int ci0 = int((gx + halfGridW) / SPACING);
    int ri0 = int((gz + halfGridD) / SPACING);

    float t = iTime;

    vec3  color   = BG_COL;
    float bestDst = 1e6;  // closest dot center in NDC space (wins overlaps)

    // Search neighbourhood: ±2 cols, -1..+4 rows.
    // The +4 offset in row covers dots that rise up to ~1 world unit above
    // their ground position and shift into this fragment's screen area.
    for (int dr = -1; dr <= 4; dr++) {
    for (int dc = -2; dc <= 2; dc++) {
        int ci = ci0 + dc;
        int ri = ri0 + dr;
        if (ci < 0 || ci >= int(COLS) || ri < 0 || ri >= int(ROWS)) continue;

        float dotX = float(ci) * SPACING - halfGridW;
        float dotZ = float(ri) * SPACING - halfGridD;

        // Height at this dot
        float hRip = computeH(vec2(dotX, dotZ), t);
        float hAmb = AMBIENT_AMP * sin(dotX * 0.45 + dotZ * 0.32 + t * 0.45);
        float h    = max(0.0, hRip) + max(0.0, hAmb);

        // Raised world Y, then project to NDC via camera up vector
        float wy     = h * MAX_RISE;
        float dotNdcX = dotX / halfW;
        float dotNdcY = (wy * CAM_UP_Y + dotZ * CAM_UP_Z) / halfH;

        // Dot radius in NDC (sphere radius / frustum half-height, scaled by h)
        float scale  = 1.0 + h * 0.9;
        float dotNdcR = DOT_R * scale / halfH;

        float dst = length(ndc - vec2(dotNdcX, dotNdcY));
        if (dst < dotNdcR && dst < bestDst) {
            bestDst = dst;
            color   = mix(BASE_COL, PEAK_COL, clamp(h, 0.0, 1.0));
        }
    }}

    fragColor = vec4(color, 1.0);
}
`

function generateShader(ripples: Ripple[], settings: Settings, currentTime: number): string {
  const shapeCode: Record<Shape, number> = { circle: 0, square: 1, diamond: 2 }

  // Include every ripple; if none exist use a dummy out-of-bounds entry.
  const src: Ripple[] = ripples.length > 0
    ? ripples
    : [{ id: -1, x: 999, z: 999, pinned: false, born: currentTime - 99999, shape: 'circle' }]

  const rippleLines = src.map(r => {
    const tOff = +(r.born - currentTime).toFixed(4)           // negative = already born
    const code = shapeCode[r.shape] + (r.pinned ? 3 : 0)     // 0–5
    return `    vec4(${r.x.toFixed(4)}, ${r.z.toFixed(4)}, ${tOff}, ${code}.0)`
  }).join(',\n')

  return SHADER_TEMPLATE
    .replaceAll('{{NUM_RIPPLES}}', String(src.length))
    .replaceAll('{{RIPPLE_LINES}}', rippleLines)
    .replaceAll('{{AMP}}',   settings.amp.toFixed(3))
    .replaceAll('{{SPEED}}', settings.speed.toFixed(3))
    .replaceAll('{{COLS}}',  String(COLS))
    .replaceAll('{{ROWS}}',  String(ROWS))
    .replaceAll('{{DATE}}',  new Date().toISOString().slice(0, 16).replace('T', ' '))
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain' })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Text rasterizer ─────────────────────────────────────────────────────────
// Renders arbitrary text in italic onto an offscreen canvas, auto-sizes the
// font to fill the canvas, then samples per-dot brightness into a Float32Array.
function rasterizeText(
  text: string, worldX: number, worldZ: number,
  baseX: Float32Array, baseZ: Float32Array, dotCount: number
): Float32Array {
  const CW = 900, CH = 320
  const canvas = document.createElement('canvas')
  canvas.width = CW; canvas.height = CH
  const ctx = canvas.getContext('2d')!

  // Measure at max size then scale font to fill ~85% of canvas width
  const MAX_SIZE = 240
  ctx.font = `italic bold ${MAX_SIZE}px Georgia, "Palatino Linotype", serif`
  const mw = ctx.measureText(text).width
  const fontSize = Math.min(MAX_SIZE, Math.max(60, Math.round(MAX_SIZE * (CW * 0.85) / mw)))

  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, CW, CH)
  ctx.fillStyle = '#fff'
  ctx.font = `italic bold ${fontSize}px Georgia, "Palatino Linotype", serif`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(text, CW / 2, CH / 2)
  const { data } = ctx.getImageData(0, 0, CW, CH)

  // World region scales with text length; capped so it stays within any grid
  const HX = Math.min(13, Math.max(10, text.length * 1.3 + 5))
  const HZ = 4
  const out = new Float32Array(dotCount)
  for (let i = 0; i < dotCount; i++) {
    const cx = ((baseX[i] - worldX) / HX + 1) * 0.5 * CW
    const cz = ((baseZ[i] - worldZ) / HZ + 1) * 0.5 * CH
    let sum = 0, count = 0
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = Math.round(cx) + dx, nz = Math.round(cz) + dy
      if (nx >= 0 && nx < CW && nz >= 0 && nz < CH) {
        sum += data[(nz * CW + nx) * 4]; count++
      }
    }
    out[i] = count > 0 ? Math.min(1, (sum / count / 255) * 1.5) : 0
  }
  return out
}

// ─── Small icon button ────────────────────────────────────────────────────────
function Btn({
  onClick, disabled = false, active = false, semiActive = false, title, children,
}: {
  onClick: () => void; disabled?: boolean
  active?: boolean; semiActive?: boolean; title?: string; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      className={`w-9 h-9 sm:w-7 sm:h-7 flex items-center justify-center rounded-full
                  transition-all duration-150 cursor-pointer
                  disabled:opacity-20 disabled:cursor-not-allowed
                  ${active
                    ? 'bg-white/25 text-white'
                    : semiActive
                      ? 'bg-white/[0.10] text-white/65'
                      : 'text-white/65 hover:text-white hover:bg-white/10 active:bg-white/15'}`}
    >
      {children}
    </button>
  )
}

// ─── Horizontal range slider ──────────────────────────────────────────────────
const SLIDER_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bitcount+Grid+Single&display=swap');
  .hslider { -webkit-appearance: none; appearance: none;
             height: 16px; background: transparent; cursor: ew-resize; }
  .hslider::-webkit-slider-runnable-track {
    height: 2px; border-radius: 1px;
    background: linear-gradient(to right,
      rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.55) var(--pct,50%),
      rgba(255,255,255,0.15) var(--pct,50%), rgba(255,255,255,0.15) 100%); }
  .hslider::-webkit-slider-thumb {
    -webkit-appearance: none; width: 2px; height: 16px; border-radius: 1px;
    background: rgba(255,255,255,0.75); margin-top: -7px;
    transition: width .1s, height .1s, background .1s; }
  .hslider:active::-webkit-slider-thumb {
    width: 3px; height: 19px; margin-top: -8.5px;
    background: rgba(255,255,255,0.95); }
  .hslider::-moz-range-track {
    height: 2px; border-radius: 1px; background: rgba(255,255,255,0.15); }
  .hslider::-moz-range-progress {
    height: 2px; border-radius: 1px; background: rgba(255,255,255,0.55); }
  .hslider::-moz-range-thumb {
    width: 2px; height: 16px; border-radius: 1px; border: none;
    background: rgba(255,255,255,0.75);
    transition: width .1s, height .1s, background .1s; }
  .hslider:active::-moz-range-thumb {
    width: 3px; height: 19px; background: rgba(255,255,255,0.95); }
`

function HSlider({
  label, icon, value, min, max, step, onChange,
}: {
  label: string; icon: React.ReactNode
  value: number; min: number; max: number
  step: number; onChange: (v: number) => void
}) {
  const pct = `${((value - min) / (max - min)) * 100}%`
  return (
    <label title={label} className="flex items-center gap-2 select-none flex-1 sm:flex-none">
      <span className="text-white/50 shrink-0 flex items-center">{icon}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="hslider flex-1 sm:flex-none sm:w-20 min-w-0"
        style={{ '--pct': pct } as React.CSSProperties}
      />
    </label>
  )
}

export default function DotGrid() {
  const mountRef        = useRef<HTMLDivElement>(null)
  const clearFnRef      = useRef<(() => void) | null>(null)
  const undoFnRef       = useRef<(() => void) | null>(null)
  const redoFnRef       = useRef<(() => void) | null>(null)
  const exportFnRef     = useRef<(() => void) | null>(null)
  const placeTextFnRef  = useRef<((text: string) => void) | null>(null)
  const clearTextFnRef  = useRef<(() => void) | null>(null)
  const settingsRef     = useRef<Settings>({ amp: 1.0, speed: 1.0 })
  const shapeRef        = useRef<Shape>('circle')
  const textInputRef    = useRef<HTMLInputElement>(null)

  const [canUndo,           setCanUndo]           = useState(false)
  const [canRedo,           setCanRedo]           = useState(false)
  const [amp,               setAmp]               = useState(1.0)
  const [speed,             setSpeed]             = useState(1.0)
  const [shape,             setShape]             = useState<Shape>('circle')
  const [open,              setOpen]              = useState(true)
  const [showInstructions,  setShowInstructions]  = useState(false)
  const [showHelp,          setShowHelp]          = useState(false)
  const [textMode,          setTextMode]          = useState(false)
  const [textInput,         setTextInput]         = useState('')
  const [hasText,           setHasText]           = useState(false)
  const [showDownloadModal, setShowDownloadModal] = useState(false)

  useEffect(() => {
    const container = mountRef.current
    if (!container) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x08080e)

    const aspect = window.innerWidth / window.innerHeight
    const camera = new THREE.OrthographicCamera(
      -(FRUSTUM_H * aspect) / 2,  (FRUSTUM_H * aspect) / 2,
        FRUSTUM_H / 2,           -FRUSTUM_H / 2,
      0.1, 300
    )
    camera.position.set(0, 40, 11)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(renderer.domElement)
    renderer.domElement.style.cursor = 'default'

    const geo  = new THREE.SphereGeometry(DOT_BASE_SCALE, 6, 4)
    const mat  = new THREE.MeshBasicMaterial({ color: 0xffffff })
    const mesh = new THREE.InstancedMesh(geo, mat, DOT_COUNT)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.setColorAt(0, new THREE.Color(1, 1, 1))
    scene.add(mesh)
    const colorArr = mesh.instanceColor!.array as Float32Array

    const baseX = new Float32Array(DOT_COUNT)
    const baseZ = new Float32Array(DOT_COUNT)
    const halfW = ((COLS - 1) * SPACING) / 2
    const halfD = ((ROWS - 1) * SPACING) / 2
    for (let iz = 0; iz < ROWS; iz++) {
      for (let ix = 0; ix < COLS; ix++) {
        const i = iz * COLS + ix
        baseX[i] = ix * SPACING - halfW
        baseZ[i] = iz * SPACING - halfD
      }
    }

    // Distance from center at which the clear ring has exited the visible grid
    const gridDiagonal = Math.sqrt(halfW * halfW + halfD * halfD)
    const clearRing = { active: false, born: 0 }

    // ── Welcome sequence ──────────────────────────────────────────────────────
    const letterH = rasterizeText('hi', 0, 0, baseX, baseZ, DOT_COUNT)
    const welcome = {
      alpha:      0,
      phase:      'delay' as 'delay' | 'fadein' | 'hold' | 'fadeout' | 'done',
      phaseStart: 0,
      startedAt:  0,  // time at which the initial delay began (first load only)
    }

    const rawMouse    = { x: 0, z: 0 }
    const smoothMouse = { x: 0, z: 0 }
    const raycaster   = new THREE.Raycaster()
    const pointer     = new THREE.Vector2()
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const hitPoint    = new THREE.Vector3()

    const worldPos = (clientX: number, clientY: number) => {
      pointer.x =  (clientX / window.innerWidth)  * 2 - 1
      pointer.y = -(clientY / window.innerHeight) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      return raycaster.ray.intersectPlane(groundPlane, hitPoint)
        ? { x: hitPoint.x, z: hitPoint.z } : null
    }

    const onMouseMove = (e: MouseEvent) => {
      const p = worldPos(e.clientX, e.clientY)
      if (p) { rawMouse.x = p.x; rawMouse.z = p.z }
    }
    window.addEventListener('mousemove', onMouseMove)

    const ripples:   Ripple[] = []
    const history:   Ripple[] = []
    const redoStack: Ripple[] = []
    let nextId = 0
    let time   = 0

    // Seed ripple from center — not added to history so it can't be undone
    ripples.push({ id: nextId++, x: 0, z: 0, pinned: false, born: 0, shape: 'circle' })

    // ── User text layers ──────────────────────────────────────────────────────
    const textLayers: TextLayer[] = []

    // Defined before the ref closures that reference it
    const dismissWelcome = () => {
      if (welcome.phase !== 'done' && welcome.phase !== 'fadeout') {
        welcome.phase = 'fadeout'
        welcome.phaseStart = time
        setShowInstructions(false)
      }
    }

    clearTextFnRef.current = () => { textLayers.length = 0; setHasText(false) }

    placeTextFnRef.current = (text: string) => {
      dismissWelcome()
      textLayers.length = 0  // one text layer at a time
      const heights = rasterizeText(text, 0, 0, baseX, baseZ, DOT_COUNT)
      textLayers.push({ alpha: 0, phase: 'fadein', phaseStart: time, heights })
      setHasText(true)
      ripples.push({ id: nextId++, x: 0, z: 0, pinned: false, born: time, shape: 'circle' })
    }

    const addRipple = (x: number, z: number, pinned: boolean) => {
      dismissWelcome()
      if (pinned) {
        const pinnedIndices = ripples.reduce<number[]>(
          (a, r, i) => { if (r.pinned) a.push(i); return a }, []
        )
        if (pinnedIndices.length >= MAX_PINNED) {
          const evicted = ripples.splice(pinnedIndices[0], 1)[0]
          const hi = history.findIndex(r => r.id === evicted.id)
          if (hi !== -1) history.splice(hi, 1)
        }
      }
      const r: Ripple = { id: nextId++, x, z, pinned, born: time, shape: shapeRef.current }
      ripples.push(r); history.push(r); redoStack.length = 0
      setCanUndo(true); setCanRedo(false)
    }

    clearFnRef.current = () => {
      // Don't clear ripples immediately — the erase ring sweeps them away
      history.length = redoStack.length = 0
      setCanUndo(false); setCanRedo(false)
      setHasText(false); setTextMode(false)
      clearRing.active = true
      clearRing.born = time
    }

    undoFnRef.current = () => {
      if (!history.length) return
      const r = history.pop()!
      const i = ripples.findIndex(x => x.id === r.id)
      if (i !== -1) ripples.splice(i, 1)
      redoStack.push(r)
      setCanUndo(history.length > 0); setCanRedo(true)
    }

    redoFnRef.current = () => {
      if (!redoStack.length) return
      const old = redoStack.pop()!
      const fresh: Ripple = { ...old, born: time, id: nextId++ }
      ripples.push(fresh); history.push(fresh)
      setCanUndo(true); setCanRedo(redoStack.length > 0)
    }

    exportFnRef.current = () => {
      const glsl = generateShader([...ripples], settingsRef.current, time)
      downloadText('ripple.glsl', glsl)
    }

    let clickTimer: ReturnType<typeof setTimeout> | null = null

    const onClick = (e: MouseEvent) => {
      const p = worldPos(e.clientX, e.clientY); if (!p) return
      const { x, z } = p
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return }
      clickTimer = setTimeout(() => { clickTimer = null; addRipple(x, z, false) }, CLICK_DELAY)
    }

    const onDblClick = (e: MouseEvent) => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null }
      const p = worldPos(e.clientX, e.clientY)
      if (p) addRipple(p.x, p.z, true)
    }

    container.addEventListener('click',    onClick)
    container.addEventListener('dblclick', onDblClick)

    // ── Touch events (mobile) ─────────────────────────────────────────────────
    let lastTap       = 0
    let touchTapTimer: ReturnType<typeof setTimeout> | null = null

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      const p = worldPos(touch.clientX, touch.clientY)
      if (!p) return
      rawMouse.x = p.x; rawMouse.z = p.z
      const now = Date.now()
      if (now - lastTap < 300 && touchTapTimer) {
        // Double-tap → loop ripple
        clearTimeout(touchTapTimer); touchTapTimer = null
        addRipple(p.x, p.z, true)
      } else {
        const { x, z } = p
        touchTapTimer = setTimeout(() => { touchTapTimer = null; addRipple(x, z, false) }, CLICK_DELAY)
      }
      lastTap = now
    }

    const onTouchMove = (e: TouchEvent) => {
      // Track finger position for the cursor glow; cancel pending tap if moved
      if (e.touches.length === 1) {
        const touch = e.touches[0]
        const p = worldPos(touch.clientX, touch.clientY)
        if (p) { rawMouse.x = p.x; rawMouse.z = p.z }
      }
      if (touchTapTimer) { clearTimeout(touchTapTimer); touchTapTimer = null }
    }

    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove',  onTouchMove,  { passive: true })

    const dummy = new THREE.Object3D()
    let raf: number, lastTs = performance.now()

    const animate = (ts: number) => {
      raf = requestAnimationFrame(animate)
      const dt = Math.min((ts - lastTs) / 1000, 0.05)
      lastTs = ts; time += dt

      // ── Welcome phase state machine ─────────────────────────────────────────
      if (welcome.phase === 'delay' && time >= welcome.startedAt + 0.7) {
        welcome.phase = 'fadein'
        welcome.phaseStart = time
        setShowInstructions(true)
      }
      if (welcome.phase === 'fadein') {
        welcome.alpha = Math.min(1, (time - welcome.phaseStart) / 0.8)
        if (welcome.alpha >= 1) welcome.phase = 'hold'
      }
      if (welcome.phase === 'fadeout') {
        welcome.alpha = Math.max(0, 1 - (time - welcome.phaseStart) / 0.8)
        if (welcome.alpha <= 0) welcome.phase = 'done'
      }

      // ── Text layer phase updates ───────────────────────────────────────────
      for (const tl of textLayers) {
        if (tl.phase === 'fadein') {
          tl.alpha = Math.min(1, (time - tl.phaseStart) / 0.8)
          if (tl.alpha >= 1) tl.phase = 'hold'
        }
        if (tl.phase === 'fadeout') {
          tl.alpha = Math.max(0, 1 - (time - tl.phaseStart) / 0.8)
          if (tl.alpha <= 0) tl.phase = 'done'
        }
      }
      for (let i = textLayers.length - 1; i >= 0; i--) {
        if (textLayers[i].phase === 'done') textLayers.splice(i, 1)
      }

      const { amp: aM, speed: sM } = settingsRef.current
      const curAmp   = RING_AMP    * aM
      const curSpeed = RING_SPEED  * sM

      // ── Clear ring wipe ────────────────────────────────────────────────────
      // clearFront is the ring's current radius (fixed speed); -1 when inactive
      const clearFront = clearRing.active ? (time - clearRing.born) * CLEAR_SPEED : -1
      if (clearRing.active && clearFront > gridDiagonal + 2) {
        clearRing.active = false
        ripples.length = 0          // sweep complete — now drop all ripples
        textLayers.length = 0
      }

      for (let i = ripples.length - 1; i >= 0; i--) {
        if (!ripples[i].pinned && (time - ripples[i].born) * curSpeed > RING_TRAVEL_MAX)
          ripples.splice(i, 1)
      }

      smoothMouse.x += (rawMouse.x - smoothMouse.x) * CURSOR_LERP
      smoothMouse.z += (rawMouse.z - smoothMouse.z) * CURSOR_LERP

      for (let i = 0; i < DOT_COUNT; i++) {
        const bx = baseX[i], bz = baseZ[i]
        const dx = bx - smoothMouse.x, dz = bz - smoothMouse.z
        let h = CURSOR_AMP * Math.exp(-(dx * dx + dz * dz) / CURSOR_R_SQ)

        // Dots inside the cleared zone are suppressed — no ripple contributions
        const insideClear = clearFront >= 0 && (bx * bx + bz * bz) < clearFront * clearFront

        if (!insideClear) {
          for (const r of ripples) {
            const d = rippleDist(bx - r.x, bz - r.z, r.shape)
            if (r.pinned) {
              const age = time - r.born
              const n   = Math.floor(age / PINNED_PERIOD) + 1
              for (let k = n - 1; k >= 0; k--) {
                const ringAge = age - k * PINNED_PERIOD
                const front   = ringAge * curSpeed
                if (front > RING_TRAVEL_MAX) break
                const ramp = 1 - Math.exp(-ringAge * RING_RAMP)
                h += curAmp * ramp * Math.exp(-((d - front) ** 2) / RING_SIGMA_SQ)
              }
            } else {
              const ringAge = time - r.born
              const front   = ringAge * curSpeed
              const ramp    = 1 - Math.exp(-ringAge * RING_RAMP)
              h += curAmp * ramp * Math.exp(-((d - front) ** 2) / RING_SIGMA_SQ)
            }
          }
        }

        // Visual sweep wave at the erase ring's leading edge
        if (clearFront >= 0) {
          const d       = Math.sqrt(bx * bx + bz * bz)
          const ringAge = time - clearRing.born
          const ramp    = 1 - Math.exp(-ringAge * RING_RAMP)
          h += curAmp * ramp * Math.exp(-((d - clearFront) ** 2) / RING_SIGMA_SQ)
        }

        const ambient = AMBIENT_AMP * Math.sin(bx * 0.45 + bz * 0.32 + time * 0.45)
        const finalH  = Math.max(0, h) + Math.max(0, ambient)

        dummy.position.set(bx, finalH * MAX_RISE, bz)
        dummy.scale.setScalar(1 + finalH * 0.9)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)

        // Letter/text boosts are color-only (no height) — suppressed inside the cleared zone
        let letterBoost = 0
        if (!insideClear) {
          if (welcome.alpha > 0) letterBoost = welcome.alpha * letterH[i]
          for (const tl of textLayers) {
            if (tl.alpha > 0) letterBoost += tl.alpha * tl.heights[i]
          }
        }
        const colorH = Math.min(1, finalH + letterBoost)
        const ci = i * 3
        colorArr[ci]     = BASE_R + colorH * (PEAK_R - BASE_R)
        colorArr[ci + 1] = BASE_G + colorH * (PEAK_G - BASE_G)
        colorArr[ci + 2] = BASE_B + colorH * (PEAK_B - BASE_B)
      }

      mesh.instanceMatrix.needsUpdate = true
      mesh.instanceColor!.needsUpdate = true
      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(animate)

    const onResize = () => {
      const w = window.innerWidth, h = window.innerHeight, asp = w / h
      camera.left = -(FRUSTUM_H * asp) / 2; camera.right  =  (FRUSTUM_H * asp) / 2
      camera.top  =  FRUSTUM_H / 2;         camera.bottom = -FRUSTUM_H / 2
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)

      // Nullify all imperative bridge refs
      clearFnRef.current     = null
      undoFnRef.current      = null
      redoFnRef.current      = null
      exportFnRef.current    = null
      placeTextFnRef.current = null
      clearTextFnRef.current = null

      if (clickTimer)    clearTimeout(clickTimer)
      if (touchTapTimer) clearTimeout(touchTapTimer)

      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('resize',    onResize)
      container.removeEventListener('click',      onClick)
      container.removeEventListener('dblclick',   onDblClick)
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove',  onTouchMove)

      renderer.dispose(); geo.dispose(); mat.dispose()
      if (container.contains(renderer.domElement))
        container.removeChild(renderer.domElement)
    }
  }, [])

  const handleAmp   = (v: number) => { settingsRef.current.amp   = v; setAmp(v)   }
  const handleSpeed = (v: number) => { settingsRef.current.speed = v; setSpeed(v) }
  const handleShape = (s: Shape)  => { shapeRef.current = s; setShape(s); setTextMode(false) }

  const handlePlaceText = () => {
    const t = textInput.trim()
    if (!t) return
    placeTextFnRef.current?.(t)
  }

  const handleClearText = () => {
    clearTextFnRef.current?.()
    setTextInput('')
    setTextMode(false)
  }

  useEffect(() => {
    if (textMode) textInputRef.current?.focus()
  }, [textMode])

  return (
    <>
      <style>{SLIDER_CSS}</style>

      <div ref={mountRef} className="fixed inset-0 touch-none" />

      {/* ── Wordmark ───────────────────────────────────────────────────────── */}
      <div className="fixed top-6 left-6 z-10 select-none pointer-events-none
                      text-white text-[18px] leading-none"
           style={{ fontFamily: "'Bitcount Grid Single', monospace" }}>
        ripple
      </div>

      {/* ── Welcome instructions ──────────────────────────────────────────── */}
      {/* Positioned just below where "hi" appears on screen (~64% down). */}
      <div
        className="fixed left-1/2 -translate-x-1/2 z-[5] pointer-events-none select-none"
        style={{
          top: '63%',
          opacity: showInstructions ? 1 : 0,
          transition: 'opacity 1.5s ease',
        }}
      >
        <p className="text-[15px] tracking-[0.1em] font-normal whitespace-nowrap text-center leading-relaxed"
           style={{ fontFamily: "'Bitcount Grid Single', monospace", color: '#D9E0FE' }}>
          <span className="sm:hidden">tap to ripple</span>
          <span className="hidden sm:inline">click to ripple</span>
          <br />
          <span className="sm:hidden">double-tap to loop</span>
          <span className="hidden sm:inline">double-click to loop</span>
        </p>
      </div>

      {/* ── Bottom-centre UI ───────────────────────────────────────────────── */}
      <div className="fixed bottom-6 sm:bottom-10
                      left-2 right-2 sm:left-1/2 sm:right-auto sm:-translate-x-1/2
                      z-10 flex flex-col items-center gap-3">

        {/* Text input panel */}
        <div
          style={{
            opacity:       textMode ? 1 : 0,
            transform:     textMode ? 'translateY(0) scale(1)' : 'translateY(6px) scale(0.98)',
            maxHeight:     textMode ? 56 : 0,
            pointerEvents: textMode ? 'auto' : 'none',
            overflow:      'hidden',
            transition: [
              'opacity 0.18s ease',
              'transform 0.3s cubic-bezier(0.34,1.2,0.64,1)',
              'max-height 0.3s cubic-bezier(0.4,0,0.2,1)',
            ].join(', '),
          }}
        >
          <form
            onSubmit={e => { e.preventDefault(); handlePlaceText() }}
            className="flex items-center gap-2.5 px-4 py-2.5
                       rounded-2xl sm:rounded-full w-full sm:w-auto
                       bg-white/[0.04] border border-white/[0.08]
                       backdrop-blur-2xl shadow-xl shadow-black/20"
          >
            <input
              ref={textInputRef}
              type="text"
              value={textInput}
              onChange={e => setTextInput(e.target.value.slice(0, 10))}
              placeholder="type something…"
              autoComplete="off" autoCorrect="off" autoCapitalize="off"
              className="bg-transparent text-white/80 text-[12px] outline-none
                         placeholder-white/20 flex-1 sm:w-36 min-w-0 caret-white/40"
              style={{ fontFamily: "'Bitcount Grid Single', monospace" }}
            />
            <span className="text-white/40 text-[10px] tabular-nums shrink-0">
              {textInput.length}/10
            </span>
            <button
              type="submit"
              className="text-white/55 hover:text-white/80 transition-colors
                         duration-150 text-[13px] shrink-0 cursor-pointer leading-none"
            >
              ↵
            </button>
            <div className="w-px h-3 bg-white/15 shrink-0" />
            <button
              type="button"
              onClick={handleClearText}
              className="text-white/50 hover:text-white/75 transition-colors
                         duration-150 text-[10px] shrink-0 cursor-pointer tracking-wide"
            >
              clear
            </button>
          </form>
        </div>

        {/* Controls bar */}
        <div
          style={{
            opacity:       open ? 1 : 0,
            transform:     open ? 'translateY(0) scale(1)' : 'translateY(10px) scale(0.97)',
            maxHeight:     open ? 96 : 0,
            pointerEvents: open ? 'auto' : 'none',
            overflow:      'hidden',
            transition: [
              'opacity 0.22s ease',
              'transform 0.38s cubic-bezier(0.34,1.2,0.64,1)',
              'max-height 0.38s cubic-bezier(0.4,0,0.2,1)',
            ].join(', '),
          }}
        >
          <div className="flex flex-wrap sm:flex-nowrap items-center justify-center
                          w-full sm:w-auto
                          gap-x-1 gap-y-2 sm:gap-x-3
                          px-2 sm:px-5 py-2 sm:py-3
                          rounded-2xl sm:rounded-full
                          bg-white/[0.04] border border-white/[0.08]
                          backdrop-blur-2xl shadow-xl shadow-black/20">

            {/* Group 1 — shape selector + text tool
                Mobile: row 1 left  |  Desktop: order 1 */}
            <div className="flex items-center gap-1 sm:gap-3 sm:order-1">
              <Btn onClick={() => handleShape('circle')}  active={shape==='circle' && !textMode}  title="Circle">
                <Circle  size={13} strokeWidth={2} />
              </Btn>
              <Btn onClick={() => handleShape('square')}  active={shape==='square' && !textMode}  title="Square">
                <Square  size={12} strokeWidth={2} />
              </Btn>
              <Btn onClick={() => handleShape('diamond')} active={shape==='diamond' && !textMode} title="Diamond">
                <Diamond size={12} strokeWidth={2} />
              </Btn>
              <Btn onClick={() => setTextMode(t => !t)} active={textMode} semiActive={hasText && !textMode} title="Add text">
                <Type size={12} strokeWidth={2} />
              </Btn>
              {/* Separator: desktop single-row only */}
              <div className="hidden sm:block w-px h-5 bg-white/15 shrink-0" />
            </div>

            {/* Group 2 — history + export
                Mobile: row 1 right  |  Desktop: order 3 */}
            <div className="flex items-center gap-1 sm:gap-3 sm:order-3">
              <Btn onClick={() => undoFnRef.current?.()} disabled={!canUndo} title="Undo">
                <Undo2 size={14} strokeWidth={1.8} />
              </Btn>
              <Btn onClick={() => redoFnRef.current?.()} disabled={!canRedo} title="Redo">
                <Redo2 size={14} strokeWidth={1.8} />
              </Btn>
              <Btn onClick={() => clearFnRef.current?.()} title="Clear all ripples">
                <Eraser size={14} strokeWidth={1.8} />
              </Btn>
              <div className="w-px h-5 bg-white/15 shrink-0" />
              <Btn onClick={() => setShowDownloadModal(true)} title="Export as GLSL shader">
                <Download size={14} strokeWidth={1.8} />
              </Btn>
            </div>

            {/* Group 3 — sliders
                Mobile: row 2, full-width with flex-1 tracks  |  Desktop: order 2, inline */}
            <div className="w-full sm:w-auto flex items-center gap-3 sm:order-2 px-1 sm:px-0">
              <HSlider label="weight" icon={<Waves size={13} strokeWidth={1.8} />}
                       value={amp}   min={0.2} max={2}   step={0.05} onChange={handleAmp}   />
              <HSlider label="speed"  icon={<Gauge size={13} strokeWidth={1.8} />}
                       value={speed} min={0.3} max={2}   step={0.05} onChange={handleSpeed} />
              {/* Separator: desktop single-row only */}
              <div className="hidden sm:block w-px h-5 bg-white/15 shrink-0" />
            </div>

          </div>
        </div>

        {/* Toggle */}
        <button
          onClick={() => { setOpen(o => !o); setTextMode(false) }}
          title={open ? 'Close' : 'Controls'}
          className="w-11 h-11 rounded-full flex items-center justify-center
                     bg-white/[0.04] border border-white/[0.08]
                     backdrop-blur-2xl shadow-xl shadow-black/20
                     text-white hover:bg-white/[0.12]
                     transition-colors duration-150 cursor-pointer"
        >
          {open
            ? <X size={14} strokeWidth={2.5} />
            : <SlidersHorizontal size={15} strokeWidth={2} />}
        </button>

      </div>

      {/* ── Download modal ──────────────────────────────────────────────────── */}
      {showDownloadModal && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center px-6"
          style={{ background: 'rgba(8,8,14,0.75)', backdropFilter: 'blur(12px)' }}
          onClick={() => setShowDownloadModal(false)}
        >
          <div
            className="w-full max-w-sm rounded-3xl bg-white/[0.04] border border-white/[0.08]
                       backdrop-blur-2xl shadow-2xl shadow-black/50 p-7"
            onClick={e => e.stopPropagation()}
          >
            <p className="text-[15px] mb-4"
               style={{ fontFamily: "'Bitcount Grid Single', monospace", color: '#D9E0FE' }}>
              export as shader
            </p>
            <p className="text-white/55 text-[12px] leading-[1.75] mb-6">
              a shader is a small program that runs directly on your GPU to recreate
              this ripple field in real time.<br /><br />
              paste the contents of the downloaded{' '}
              <span className="text-white/80">.glsl</span> file into{' '}
              <span className="text-white/80">shadertoy.com</span> — create a new shader,
              replace the default code, and hit play. no install needed.
            </p>
            <div className="flex gap-2.5">
              <button
                onClick={() => { exportFnRef.current?.(); setShowDownloadModal(false) }}
                className="flex-1 py-2.5 rounded-full text-[11px] font-medium
                           bg-white/[0.12] text-white hover:bg-white/[0.18]
                           transition-colors duration-150 cursor-pointer"
              >
                download .glsl
              </button>
              <button
                onClick={() => setShowDownloadModal(false)}
                className="flex-1 py-2.5 rounded-full text-[11px] font-medium
                           text-white/55 hover:text-white/75 hover:bg-white/[0.06]
                           border border-white/[0.08]
                           transition-colors duration-150 cursor-pointer"
              >
                cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Help backdrop ───────────────────────────────────────────────────── */}
      {showHelp && (
        <div className="fixed inset-0 z-[9]" onClick={() => setShowHelp(false)} />
      )}

      {/* ── Help popup ──────────────────────────────────────────────────────── */}
      <div
        style={{
          opacity:       showHelp ? 1 : 0,
          transform:     showHelp ? 'translateY(0) scale(1)' : 'translateY(8px) scale(0.97)',
          pointerEvents: showHelp ? 'auto' : 'none',
          transition: [
            'opacity 0.2s ease',
            'transform 0.32s cubic-bezier(0.34,1.2,0.64,1)',
          ].join(', '),
        }}
        className="fixed bottom-20 right-6 z-[11] w-56
                   bg-white/[0.04] border border-white/[0.08]
                   backdrop-blur-2xl shadow-xl shadow-black/20 rounded-2xl"
      >
        <div className="px-4 py-4">
          <p className="text-[13px] tracking-widest mb-4 font-medium"
             style={{ fontFamily: "'Bitcount Grid Single', monospace", color: '#D9E0FE' }}>
            how it works
          </p>
          <div className="flex flex-col gap-2 mb-4">
            <div className="flex items-baseline gap-4">
              <span className="text-white/55 text-[11px] w-[72px] shrink-0">
                <span className="sm:hidden">tap</span>
                <span className="hidden sm:inline">click</span>
              </span>
              <span className="text-white/75 text-[11px]">add a ripple</span>
            </div>
            <div className="flex items-baseline gap-4">
              <span className="text-white/55 text-[11px] w-[72px] shrink-0">
                <span className="sm:hidden">double-tap</span>
                <span className="hidden sm:inline">double-click</span>
              </span>
              <span className="text-white/75 text-[11px]">start a loop</span>
            </div>
            <div className="flex items-baseline gap-4">
              <span className="text-white/55 text-[11px] w-[72px] shrink-0">download</span>
              <span className="text-white/75 text-[11px]">export as GLSL shader</span>
            </div>
          </div>
          <div className="border-t border-white/[0.08] pt-3">
            <a
              href="https://www.buildwithfloat.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-white/55 text-[11px] hover:text-white/75
                         transition-colors duration-150 flex items-center gap-1 group"
            >
              built by Float
              <span className="text-[10px] transition-transform duration-150
                               group-hover:translate-x-0.5 group-hover:-translate-y-0.5">↗</span>
            </a>
          </div>
        </div>
      </div>

      {/* ── Help button ─────────────────────────────────────────────────────── */}
      <button
        onClick={() => setShowHelp(h => !h)}
        title="How it works"
        className="fixed bottom-6 right-6 z-[11] w-11 h-11 rounded-full
                   flex items-center justify-center
                   bg-white/[0.04] border border-white/[0.08]
                   backdrop-blur-2xl shadow-xl shadow-black/20
                   text-white hover:bg-white/[0.12]
                   transition-colors duration-150 cursor-pointer"
      >
        <span className="text-[14px] font-light leading-none select-none">?</span>
      </button>

    </>
  )
}
