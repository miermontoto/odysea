import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
	DEFAULT_MANY_CONCURRENCY,
	DEFAULT_MANY_READ_CHARS,
	DEFAULT_READ_CHARS,
	MAX_MANY_CONCURRENCY,
	MAX_MANY_URLS,
	MAX_READ_CHARS,
} from '../constants.js'
import { dropLinks, fmtRead, readPage, slicePage, type PageRead } from '../markdown.js'
import type { Session } from '../session.js'
import { mapLimit, openForReading, selectorParam, tabIdParam, text, urlParam, withScratchTab } from '../shared.js'

const modeParam = z
	.enum(['main', 'full'])
	.optional()
	.describe('main (default): only the main content, the container holding most of the prose; full: the whole page minus navigation, banners and footers')

const linksParam = z
	.boolean()
	.optional()
	.describe('number the links and list their urls at the end, default true; false keeps only their text (cheaper, for sweeps)')

// con links: false, cada [texto][n] queda en texto y no se listan urls
const withLinks = (read: PageRead, links: boolean | undefined): PageRead => (links === false ? dropLinks(read) : read)

const charsParam = (byDefault: number) =>
	z.number().int().positive().max(MAX_READ_CHARS).optional().describe(`markdown characters to return, default ${byDefault}`)

// el primer renglón: los errores de playwright arrastran el call log entero
const firstLine = (err: unknown): string => String((err as Error).message ?? err).split('\n')[0]

export const registerRead = (server: McpServer, session: Session): void => {
	server.registerTool(
		'read_page',
		{
			title: 'Read page',
			description:
				'Read a page as markdown: its main content (or the whole page, or one element) with reference links [text][n] listed at the end, plus article metadata (published date, author, site). Long pages come in chunks: call again with the offset it gives; each call re-reads the live page. Prefer it over dom_snapshot to read articles, posts and threads, and dom_snapshot to find what to click.',
			inputSchema: {
				url: urlParam,
				tabId: tabIdParam,
				selector: selectorParam.optional().describe('read only this element, as is (no main-content detection)'),
				mode: modeParam,
				links: linksParam,
				offset: z.number().int().min(0).optional().describe('character offset to start from, as given at the end of a previous chunk'),
				maxChars: charsParam(DEFAULT_READ_CHARS),
			},
		},
		async ({ url, tabId, selector, mode, links, offset, maxChars }) => {
			const tab = await session.tab(tabId)
			const status = url ? await openForReading(session, tab, url) : undefined
			const read = withLinks(await readPage(tab, selector, mode ?? 'main'), links)
			const slice = slicePage(read, offset ?? 0, maxChars ?? DEFAULT_READ_CHARS)
			const more = (next: number): string => `read_page with offset=${next} (same tab and options)`
			return text(`${await tab.describe()}\n${fmtRead(read, slice, status, more)}`)
		},
	)

	server.registerTool(
		'read_many',
		{
			title: 'Read many pages',
			description: `Read up to ${MAX_MANY_URLS} urls in parallel, each in its own short-lived tab, and return each one's main content as markdown (like read_page, shorter by default). A url that fails or is not allowed reports its error without failing the rest. Use it to sweep several articles or threads at once; continue a long one with read_page.`,
			inputSchema: {
				urls: z.array(z.string()).min(1).max(MAX_MANY_URLS).describe('absolute urls'),
				mode: modeParam,
				links: linksParam,
				maxChars: charsParam(DEFAULT_MANY_READ_CHARS),
				concurrency: z
					.number()
					.int()
					.positive()
					.max(MAX_MANY_CONCURRENCY)
					.optional()
					.describe(`pages loading at once, default ${DEFAULT_MANY_CONCURRENCY}`),
			},
		},
		async ({ urls, mode, links, maxChars, concurrency }) => {
			// cada página en su tab de usar y tirar: la activa del agente no cambia
			const pages = await mapLimit(urls, concurrency ?? DEFAULT_MANY_CONCURRENCY, (url, i) =>
				withScratchTab(session, async (tab) => {
					const head = `## [${i + 1}/${urls.length}]`
					try {
						const status = await openForReading(session, tab, url)
						const read = withLinks(await readPage(tab, undefined, mode ?? 'main'), links)
						const slice = slicePage(read, 0, maxChars ?? DEFAULT_MANY_READ_CHARS)
						const title = await tab.page.title().catch(() => '')
						const more = (next: number): string => `read_page with url="${url}" and offset=${next}`
						return `${head} ${tab.page.url()}${title ? ` - ${title}` : ''}\n${fmtRead(read, slice, status, more)}`
					} catch (err) {
						return `${head} ${url}\nerror: ${firstLine(err)}`
					}
				}),
			)
			return text(pages.join('\n\n'))
		},
	)
}
