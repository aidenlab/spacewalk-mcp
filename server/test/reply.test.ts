import { describe, expect, it } from 'vitest'
import type { Proposal } from '@aidenlab/spacewalk-remote/protocol'
import { phraseNews } from '../src/reply.ts'
import type { News } from '../src/room.ts'

function byHand(...proposals: Proposal[]): News[] {
  return proposals.map((proposal, i) => ({ type: 'hand', version: i + 1, proposal }))
}

describe('the changes the model did not cause', () => {
  it('are phrased plainly, in the order they happened', () => {
    const news = byHand(
      { type: 'set-render-style', style: 'ribbon' },
      { type: 'select-trace', key: '12' },
    )
    expect(phraseNews(news)).toBe('switched to ribbon; stepped to trace 12')
  })

  it('collapse every camera move into one', () => {
    const camera = { position: { x: 0, y: 0, z: 1 }, target: { x: 0, y: 0, z: 0 } }
    const news = byHand(
      { type: 'set-camera', camera },
      { type: 'step-ball-radius', direction: 'up' },
      { type: 'set-camera', camera },
      { type: 'set-camera', camera },
    )
    expect(phraseNews(news)).toBe('the camera was moved; made the balls bigger')
  })

  it('include a Viewer failing to draw a version', () => {
    const news: News[] = [{ type: 'failure', version: 4, reason: 'could not fetch the ensemble' }]
    expect(phraseNews(news)).toBe('a Viewer failed to draw version 4: could not fetch the ensemble')
  })

  it('are nothing when nothing happened', () => {
    expect(phraseNews([])).toBe('')
  })

  it.each<[Proposal, string]>([
    [{ type: 'load-ensemble', url: 'https://example.com/a.sw' }, 'loaded the ensemble https://example.com/a.sw'],
    [{ type: 'select-ensemble-group', key: 'g2' }, 'chose ensemble group g2'],
    [{ type: 'set-render-style', style: 'ball-and-stick' }, 'switched to ball-and-stick'],
    [{ type: 'step-ball-radius', direction: 'down' }, 'made the balls smaller'],
    [{ type: 'step-stick-radius', direction: 'up' }, 'made the sticks thicker'],
    [{ type: 'step-stick-radius', direction: 'down' }, 'made the sticks thinner'],
    [{ type: 'adjust-background', direction: 'darker' }, 'made the background darker'],
    [{ type: 'reset-camera' }, 'reset the camera'],
    [
      { type: 'set-structure-appearance', patch: { sticksVisible: false, ballRadiusIndex: 3 } },
      'hid the sticks; set the ball radius to step 3',
    ],
    [
      { type: 'set-structure-appearance', patch: { colorRamp: 'viridis', isCircular: true } },
      'changed the color ramp to viridis; drew the genome as circular',
    ],
    [
      { type: 'set-structure-appearance', patch: { pointOpacity: 0.5, pointSizeRadiusFraction: null } },
      'set the point opacity to 0.5; reset the point size',
    ],
    [
      { type: 'set-viewer-settings', patch: { background: { r: 0, g: 0, b: 0 }, gnomon: { visible: true } } },
      'changed the background to #000000; showed the axes',
    ],
    [
      { type: 'set-viewer-settings', patch: { groundPlane: { visible: false }, referenceRuler: { r: 1, g: 1, b: 1 } } },
      'hid the ground plane; changed the reference ruler color to #ffffff',
    ],
  ])('phrase %j', (proposal, phrase) => {
    expect(phraseNews(byHand(proposal))).toBe(phrase)
  })
})
