# spacewalk-mcp

Lets a person explore 3D chromatin structure with Spacewalk beside a Claude or ChatGPT conversation.

Spacewalk's own terms (ensemble, ensemble group, trace, render style, ball, stick, radius step, material provider, session, viewer settings) are defined in Spacewalk's `CONTEXT.md` and mean the same here.

## Language

### People and places (adopted from geenee)

**Viewer**:
The web page showing Spacewalk's 3D viewer, attached to one Room.
_Avoid_: page, widget, app

**Room**:
What ties one conversation to the Viewers showing its 3D view, identified by a Room id the model passes on every tool call. A Room expires after a day without use, and an expired Room never gets its contents back; opening the viewer again may start it over, empty, under the same id.
_Avoid_: session, channel

**Room link**:
The link that brings anyone into a Room.
_Avoid_: URL, invite, share link

**Driver**:
The person whose conversation a Room belongs to: their model makes the tool calls. A role in one Room, not a kind of person.
_Avoid_: presenter, owner, host, user

**Guest**:
A person who joins a Room through its Room link, with no conversation, as an equal of the Driver in what the Viewers show.
_Avoid_: bystander, participant, collaborator

### What the Room holds

**Viewer state**:
The Room's one versioned record of what its Viewers show: the loaded ensemble and its place in it, the render style, the structure appearance and the viewer settings, but not the camera pose. The Room is its only author; Viewers are replicas.
_Avoid_: state document, session, model state

**Structure appearance**:
How the 3D structure is drawn, as distinct from the furniture around it: ball and stick radius steps, whether sticks show, point size and transparency, color ramp, circular genome. Shared by everyone in the Room.
_Avoid_: render settings, viewer settings (those are the furniture)

### The camera

**Camera pose**:
Where the camera is and what it looks at. With no Viewer open there is no camera, and so no camera pose, apart from one a load has brought and no Viewer has drawn yet.
_Avoid_: camera state, camera position, view

**Framing**:
The camera pose and projection a Viewer works out for the trace it shows, on arriving at that trace or on a reset.
_Avoid_: default camera, home position

**Camera holder**:
The one Viewer whose camera is the truth at any moment, which the others follow. It is the Viewer where a person last took hold of the camera, let go of it, reset it or stepped to another trace, and when that Viewer leaves, the longest-connected one takes over.
_Avoid_: leader, presenter, camera owner

### Pointing

**Highlight**:
The genomic locus a person is pointing at, shown at once in genomic space and in 3D space; the visual link between the two is the point. Pointing at the genomic navigator lights the matching part of the structure: a ball, a red bead travelling along the ribbon, or the cluster of points for that genomic extent, with the rest greyed out. With balls and sticks it also works the other way: pointing at a ball lights its place on the navigator. Anyone in the Room may highlight, and every Viewer sees it, since all of them show the same trace; a Viewer caught mid-step on another trace shows no shared highlight. One highlight shows at a time, and the last person to move wins, except that a person's own highlight always wins on their own screen. It lasts only while the person points: the Room keeps no record of it, it is never saved, and the model takes no part in it.
_Avoid_: hover, selection, cursor, marker

### What outlasts the Room

**Session**:
Spacewalk's saved record of what to restore, as JSON: the Spacewalk session block, and IGV's and Juicebox's own sessions when present. It does not change once written and outlasts any Room; a Room is live, a session is at rest.
_Avoid_: Room, viewer state, conversation

**Session block**:
The Spacewalk part of a session: the 3D view, and what only the full app reads, such as the locus and panel visibility.

**Session string**:
Spacewalk's existing compressed session payload. Here it exists only at the edges — written for a shareable URL, read when a session is loaded — never as the Room's own record.

**Snapshot URL**:
A link that opens one frozen view on the Viewer page with no Room, carrying a session block and, beside it, the viewer settings. Later changes in the Room do not reach it.
_Avoid_: Room link

**Share URL**:
The link the full Spacewalk app hands out, carrying a whole session, including IGV and Juicebox when present.
_Avoid_: Room link, snapshot URL

**Load**:
To replace everything a Room shows with what a session says.
_Avoid_: import, merge

**Save**:
To write what a Room shows now as a session. The Room carries on, and the session does not follow it.
_Avoid_: export, sync, checkpoint

### Changing it

**Proposal**:
A change to the viewer state offered by a Viewer (a hand change) or by a tool call. Only the Room applies a proposal, giving the result a new version.
_Avoid_: command, event, edit

**Relative step**:
A proposal phrased as a direction rather than a value — bigger balls, a darker background — applied by the Room to whatever the current value is.
_Avoid_: increment, nudge

**Realized**:
A Viewer's report that it has caught up to a version: drawn, or failed in the attempt.
_Avoid_: ack, confirmed, applied (the Room applies; a Viewer realizes)
