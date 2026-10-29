/**
 * What a tool reply tells the model, in words (*observe everything, control a few*): how its
 * change came out, the changes it did not cause, how many Viewers are connected, and the full
 * viewer state. Pure: the Room keeps all of it, and this only says it.
 */
import type { Color, Proposal, SceneFixture, StructureAppearance } from '@aidenlab/spacewalk-remote/protocol'
import type { Look, News, Realized, Settled } from './room.ts'
import { toSrgb } from './viewerState.ts'

/** The reply to a change the model made: at `version`, it came out `settled`. */
export function changeReply(version: number, settled: Settled, look: Look): string {
  const later = settled.outcome === 'still-drawing' ? ' How it came out will be in a later reply.' : ''
  return `${phraseSettled(version, settled)} Version ${version}.${later}\n${lookReply(untold(look, version, settled))}`
}

/**
 * The Room as the model sees it: what changed that it did not cause, how many Viewers are
 * connected and how far they have realized, and the full viewer state.
 */
export function lookReply({ version, state, viewers, realized, news }: Look): string {
  const phrased = phraseNews(news)
  const lines = [
    phrased
      ? `Changed since your last reply, not by you: ${phrased}.`
      : 'Nothing changed since your last reply that you did not cause.',
    `Viewers connected: ${viewers}.`,
  ]
  // How a change the reply gave up on came out, once a Viewer caught up.
  if (realized) lines.push(`A Viewer has realized up to version ${realized.version}, ${phraseResult(realized)}.`)
  return `${lines.join('\n')}\n\nViewer state (version ${version}):\n${JSON.stringify(state, null, 2)}`
}

function phraseResult({ result }: Realized): string {
  return result.outcome === 'drawn' ? 'drawn' : `failed: ${result.reason}`
}

/**
 * How the model's change at `version` came out. A later version realized stands for it: drawn,
 * so was its change; failed, the failure is that later change's, told among the news.
 */
function phraseSettled(version: number, settled: Settled): string {
  switch (settled.outcome) {
    case 'realized': {
      const { result } = settled.realized
      if (result.outcome === 'drawn') return 'Applied and drawn.'
      if (settled.realized.version > version) return 'Applied, then a later change failed to draw.'
      return `Applied, but the Viewer failed to draw it: ${result.reason}.`
    }
    case 'still-drawing':
      return 'Applied, still drawing.'
    case 'no-viewer':
      return 'Applied, not shown yet — no viewer is open.'
  }
}

/**
 * The look less what the outcome already told: how far the Viewers have realized, and the failure
 * of the model's own version.
 */
function untold(look: Look, version: number, settled: Settled): Look {
  if (settled.outcome !== 'realized') return look
  const rest = { ...look, realized: null }
  const { result } = settled.realized
  if (settled.realized.version !== version || result.outcome !== 'failed') return rest
  const told = look.news.findIndex(
    (item) => item.type === 'failure' && item.version === version && item.reason === result.reason,
  )
  if (told === -1) return rest
  return { ...rest, news: look.news.toSpliced(told, 1) }
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
  if (item.type === 'failure') return [`a Viewer failed to draw version ${item.version}: ${item.reason}`]
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
      return (Object.keys(proposal.patch) as (keyof StructureAppearance)[]).map((key) =>
        phraseAppearance(key, proposal.patch),
      )
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
function phraseAppearance(key: keyof StructureAppearance, patch: Partial<StructureAppearance>): string {
  switch (key) {
    case 'ballRadiusIndex':
      return `set the ball radius to step ${patch.ballRadiusIndex}`
    case 'stickRadiusIndex':
      return `set the stick radius to step ${patch.stickRadiusIndex}`
    case 'sticksVisible':
      return patch.sticksVisible ? 'showed the sticks' : 'hid the sticks'
    case 'pointSizeRadiusFraction':
      return patch.pointSizeRadiusFraction === null
        ? 'reset the point size'
        : `set the point size to ${patch.pointSizeRadiusFraction}`
    case 'pointOpacity':
      return `set the point opacity to ${patch.pointOpacity}`
    case 'colorRamp':
      return `changed the color ramp to ${patch.colorRamp}`
    case 'isCircular':
      return patch.isCircular ? 'drew the genome as circular' : 'drew the genome as linear'
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
