/**
 * The example ensembles: the full Spacewalk app's Load From List, a curated JSON manifest of
 * hosted `.sw` files at the root of the Spacewalk R2 bucket (spacewalk
 * `development-notes/cloudflare-storage/`). Fetched when a tool asks for it, so an edit to the
 * manifest reaches the model without a deploy, and kept a few minutes.
 */
import { z } from 'zod'

/** Where the full app reads its Load From List (spacewalk `src/spacewalkFileLoadWidgetServices.js`). */
export const EXAMPLE_ENSEMBLES_URL = 'https://pub-398373e8d1204c57beab2ae62ef6cc91.r2.dev/load-from-list.json'

/** How long a fetched list is kept before the next ask fetches it again. */
const KEEP_MS = 5 * 60_000

const ExampleList = z.object({
  groups: z.array(
    z.object({
      label: z.string(),
      files: z.array(z.object({ name: z.string(), url: z.string() })),
    }),
  ),
})
export type ExampleList = z.infer<typeof ExampleList>

/** The example list, fetched or kept; it throws when the list cannot be had. */
export type ExampleEnsembles = () => Promise<ExampleList>

export interface ExampleEnsemblesDeps {
  fetch?: (url: string) => Promise<Response>
  /** The time now, in ms; a test moves it on. */
  now?: () => number
}

/** The example list from R2, each fetched list kept for KEEP_MS. A failed fetch is not kept. */
export function exampleEnsembles({
  fetch = (url) => globalThis.fetch(url),
  now = Date.now,
}: ExampleEnsemblesDeps = {}): ExampleEnsembles {
  let kept: { list: ExampleList; at: number } | null = null
  return async () => {
    if (kept && now() - kept.at < KEEP_MS) return kept.list
    const response = await fetch(EXAMPLE_ENSEMBLES_URL)
    if (!response.ok) throw new Error(`${EXAMPLE_ENSEMBLES_URL} answered HTTP ${response.status}`)
    const list = ExampleList.parse(await response.json())
    kept = { list, at: now() }
    return list
  }
}

/** The list as the model reads it: each group in order, its ensembles by name as the full app sorts them. */
export function exampleListReply({ groups }: ExampleList): string {
  const sections = groups.map(({ label, files }) => {
    const sorted = files.toSorted((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    return [`${label}:`, ...sorted.map(({ name, url }) => `- ${name}: ${url}`)].join('\n')
  })
  return ['The example ensembles, by group. Load one by passing its URL to load_ensemble.', ...sections].join('\n\n')
}
