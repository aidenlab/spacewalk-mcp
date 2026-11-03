# One owner for the camera: the rig, not the Room

Supersedes ADR 0001 for the camera. Every piece of live state has exactly one owner. The Room still owns what stays valid whatever geometry is drawn: the ensemble and its place, the render style, the structure appearance and the viewer settings. A Viewer's `CameraLightingRig` owns the camera pose, because a pose means something only against geometry the Room never sees. The Room's copy was wrong in every way that counted: it could not compute a framing, it lagged a drag, and it held the old pose across a change of trace, which left the structure off screen and made the Viewer write workarounds. So the Room keeps no pose, and anyone who needs one asks by message and gets a reading of that moment, which nobody stores. `kind` stays in the Room, though a Viewer reports it, because it is a fixed fact about a loaded file and cannot drift.

Several Viewers mean several rigs, so at any moment one Viewer is the **camera holder**, and the others follow it. A Viewer takes over when a person grabs, releases or resets its camera, or steps to another trace. A person's own drag wins on their own screen, and everyone ends on the last release. The Room keeps only which Viewer holds the camera, on its socket, so the record goes with the socket. When a holder leaves, the longest-connected Viewer takes over. Followers can lag the holder, so only the holder's pose is strictly true.

A step or a reset sends no pose: each Viewer frames the trace itself. Every pose names its place, and a pose for a place a Viewer is not showing is dropped, because that is what produced the blank canvas.

## The one exception

A loaded session carries a pose, and may arrive with no Viewer open. The Room holds that pose until a Viewer has drawn the load, then deletes it, and a change of place, or a reset, deletes it sooner. It is an undelivered message, not a record of a live camera, since no rig has applied it yet.

## Considered Options

- **Keep the Room's copy and clear it on a change of trace.** Rejected: it fixes the blank canvas but keeps two records of one fact, with the Room's still behind during a drag and still blind to the framing.
- **A fixed leader, whose Viewer alone may move the camera.** Rejected: the glossary makes a Guest an equal of the Organizer in what the Viewers show.
- **One independent camera per Viewer.** Rejected: strictest of all, but people in a meeting could be looking from different camera poses, and M3 promises the same camera.
- **Keep the pose across a reload in `sessionStorage`.** Rejected: it is a second copy of the pose.
- **Wait for the camera to settle before answering.** Rejected: a person who keeps dragging could hold an answer until it times out.

ADR 0001 rejected relaying commands between pages for their costs in echo, drift and ordering. The camera relay accepts those on purpose: it is one last-mover-wins value, a pose for the wrong place is dropped, and the next move corrects a drifted follower.

## Consequences

- With no Viewer open there is no camera. A snapshot then opens framed, unless a load's pose is still undelivered, and the reply says so. It also says so when the holder does not answer in time or answers for another place.
- `get_shareable_url` is the only tool that asks for the pose, so it waits on a round trip to a Viewer. `read_viewer_state` no longer reports a camera. A camera move or reset is no longer news to the model.
- A lone Viewer that reloads loses its orbit and shows the framing.
- Viewers with different window shapes can crop one pose differently.
- A camera move creates no version, so `reset_camera` cannot wait for a realized version and waits for the holder to confirm instead.
- Followers jump to the final pose at release. Live tracking during a drag was considered for M3 and declined: the jump at release is enough.
