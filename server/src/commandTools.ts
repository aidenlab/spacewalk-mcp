import { z, type ZodRawShape } from 'zod'
import {
  BackgroundDirection,
  RadiusDirection,
  type Proposal,
  type RenderStyle,
} from '@aidenlab/spacewalk-remote/protocol'
import { APPLE_CRAYON_NAMES, colorFromName } from './colors.ts'

/**
 * A tool whose whole job is one proposal to the Room. It is registered with a `room` argument
 * beside its own, and its proposal is made from its own arguments.
 */
export interface CommandTool {
  name: string
  title: string
  description: string
  inputSchema: ZodRawShape
  proposal: (args: Record<string, unknown>) => Proposal
}

/**
 * What an ensemble is, for a tool description, and the one place "the model" may stand for it:
 * a pointer, never a name.
 */
export const ENSEMBLE_POINTER =
  'An ensemble is the collection of traces in one .sw file (the user may call this "the model").'

/** The render styles a person chooses, as the tool takes them and as the protocol has them. */
const RENDER_STYLES = {
  ball_and_stick: 'ball-and-stick',
  ribbon: 'ribbon',
} as const satisfies Record<string, RenderStyle>
type RenderStyleName = keyof typeof RENDER_STYLES

/** Which way a radius step goes: up is bigger, down is smaller. */
const RADIUS_DIRECTION = RadiusDirection.describe('up for one radius step bigger, down for one smaller.')

/**
 * The command tools, one row each. Adding one is adding a row here; the Room already applies
 * every proposal the protocol has.
 */
export const COMMAND_TOOLS: CommandTool[] = [
  {
    name: 'load_ensemble',
    title: 'Load an ensemble',
    description:
      `Load an ensemble into Spacewalk from the URL of its .sw file. ${ENSEMBLE_POINTER} It opens at its default ensemble group and trace. Use list_example_ensembles for URLs of ensembles to try.`,
    inputSchema: { url: z.url().describe('The URL of the .sw file.') },
    proposal: ({ url }) => ({ type: 'load-ensemble', url: url as string }),
  },
  {
    name: 'select_ensemble_group',
    title: 'Select an ensemble group',
    description:
      'Make one ensemble group of the loaded ensemble current, by its key. An ensemble group is a named subset of the traces in the .sw file; one is current at a time. Spacewalk shows the group at its default trace.',
    inputSchema: { key: z.string().min(1).describe('The key of the ensemble group.') },
    proposal: ({ key }) => ({ type: 'select-ensemble-group', key: key as string }),
  },
  {
    name: 'set_render_style',
    title: 'Set the render style',
    description:
      'Choose how the 3D structure is drawn: ball_and_stick (a ball at each genomic extent, sticks joining them) or ribbon (a smooth tube through them). Only for an ensemble of traces: a point-cloud ensemble is always drawn as a point cloud. Once a Viewer has reported the ensemble a point cloud (kind in the viewer state), this is refused; before then, the Viewer reports the failure to draw it.',
    inputSchema: {
      style: z.enum(Object.keys(RENDER_STYLES) as [RenderStyleName]).describe('The render style.'),
    },
    proposal: ({ style }) => ({ type: 'set-render-style', style: RENDER_STYLES[style as RenderStyleName] }),
  },
  {
    name: 'step_ball_radius',
    title: 'Make the balls bigger or smaller',
    description:
      'Make the balls of the ball-and-stick render style one radius step bigger (up) or smaller (down). The ball radius is a rung 0–10 on Spacewalk\'s radius ladder, ballRadiusIndex in the viewer state; a step past either end stays there.',
    inputSchema: { direction: RADIUS_DIRECTION },
    proposal: ({ direction }) => ({ type: 'step-ball-radius', direction: direction as RadiusDirection }),
  },
  {
    name: 'step_stick_radius',
    title: 'Make the sticks thicker or thinner',
    description:
      'Make the sticks of the ball-and-stick render style one radius step thicker (up) or thinner (down). The stick radius is a rung 0–10 on Spacewalk\'s radius ladder, stickRadiusIndex in the viewer state; a step past either end stays there.',
    inputSchema: { direction: RADIUS_DIRECTION },
    proposal: ({ direction }) => ({ type: 'step-stick-radius', direction: direction as RadiusDirection }),
  },
  {
    name: 'reset_camera',
    title: 'Reset the camera',
    description: 'Put the camera back where Spacewalk frames the whole 3D structure.',
    inputSchema: {},
    proposal: () => ({ type: 'reset-camera' }),
  },
  {
    name: 'set_background_color',
    title: 'Set the background color',
    description: `Set the color behind the 3D structure, by Apple crayon name or hex (#rrggbb). The crayons: ${APPLE_CRAYON_NAMES.join(', ')}.`,
    inputSchema: {
      color: z
        .string()
        .refine((color) => colorFromName(color) !== null, 'Give an Apple crayon name or a hex color such as #808080.')
        .describe('An Apple crayon name, or a hex color.'),
    },
    proposal: ({ color }) => ({ type: 'set-viewer-settings', patch: { background: colorFromName(color as string)! } }),
  },
  {
    name: 'adjust_background',
    title: 'Make the background lighter or darker',
    description: 'Make the color behind the 3D structure one step lighter or darker, keeping its hue. A step past white or black stays there.',
    inputSchema: { direction: BackgroundDirection.describe('lighter or darker.') },
    proposal: ({ direction }) => ({ type: 'adjust-background', direction: direction as BackgroundDirection }),
  },
]
