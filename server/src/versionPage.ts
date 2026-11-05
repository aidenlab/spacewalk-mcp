/**
 * GET /version as a person sees it in a browser: the same answer as the JSON, laid out as a page in
 * the visual language of geenee's own pages (aidenlab/geenee src/page.ts, its /versions): its tokens
 * and fonts, light and dark. The JSON stays the answer for everything else. One self-contained
 * document served by the Worker, so its styles are inline CSS; class names are BEM.
 */

const escapeHtml = (text: unknown) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const FONTS =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400&family=IBM+Plex+Sans:wght@500;600&family=Source+Serif+4:opsz,wght@8..60,400&display=swap'

const STYLE = `
:root {
  --bg: #f5f6f4; --box: #ffffff; --fg: #1b1d1c; --muted: #636966; --rule: #cdd2ce;
  --serif: "Source Serif 4", "Iowan Old Style", Georgia, serif;
  --sans: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #151716; --box: #1e2120; --fg: #e5e7e4; --muted: #9aa19c; --rule: #3b403d; color-scheme: dark; }
}
body { margin: 0; background: var(--bg); color: var(--fg); font: 1.0625rem/1.6 var(--serif); }
.versions {
  max-width: 42rem; margin-inline: auto;
  padding: 12vh max(16px, env(safe-area-inset-right, 0px)) 4rem max(16px, env(safe-area-inset-left, 0px));
}
.versions__brand { font: 400 0.85rem var(--mono); color: var(--muted); margin: 0 0 1rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--rule); }
.versions__title { font: 600 2rem/1.15 var(--sans); letter-spacing: -0.01em; margin: 0 0 0.75rem; }
.versions__lede { font-size: 1.2rem; line-height: 1.5; color: var(--muted); margin: 0 0 2.25rem; text-wrap: pretty; }
.versions code { font-family: var(--mono); font-size: 0.9em; }
.versions a { color: inherit; text-decoration-color: var(--rule); text-underline-offset: 0.15em; }
.versions a:hover { text-decoration-color: currentColor; }
.versions__table { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
.versions__table th, .versions__table td { text-align: left; padding: 0.55rem 1rem 0.55rem 0; border-bottom: 1px solid var(--rule); vertical-align: baseline; }
.versions__table thead th { font: 500 0.8rem var(--sans); color: var(--muted); }
.versions__table tbody th { font: 600 0.95rem var(--sans); }
.versions__table td code { overflow-wrap: anywhere; }
.versions__host { color: var(--muted); }
.versions__absent { font: 500 0.9rem var(--sans); color: var(--muted); }
.versions__extra { display: block; margin-top: 0.15rem; font: 400 0.8rem var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.versions__footer { margin-top: 3rem; padding-top: 0.75rem; border-top: 1px solid var(--rule); font: 0.8rem/1.45 var(--sans); color: var(--muted); }
`

/** What GET /version answers as JSON. */
export interface VersionBody {
  worker: string
  protocol: number
  viewer: { url: string; version?: unknown; error?: string; [key: string]: unknown }
}

/** The page for the Worker at `origin`, from `body`, the JSON /version answers. */
export function versionPage(origin: string, { worker, protocol, viewer }: VersionBody): string {
  const { url: viewerUrl, version: viewerVersion, error, ...viewerExtra } = viewer
  // What else each reports beyond its version (the protocol, the Remote's version), so nothing the JSON says is lost.
  const extra = (fields: Record<string, unknown>) => {
    const entries = Object.entries(fields)
    if (entries.length === 0) return ''
    const text = entries
      .map(([key, value]) => `${escapeHtml(key)} ${escapeHtml(typeof value === 'string' ? value : JSON.stringify(value))}`)
      .join(' · ')
    return `<span class="versions__extra">${text}</span>`
  }
  const row = (name: string, url: string, version: unknown, fields: Record<string, unknown>, failure?: string) => `
      <tr>
        <th scope="row">${name}</th>
        <td>${
          version === undefined
            ? `<span class="versions__absent">could not be read: ${escapeHtml(failure ?? 'version.json names no version')}</span>`
            : `<code>${escapeHtml(version)}</code>`
        }${extra(fields)}</td>
        <td><a class="versions__host" href="${escapeHtml(url)}"><code>${escapeHtml(new URL(url).host)}</code></a></td>
      </tr>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Spacewalk versions</title>
<meta name="description" content="The version of this Spacewalk MCP Worker and of the Viewer page it serves.">
<link rel="stylesheet" href="${FONTS}">
<style>${STYLE}</style>
</head>
<body>
<main class="versions">
  <p class="versions__brand">${escapeHtml(new URL(origin).host)}</p>
  <h1 class="versions__title">Versions</h1>
  <p class="versions__lede">What this Spacewalk Deployment runs: its MCP Worker, and the Viewer page as it reported when this page loaded.</p>
  <table class="versions__table">
    <thead><tr><td></td><th scope="col">Version</th><th scope="col">Address</th></tr></thead>
    <tbody>${row('Worker', `${origin}/mcp`, worker, { protocol })}${row('Viewer page', new URL('.', viewerUrl).href, viewerVersion, viewerExtra, error)}
    </tbody>
  </table>
  <footer class="versions__footer">Each version is a tag or branch and its commit. Reload to ask again. Scripts get this as JSON (any request that does not ask for HTML).</footer>
</main>
</body>
</html>
`
}
