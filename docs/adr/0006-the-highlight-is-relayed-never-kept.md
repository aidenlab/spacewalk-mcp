# The highlight is relayed, never kept

A **highlight** links genomic space and 3D space, and that link has to hold in every Viewer of a Room, not just the one where a person is pointing. So the Room relays each highlight from the pointing Viewer to the others, and every Viewer draws it as if its own person were pointing: the navigator strip and the active render style together. The Room stores none of it. A highlight is not viewer state: it has no version, is never saved, is not news to the model, and no tool reads or sets it. This is the second exception to ADR 0001's rejection of relaying between pages, after the camera in ADR 0005, and the first message that streams: it is sent while the pointer moves, not once on release.

Each highlight names its trace, and a Viewer showing another trace drops it. That only happens in the moment after a step, since every Viewer shows the trace the Room holds. A step clears every shared highlight.

## Considered Options

- **Keep the highlight in the viewer state.** Rejected: every mouse move would be a versioned proposal, flooding the Room and the model's news with something that lasts milliseconds.
- **Keep the last highlight in the Room, for Viewers that join mid-point.** Rejected: it would be a stored record of something nobody needs to read back, and the pointer's next move brings a newcomer up to date within milliseconds.
- **Send only when the highlight moves to another region.** Rejected: the ribbon's bead glides continuously, and would jump on remote screens.
- **Show everyone's highlight at once, one per person.** Rejected for now: the Room has no idea of who is who, and one highlight at a time keeps a single notion of the locus being pointed at.
- **Map a highlight onto another trace by genomic position.** Rejected: all Viewers show the same trace, so the only mismatch is momentary, and traces can differ in regions and gaps.

## Consequences

- One highlight shows at a time and the last person to move wins, but a person's own highlight always wins on their own screen. When it ends, the latest remote highlight, if still live, comes back at once.
- Sending is throttled to about one message per animation frame. The final position and the clear are never dropped.
- The Room remembers, on the socket, which Viewer highlighted last. When that socket closes it sends a clear, so a vanished pointer cannot leave a highlight stuck.
- A Viewer that joins mid-point sees nothing until the pointer's next move.
- A remote highlight looks the same as one's own.
