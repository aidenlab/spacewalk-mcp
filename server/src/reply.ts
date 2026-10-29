/**
 * What a tool reply tells the model, in words (*observe everything, control a few*): how its
 * change came out, the changes it did not cause, how many Viewers are connected, and the full
 * viewer state. Pure: the Room keeps all of it, and this only says it.
 */
import type { Color, Proposal, SceneFixture } from '@aidenlab/spacewalk-remote/protocol'
import type { Look, News, Settled } from './room.ts'
import { toSrgb } from './viewerState.ts'

/** The reply to a change the model made: at `version`, it came out `settled`. */
export function changeReply(version: number, settled: Settled, look: Look): string {
  const later = settled.outcome === 'still-drawing' ? ' How it came out will be in a later reply.' : ''
  return `${phraseSettled(settled)} Version ${version}.${later}\n${lookReply(withoutTold(look, version, settled))}`
}

/**
 * The Room as the model sees it: what changed that it did not cause, how many Viewers are
 * connected, and the full viewer state.
 */
export function lookReply({ version, state, viewers, news }: Look): string {
  const phrased = phraseNews(news)
  const changes = phrased
    ? `Changed in the viewer since your last reply, not by you: ${phrased}.`
    : 'Nothing changed in the viewer since your last reply that you did not cause.'
  return `${changes}\nViewers connected: ${viewers}.\n\nViewer state (version ${version}):\n${JSON.stringify(state, null, 2)}`
}

function phraseSettled(settled: Settled): string {
  switch (settled.outcome) {
    case 'drawn':
      return 'Applied and drawn.'
    case 'failed':
      return `Applied, but the viewer failed to draw it: ${settled.reason}.`
    case 'still-drawing':
      return 'Applied, still drawing.'
    case 'no-viewer':
      return 'Applied, not shown yet — no viewer is open.'
  }
}

/**
 * The look without the failure the outcome already told: the first one with its reason, on the
 * model's version or the later one that stood for it.
 */
function withoutTold(look: Look, version: number, settled: Settled): Look {
  if (settled.outcome !== 'failed') return look
  const told = look.news.findIndex(
    (item) => item.type === 'failure' && item.version >= version && item.reason === settled.reason,
  )
  if (told === -1) return look
  return { ...look, news: look.news.toSpliced(told, 1) }
}

/** Every camera move phrases the same, and all of them collapse into one. */
const CAMERA_MOVED = 'the camera was moved'

/**
 * The changes the model did not cause, oldest first, as one line of plain phrases: "switched to
 * ribbon; stepped to trace 12". Empty when there are none.
 */
export function phraseNews(news: News[]): string {
  const phrases: string[] = []
  for (const item of news) {
    for (const phrase of phraseItem(item)) {
      if (phrase === CAMERA_MOVED && phrases.includes(CAMERA_MOVED)) continue
      phrases.push(phrase)
    }
  }
  return phrases.join('; ')
}

function phraseItem(item: News): string[] {
  if (item.type === 'failure') return [`a viewer failed to draw version ${item.version}: ${item.reason}`]
  return phraseProposal(item.proposal)
}

function phraseProposal(proposal: Proposal): string[] {
  switch (proposal.type) {
    case 'load-ensemble':
      return [`loaded the ensemble ${proposal.url}`]
    case 'select-ensemble-group':
      return [`chose ensemble group ${proposal.key}`]
    case 'select-trace':
      return [`stepped to trace ${proposal.key}`]
    case 'set-render-style':
      return [`switched to ${proposal.style}`]
    case 'step-ball-radius':
      return [`made the balls ${proposal.direction === 'up' ? 'bigger' : 'smaller'}`]
    case 'step-stick-radius':
      return [`made the sticks ${proposal.direction === 'up' ? 'thicker' : 'thinner'}`]
    case 'set-structure-appearance':
      return Object.entries(proposal.patch).map(([key, value]) => phraseAppearance(key, value))
    case 'set-viewer-settings': {
      const { background, gnomon, groundPlane, referenceRuler } = proposal.patch
      return [
        ...(background ? [`changed the background to ${hex(background)}`] : []),
        ...phraseFixture('axes', gnomon),
        ...phraseFixture('ground plane', groundPlane),
        ...phraseFixture('reference ruler', referenceRuler),
      ]
    }
    case 'adjust-background':
      return [`made the background ${proposal.direction}`]
    case 'set-camera':
      return [CAMERA_MOVED]
    case 'reset-camera':
      return ['reset the camera']
  }
}

/** One field of a structure appearance patch. */
function phraseAppearance(key: string, value: unknown): string {
  switch (key) {
    case 'ballRadiusIndex':
      return `set the ball radius to step ${value}`
    case 'stickRadiusIndex':
      return `set the stick radius to step ${value}`
    case 'sticksVisible':
      return value ? 'showed the sticks' : 'hid the sticks'
    case 'pointSizeRadiusFraction':
      return value === null ? 'reset the point size' : `set the point size to ${value}`
    case 'pointOpacity':
      return `set the point opacity to ${value}`
    case 'colorRamp':
      return `changed the color ramp to ${value}`
    case 'isCircular':
      return value ? 'drew the genome as circular' : 'drew the genome as linear'
    default:
      return `changed the ${key}`
  }
}

/** A patch to a scene fixture: shown or hidden, and its color. */
function phraseFixture(name: string, patch: Partial<SceneFixture> | undefined): string[] {
  if (!patch) return []
  const phrases: string[] = []
  if (patch.visible !== undefined) phrases.push(`${patch.visible ? 'showed' : 'hid'} the ${name}`)
  const { r, g, b } = patch
  if (r !== undefined && g !== undefined && b !== undefined) {
    phrases.push(`changed the ${name} color to ${hex({ r, g, b })}`)
  } else if (r !== undefined || g !== undefined || b !== undefined) {
    phrases.push(`changed the ${name} color`)
  }
  return phrases
}

/** A three.js linear-space color as a person writes it: sRGB hex. */
function hex({ r, g, b }: Color): string {
  const byte = (c: number) => Math.round(toSrgb(c) * 255).toString(16).padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}
