/**
 * The colors a person names: an Apple crayon or hex, written as what viewer settings hold, three.js
 * components in linear space (spacewalk `development-notes/spacewalk-mcp/session-format.md`). Left
 * in sRGB, every color shows lighter than asked.
 */
import type { Color } from '@aidenlab/spacewalk-remote/protocol'
import { toLinear } from './viewerState.ts'

/** Spacewalk's Apple crayons, spelled as it spells them (`src/utils/colorUtils.js`). */
const APPLE_CRAYONS: Record<string, string> = {
  licorice: '#000000',
  lead: '#1e1e1e',
  tungsten: '#3a3a3a',
  iron: '#545453',
  steel: '#6e6e6e',
  tin: '#878687',
  nickel: '#888787',
  aluminum: '#a09fa0',
  magnesium: '#b8b8b8',
  silver: '#d0d0d0',
  mercury: '#e8e8e8',
  snow: '#ffffff',
  cayenne: '#891100',
  mocha: '#894800',
  aspargus: '#888501',
  fern: '#458401',
  clover: '#028401',
  moss: '#018448',
  teal: '#008688',
  ocean: '#004a88',
  midnight: '#001888',
  eggplant: '#491a88',
  plum: '#891e88',
  maroon: '#891648',
  maraschino: '#ff2101',
  tangerine: '#ff8802',
  lemon: '#fffa03',
  lime: '#83f902',
  spring: '#05f802',
  seam_foam: '#03f987',
  turquoise: '#00fdff',
  aqua: '#008cff',
  blueberry: '#002eff',
  grape: '#8931ff',
  magenta: '#ff39ff',
  strawberry: '#ff2987',
  salmon: '#ff726e',
  cantaloupe: '#ffce6e',
  banana: '#fffb6d',
  honeydew: '#cefa6e',
  flora: '#68f96e',
  spindrift: '#68fbd0',
  ice: '#68fdff',
  sky: '#6acfff',
  orchid: '#6e76ff',
  lavender: '#d278ff',
  bubblegum: '#ff7aff',
  carnation: '#ff7fd3',
}

/** The crayons, by name, for a tool description. */
export const APPLE_CRAYON_NAMES = Object.keys(APPLE_CRAYONS)

/** A crayon name or hex color as its linear components; null when it is neither. */
export function colorFromName(name: string): Color | null {
  const lower = name.trim().toLowerCase()
  const hex = Object.hasOwn(APPLE_CRAYONS, lower) ? APPLE_CRAYONS[lower] : lower
  const digits = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(hex)?.[1]
  if (digits === undefined) return null
  const full = digits.length === 3 ? digits.replace(/./g, '$&$&') : digits
  const component = (start: number) => toLinear(parseInt(full.slice(start, start + 2), 16) / 255)
  return { r: component(0), g: component(2), b: component(4) }
}
