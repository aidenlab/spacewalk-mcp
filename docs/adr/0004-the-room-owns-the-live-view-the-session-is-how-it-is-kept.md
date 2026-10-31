# The Room owns the live view; the session is how it is kept

A Room does not supersede Spacewalk's session. The Room is the running authority on what its Viewers show now, and it lasts only until it expires. A session is a saved document that does not change, covers the whole app (Spacewalk, and IGV and Juicebox when present), and outlasts any Room. We keep both, and state crosses between them only by explicit conversion: **loading** a session into a Room, and **saving** a Room as a session.

See [Rooms and sessions](../rooms-and-sessions.html) for what this means for people using them, and for the save experience that is still to be designed.

## Considered Options

- **The Room supersedes the session, with viewer state as the one format.** Rejected: the session predates this project and remains the full app's way to save and share. Its session strings are also a contract shared with Juicebox, and viewer state has nowhere to put IGV or Juicebox.
- **The Room's record is a session.** Rejected in ADR 0001: the Room could not apply a single change without a Viewer.
- **The session grows to carry Room concerns such as versions.** Rejected: those mean nothing at rest, and every reader of the format would have to ignore them.

## Consequences

- A session is the only way a Room's contents outlast its expiry, so saving is a core part of using a Room, not an export feature.
- A save records the Room at one moment. The Room keeps no history, so a view that was not saved when it was on screen cannot be recovered later.
- The two formats overlap on the 3D scene and differ elsewhere, so conversion can lose information. A Room does not keep a session's IGV, Juicebox, locus or panel state.
- Adding to viewer state means deciding whether the new field also travels in a session, beside it, or not at all.
