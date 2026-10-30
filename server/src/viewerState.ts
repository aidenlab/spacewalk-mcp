/**
 * The viewer state and how a proposal changes it (ADR 0001). Pure: the Room orders, versions,
 * stores and broadcasts; this only says what a proposal makes of a state, or why it is refused.
 */
import {
  RADIUS_LADDER_LENGTH,
  type BackgroundDirection,
  type Color,
  type EnsembleKind,
  type Proposal,
  type RadiusDirection,
  type ViewerSettings,
  type ViewerSettingsPatch,
  type ViewerState,
} from '@aidenlab/spacewalk-remote/protocol'

/** Apple crayon "iron" as three.js puts it in linear space: Spacewalk's default furniture color. */
const IRON = { r: 0.08865558627723595, g: 0.08865558627723595, b: 0.08650046202808521 }

/** What a Room shows before anything is changed: Spacewalk's own defaults. */
export function emptyViewerState(): ViewerState {
  return {
    ensemble: null,
    renderStyle: 'ball-and-stick',
    structureAppearance: {
      ballRadiusIndex: 5,
      stickRadiusIndex: 5,
      sticksVisible: true,
      pointSizeRadiusFraction: null,
      pointOpacity: 0.375,
      colorRamp: 'peter_kovesi_rainbow_bgyr_35_85_c72_n256',
      isCircular: false,
    },
    viewerSettings: {
      background: { r: 1, g: 1, b: 1 },
      gnomon: { visible: false, ...IRON },
      groundPlane: { visible: false, ...IRON },
      referenceRuler: { visible: false, ...IRON },
    },
    camera: null,
  }
}

export type Applied = { ok: true; state: ViewerState } | { ok: false; refusal: string }

const NO_ENSEMBLE = 'No ensemble is loaded.'

/** What a proposal makes of a viewer state, or why it is refused. */
export function apply(state: ViewerState, proposal: Proposal): Applied {
  const ensemble = state.ensemble
  switch (proposal.type) {
    case 'load-ensemble':
      return applied({
        ...state,
        ensemble: { url: proposal.url, groupKey: null, traceKey: null, kind: null },
      })
    case 'select-ensemble-group':
      if (!ensemble) return refused(NO_ENSEMBLE)
      return applied({
        ...state,
        ensemble: { ...ensemble, groupKey: proposal.key, traceKey: null },
      })
    case 'select-trace':
      if (!ensemble) return refused(NO_ENSEMBLE)
      return applied({ ...state, ensemble: { ...ensemble, traceKey: proposal.key } })
    case 'set-render-style':
      // Until a Viewer reports the kind, the Room cannot tell; the Viewer reports the failure.
      if (ensemble?.kind === 'point-cloud') {
        return refused('The ensemble is a point cloud, which is always drawn as a point cloud.')
      }
      return applied({ ...state, renderStyle: proposal.style })
    case 'step-ball-radius':
    case 'step-stick-radius': {
      const key = proposal.type === 'step-ball-radius' ? 'ballRadiusIndex' : 'stickRadiusIndex'
      const appearance = state.structureAppearance
      const rung = stepRung(appearance[key], proposal.direction)
      return applied({ ...state, structureAppearance: { ...appearance, [key]: rung } })
    }
    case 'set-structure-appearance':
      return applied({
        ...state,
        structureAppearance: { ...state.structureAppearance, ...proposal.patch },
      })
    case 'set-viewer-settings':
      return applied({ ...state, viewerSettings: patched(state.viewerSettings, proposal.patch) })
    case 'adjust-background': {
      const settings = state.viewerSettings
      const background = stepLightness(settings.background, proposal.direction)
      return applied({ ...state, viewerSettings: { ...settings, background } })
    }
    case 'set-camera':
      return applied({ ...state, camera: proposal.camera })
    case 'reset-camera':
      return applied({ ...state, camera: null })
    case 'load-session':
      return applied({
        ensemble: { ...proposal.ensemble, kind: null },
        renderStyle: proposal.renderStyle,
        structureAppearance: proposal.structureAppearance,
        viewerSettings: patched(state.viewerSettings, proposal.viewerSettings),
        camera: proposal.camera,
      })
  }
}

/** Viewer settings with some of them changed. */
function patched(settings: ViewerSettings, patch: ViewerSettingsPatch): ViewerSettings {
  return {
    background: patch.background ?? settings.background,
    gnomon: { ...settings.gnomon, ...patch.gnomon },
    groundPlane: { ...settings.groundPlane, ...patch.groundPlane },
    referenceRuler: { ...settings.referenceRuler, ...patch.referenceRuler },
  }
}

/** The viewer state knowing the loaded ensemble's kind, as a Viewer reported it. */
export function withKind(state: ViewerState, kind: EnsembleKind): ViewerState {
  if (!state.ensemble) return state
  return { ...state, ensemble: { ...state.ensemble, kind } }
}

/** One rung up or down Spacewalk's radius ladder, stopping at either end. */
function stepRung(rung: number, direction: RadiusDirection): number {
  const next = rung + (direction === 'up' ? 1 : -1)
  return Math.min(Math.max(next, 0), RADIUS_LADDER_LENGTH - 1)
}

/** How far one lighter or darker step moves the background's HSL lightness, out of 1. */
const LIGHTNESS_STEP = 0.1

/**
 * The background one step lighter or darker: its HSL lightness, taken in sRGB as a person sees
 * it, moves by LIGHTNESS_STEP and stops at white or black; hue and saturation stay.
 */
function stepLightness(color: Color, direction: BackgroundDirection): Color {
  const [h, s, l] = rgbToHsl(toSrgb(color.r), toSrgb(color.g), toSrgb(color.b))
  const lightness = clamp01(l + (direction === 'lighter' ? LIGHTNESS_STEP : -LIGHTNESS_STEP))
  const [r, g, b] = hslToRgb(h, s, lightness).map(toLinear)
  return { r, g, b }
}

// The sRGB transfer function, between three.js's linear components and sRGB's, both in [0, 1].
export function toSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

export function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t
    if (u < 1 / 6) return p + (q - p) * 6 * u
    if (u < 1 / 2) return q
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6
    return p
  }
  const rgb = [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map(clamp01)
  return rgb as [number, number, number]
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1)
}

function applied(state: ViewerState): Applied {
  return { ok: true, state }
}

function refused(refusal: string): Applied {
  return { ok: false, refusal }
}
