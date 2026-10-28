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
The Room's one versioned record of what its Viewers show: the loaded ensemble and its place in it, the structure appearance, the viewer settings, and the camera. The Room is its only author; Viewers are replicas.
_Avoid_: state document, session, model state

**Structure appearance**:
How the 3D structure is drawn, as distinct from the furniture around it: ball and stick radius steps, whether sticks show, point size and transparency, color ramp, circular genome. Shared by everyone in the Room.
_Avoid_: render settings, viewer settings (those are the furniture)

**Session string**:
Spacewalk's existing compressed session payload. Here it exists only at the edges — written for a shareable URL, read when a session is loaded — never as the Room's own record.

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
