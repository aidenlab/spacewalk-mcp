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
export const PROTOCOL_VERSION = 2

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

/** A camera pose: where the camera is and what it looks at. A Viewer's rig owns it (ADR 0005). */
export const Camera = z.object({ position: Point, target: Point })
export type Camera = z.infer<typeof Camera>

/** A place in an ensemble. A null trace key means the ensemble's first trace. */
export const Place = z.object({
  url: z.string(),
  groupKey: z.string().nullable(),
  traceKey: z.string().nullable(),
})
export type Place = z.infer<typeof Place>

/** Whether two places are one, a null trace key being the first trace. */
export function isSamePlace(a: Place, b: Place): boolean {
  return a.url === b.url && a.groupKey === b.groupKey && (a.traceKey ?? '0') === (b.traceKey ?? '0')
}

/** A camera pose and the place it was read in: it means nothing in any other (ADR 0005). */
export const PlacedCamera = z.object({ place: Place, camera: Camera })
export type PlacedCamera = z.infer<typeof PlacedCamera>

/**
 * The viewer state: the Room's one record of what its Viewers show (ADR 0001). No ensemble means
 * nothing is loaded. It holds no camera pose (ADR 0005).
 */
export const ViewerState = z.object({
  ensemble: Ensemble.nullable(),
  renderStyle: RenderStyle,
  structureAppearance: StructureAppearance,
  viewerSettings: ViewerSettings,
})
export type ViewerState = z.infer<typeof ViewerState>

/** Which way a radius step goes along the ladder. */
export const RadiusDirection = z.enum(['up', 'down'])
export type RadiusDirection = z.infer<typeof RadiusDirection>

/** Which way a background step goes. */
export const BackgroundDirection = z.enum(['lighter', 'darker'])
export type BackgroundDirection = z.infer<typeof BackgroundDirection>

/** Some of the viewer settings, each section whole or in part. */
export const ViewerSettingsPatch = z.object({
  background: Color.optional(),
  gnomon: SceneFixture.partial().optional(),
  groundPlane: SceneFixture.partial().optional(),
  referenceRuler: SceneFixture.partial().optional(),
})
export type ViewerSettingsPatch = z.infer<typeof ViewerSettingsPatch>

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
  z.object({ type: z.literal('set-viewer-settings'), patch: ViewerSettingsPatch }),
  z.object({ type: z.literal('adjust-background'), direction: BackgroundDirection }),
  // A session, whole: one proposal, so that a Viewer draws it once. Viewer settings are only those
  // the session carries, beside it (ADR 0002).
  z.object({
    type: z.literal('load-session'),
    ensemble: Ensemble.omit({ kind: true }),
    renderStyle: RenderStyle,
    structureAppearance: StructureAppearance,
    viewerSettings: ViewerSettingsPatch,
    camera: Camera.nullable(),
  }),
])
export type Proposal = z.infer<typeof Proposal>

/** Viewer → Room, first on every connection: the protocol version the Viewer speaks. */
export const JoinMessage = z.object({
  type: z.literal('join'),
  protocol: z.int(),
})
export type JoinMessage = z.infer<typeof JoinMessage>

/** Viewer → Room: a hand change, proposed for the Room to apply. */
export const ProposeMessage = z.object({
  type: z.literal('propose'),
  proposal: Proposal,
})
export type ProposeMessage = z.infer<typeof ProposeMessage>

/** How a Viewer's attempt to draw a version went: drawn, or failed, and why. */
export const Realization = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('drawn') }),
  z.object({ outcome: z.literal('failed'), reason: z.string() }),
])
export type Realization = z.infer<typeof Realization>

/**
 * Viewer → Room: the Viewer has caught up to a version, drawn or failed in the attempt. It says
 * what kind of ensemble that version shows, once it knows; null when it does not, or nothing is
 * loaded.
 */
export const RealizedMessage = z.object({
  type: z.literal('realized'),
  version: z.int().nonnegative(),
  kind: EnsembleKind.nullable(),
  result: Realization,
})
export type RealizedMessage = z.infer<typeof RealizedMessage>

/**
 * Viewer → Room, on the camera (ADR 0005). A person took hold of this Viewer's camera, which makes
 * it the camera holder.
 */
export const TookCameraMessage = z.object({ type: z.literal('took-camera') })

/** Viewer → Room: a person let go of the camera here. This Viewer is the holder; the Room relays it. */
export const CameraReleasedMessage = PlacedCamera.extend({ type: z.literal('camera-released') })

/** Viewer → Room: a person reset the camera here. This Viewer is the holder; the Room relays it. */
export const CameraResetMessage = z.object({ type: z.literal('camera-reset') })

/** Viewer → Room: this Viewer has just framed or joined, and wants the holder's pose, if another holds it. */
export const WantCameraMessage = z.object({ type: z.literal('want-camera') })

/** Viewer → Room: the holder's pose, for the Room to relay to whoever wanted it. No change of holder. */
export const CameraSharedMessage = PlacedCamera.extend({ type: z.literal('camera-shared') })

/** Viewer → Room: the answer to `ask-camera`, a reading of this moment; null with nothing shown. */
export const CameraAnswerMessage = z.object({
  type: z.literal('camera-answer'),
  requestId: z.string(),
  pose: PlacedCamera.nullable(),
})

/** Viewer → Room: the holder has done the reset the Room asked for. */
export const CameraResetDoneMessage = z.object({
  type: z.literal('camera-reset-done'),
  requestId: z.string(),
})

/** Every message a Viewer sends a Room. */
export const ViewerMessage = z.discriminatedUnion('type', [
  JoinMessage,
  ProposeMessage,
  RealizedMessage,
  TookCameraMessage,
  CameraReleasedMessage,
  CameraResetMessage,
  WantCameraMessage,
  CameraSharedMessage,
  CameraAnswerMessage,
  CameraResetDoneMessage,
])
export type ViewerMessage = z.infer<typeof ViewerMessage>

/**
 * Why a Room refused a Viewer, or something it sent. The first three end the connection; after a
 * refused proposal the Room resyncs the Viewer, which puts its hand change back.
 */
export const ErrorCode = z.enum([
  // The Viewer speaks another protocol version: reload the viewer.
  'protocol-mismatch',
  // The Room has expired and never gets its contents back.
  'room-expired',
  // No Room has this id: it was never opened.
  'room-unknown',
  // The hand change does not apply to the current viewer state.
  'proposal-refused',
  // The message is not one this protocol version knows.
  'malformed-message',
])
export type ErrorCode = z.infer<typeof ErrorCode>

/** Room → Viewer: a refusal, with an optional message for a person to read. */
export const ErrorMessage = z.object({
  type: z.literal('error'),
  code: ErrorCode,
  message: z.string().optional(),
})
export type ErrorMessage = z.infer<typeof ErrorMessage>

/**
 * The latest load of an ensemble or a session: its version, and the session's camera pose while
 * no Viewer has drawn it (ADR 0005). A Viewer acts on each load once.
 */
export const Loaded = z.object({
  version: z.int().nonnegative(),
  camera: Camera.nullable(),
})
export type Loaded = z.infer<typeof Loaded>

/** Room → Viewer: the viewer state at a version, broadcast to every Viewer after each change. */
export const StateMessage = z.object({
  type: z.literal('state'),
  version: z.int().nonnegative(),
  state: ViewerState,
  loaded: Loaded.nullable(),
})
export type StateMessage = z.infer<typeof StateMessage>

/** Room → Viewer: another Viewer's camera pose, to follow if this Viewer shows that place. */
export const CameraMovedMessage = PlacedCamera.extend({ type: z.literal('camera-moved') })

/** Room → holder: read your camera now and answer. */
export const AskCameraMessage = z.object({ type: z.literal('ask-camera'), requestId: z.string() })

/** Room → holder: another Viewer wants your pose; share it. */
export const ShareCameraMessage = z.object({ type: z.literal('share-camera') })

/** Room → Viewer: frame the structure. With a request id this Viewer holds the camera, and confirms. */
export const ResetCameraMessage = z.object({
  type: z.literal('reset-camera'),
  requestId: z.string().optional(),
})

/** Every message a Room sends a Viewer. */
export const RoomMessage = z.discriminatedUnion('type', [
  ErrorMessage,
  StateMessage,
  CameraMovedMessage,
  AskCameraMessage,
  ShareCameraMessage,
  ResetCameraMessage,
])
export type RoomMessage = z.infer<typeof RoomMessage>
