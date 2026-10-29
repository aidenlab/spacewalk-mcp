/**
 * The wire protocol between a Viewer (`@aidenlab/spacewalk-remote`) and a Room on the
 * spacewalk-mcp server. The Worker imports it from the workspace through
 * `@aidenlab/spacewalk-remote/protocol`, so the two ends cannot disagree about it (ADR 0003).
 * No DOM.
 */
import { z } from 'zod'

/**
 * The protocol version. A Viewer sends it when it joins, and a Room refuses a Viewer that
 * speaks another one. Bump it on any change a Viewer and a Room could not both survive.
 */
export const PROTOCOL_VERSION = 1

/** A color as Spacewalk's viewer settings hold it: three.js linear-space components in [0, 1]. */
export const Color = z.object({
  r: z.number().min(0).max(1),
  g: z.number().min(0).max(1),
  b: z.number().min(0).max(1),
})
export type Color = z.infer<typeof Color>

/** A thing in the scene that can be shown or hidden, in a color. */
export const SceneFixture = Color.extend({ visible: z.boolean() })
export type SceneFixture = z.infer<typeof SceneFixture>

/**
 * Whether an ensemble is drawn as traces (ball-and-stick or ribbon) or is a point cloud. Known
 * only once a Viewer has loaded it and reported it realized.
 */
export const EnsembleKind = z.enum(['trace', 'point-cloud'])
export type EnsembleKind = z.infer<typeof EnsembleKind>

/** The loaded ensemble and the Viewer's place in it. A null key means the ensemble's default. */
export const Ensemble = z.object({
  url: z.string(),
  groupKey: z.string().nullable(),
  traceKey: z.string().nullable(),
  kind: EnsembleKind.nullable(),
})
export type Ensemble = z.infer<typeof Ensemble>

/**
 * The render style a person chooses. A point-cloud ensemble is drawn as a point cloud whatever
 * this says.
 */
export const RenderStyle = z.enum(['ball-and-stick', 'ribbon'])
export type RenderStyle = z.infer<typeof RenderStyle>

/** Ball and stick radii are rungs 0–10 on Spacewalk's radius ladder; a step moves one rung. */
export const RADIUS_LADDER_LENGTH = 11
const RadiusIndex = z.int().min(0).max(RADIUS_LADDER_LENGTH - 1)

/**
 * Structure appearance: how the 3D structure is drawn. The fields and their meaning are those of
 * the `structureAppearance` block of a Spacewalk session (spacewalk
 * `development-notes/spacewalk-mcp/session-format.md`).
 */
export const StructureAppearance = z.object({
  ballRadiusIndex: RadiusIndex,
  stickRadiusIndex: RadiusIndex,
  sticksVisible: z.boolean(),
  pointSizeRadiusFraction: z.number().positive().nullable(),
  pointOpacity: z.number().positive().max(1),
  colorRamp: z.string().min(1),
  isCircular: z.boolean(),
})
export type StructureAppearance = z.infer<typeof StructureAppearance>

/**
 * Viewer settings: the furniture around the structure, in the record Spacewalk's
 * `ViewerSettings` receives (ADR 0002).
 */
export const ViewerSettings = z.object({
  background: Color,
  gnomon: SceneFixture,
  groundPlane: SceneFixture,
  referenceRuler: SceneFixture,
})
export type ViewerSettings = z.infer<typeof ViewerSettings>

const Point = z.object({ x: z.number(), y: z.number(), z: z.number() })

/** Where the camera is and what it looks at. */
export const Camera = z.object({ position: Point, target: Point })
export type Camera = z.infer<typeof Camera>

/**
 * The viewer state: the Room's one record of what its Viewers show (ADR 0001). No ensemble means
 * nothing is loaded; no camera means the Viewer frames the structure itself.
 */
export const ViewerState = z.object({
  ensemble: Ensemble.nullable(),
  renderStyle: RenderStyle,
  structureAppearance: StructureAppearance,
  viewerSettings: ViewerSettings,
  camera: Camera.nullable(),
})
export type ViewerState = z.infer<typeof ViewerState>

/** Which way a radius step goes along the ladder. */
export const RadiusDirection = z.enum(['up', 'down'])
export type RadiusDirection = z.infer<typeof RadiusDirection>

/** Which way a background step goes. */
export const BackgroundDirection = z.enum(['lighter', 'darker'])
export type BackgroundDirection = z.infer<typeof BackgroundDirection>

/**
 * A proposal: a change to the viewer state offered by a Viewer or a tool call. Only the Room
 * applies one. Relative steps (`step-*`, `adjust-background`) name a direction, and the Room
 * applies them to whatever the current value is.
 */
export const Proposal = z.discriminatedUnion('type', [
  z.object({ type: z.literal('load-ensemble'), url: z.string() }),
  z.object({ type: z.literal('select-ensemble-group'), key: z.string() }),
  z.object({ type: z.literal('select-trace'), key: z.string() }),
  z.object({ type: z.literal('set-render-style'), style: RenderStyle }),
  z.object({ type: z.literal('step-ball-radius'), direction: RadiusDirection }),
  z.object({ type: z.literal('step-stick-radius'), direction: RadiusDirection }),
  z.object({
    type: z.literal('set-structure-appearance'),
    patch: StructureAppearance.partial(),
  }),
  z.object({
    type: z.literal('set-viewer-settings'),
    patch: z.object({
      background: Color.optional(),
      gnomon: SceneFixture.partial().optional(),
      groundPlane: SceneFixture.partial().optional(),
      referenceRuler: SceneFixture.partial().optional(),
    }),
  }),
  z.object({ type: z.literal('adjust-background'), direction: BackgroundDirection }),
  z.object({ type: z.literal('set-camera'), camera: Camera }),
  z.object({ type: z.literal('reset-camera') }),
])
export type Proposal = z.infer<typeof Proposal>

/** Viewer → Room, first on every connection: the protocol version the Viewer speaks. */
export const JoinMessage = z.object({
  type: z.literal('join'),
  protocol: z.int(),
})
export type JoinMessage = z.infer<typeof JoinMessage>

/** Every message a Viewer sends a Room. */
export const ViewerMessage = z.discriminatedUnion('type', [JoinMessage])
export type ViewerMessage = z.infer<typeof ViewerMessage>

/** Why a Room refused a Viewer. */
export const ErrorCode = z.enum([
  // The Viewer speaks another protocol version: reload the viewer.
  'protocol-mismatch',
  // The Room has expired and never gets its contents back.
  'room-expired',
])
export type ErrorCode = z.infer<typeof ErrorCode>

/** Room → Viewer: a refusal, with an optional message for a person to read. */
export const ErrorMessage = z.object({
  type: z.literal('error'),
  code: ErrorCode,
  message: z.string().optional(),
})
export type ErrorMessage = z.infer<typeof ErrorMessage>

/** Room → Viewer: the viewer state at a version, broadcast to every Viewer after each change. */
export const StateMessage = z.object({
  type: z.literal('state'),
  version: z.int().nonnegative(),
  state: ViewerState,
})
export type StateMessage = z.infer<typeof StateMessage>

/** Every message a Room sends a Viewer. */
export const RoomMessage = z.discriminatedUnion('type', [ErrorMessage, StateMessage])
export type RoomMessage = z.infer<typeof RoomMessage>
