/**
 * The Join card: the project's only MCP App (SEP-1865), shown in the
 * Conversation by Hosts that render MCP Apps when `open_viewer` is called. One
 * line of status and an "Open Spacewalk" button; the button opens the Join link
 * through the Host (`ui/open-link`), which Claude desktop routes to its Side
 * panel. It never holds the 3D viewer: the Host's sandbox forbids framing other
 * origins. Hosts without MCP Apps ignore the metadata and use the text link.
 *
 * The card is one self-contained document served by the Worker, so its styles
 * are inline CSS rather than Sass; class names are still BEM.
 */

export const JOIN_CARD_URI = 'ui://spacewalk/join'
export const JOIN_CARD_MIME_TYPE = 'text/html;profile=mcp-app'

/** The MCP Apps client the card loads, at a pinned version. */
const APP_CLIENT = 'https://unpkg.com/@modelcontextprotocol/ext-apps@1.7.5/dist/src/app-with-deps.js'

/** `_meta` for the resource: the sandbox may load the client and nothing else. */
export const JOIN_CARD_META = { ui: { csp: { resourceDomains: [new URL(APP_CLIENT).origin] } } }

/** `_meta` for the tool: the current key and the flat one older Hosts read. */
export const JOIN_CARD_TOOL_META = { ui: { resourceUri: JOIN_CARD_URI }, 'ui/resourceUri': JOIN_CARD_URI }

/** What `open_viewer` hands the card as `structuredContent`. */
export interface JoinCardContent {
  [key: string]: unknown
  room: string
  joinUrl: string
}

export const JOIN_CARD_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Spacewalk</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 0; padding: 12px; }
  .join-card { display: flex; flex-direction: column; gap: 8px; min-width: 200px; }
  .join-card__open { align-self: flex-start; padding: 10px 18px; font-size: 15px; }
</style></head>
<body>
<div class="join-card">
  <div class="join-card__status" role="status">Waiting for the Join link…</div>
  <button class="join-card__open" hidden>Open Spacewalk</button>
</div>
<script type="module">
  import { App } from "${APP_CLIENT}";
  const statusElement = document.querySelector(".join-card__status");
  const openButton = document.querySelector(".join-card__open");
  const app = new App({ name: "Spacewalk", version: "1.0.0" });
  let joinUrl;
  const render = () => {
    let ctx;
    try { ctx = app.getHostContext?.(); } catch (e) { ctx = undefined; }
    if (!joinUrl) return;
    statusElement.textContent = ctx?.platform === "desktop"
      ? "Spacewalk is opening in the panel on the right, which can take half a minute. Only if it has not appeared by then, press Open Spacewalk; if Claude then asks, choose “Always allow for this website”."
      : "Spacewalk is ready.";
    openButton.hidden = false;
  };
  app.ontoolresult = ({ structuredContent: sc, content }) => {
    joinUrl = sc?.joinUrl ?? content?.find((c) => c.type === "text")?.text.match(/https?:\\/\\/\\S+/)?.[0];
    if (!joinUrl) { statusElement.textContent = "No Join link in the tool result."; return; }
    render();
  };
  app.onhostcontextchanged = render;
  openButton.onclick = () => { if (joinUrl) app.openLink({ url: joinUrl }); };
  await app.connect();
  render();
</script>
</body></html>`
