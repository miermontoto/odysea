import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
	DEFAULT_FEED_LIMIT,
	DEFAULT_SUMMARY_CHARS,
	FEED_RULES,
	HTTP_ERROR_MIN,
	MAX_FEED_LIMIT,
	MAX_SUMMARY_CHARS,
	type FeedRules,
} from '../constants.js'
import type { Session } from '../session.js'
import { text, withScratchTab } from '../shared.js'

// feeds rss / atom / json como items compactos: la vía oficial para medios y fuentes que bloquean navegadores
// automatizados (los sirven a cualquier lector), y para sondear con `since` sin releer páginas

interface FeedItem {
	title?: string
	link?: string
	published?: string
	author?: string
	categories?: string[]
	summary?: string
	// guid o id, solo si el link no lo lleva ya
	id?: string
}

interface Feed {
	// rss, atom, rdf o json; null si no era un feed
	format: string | null
	title?: string
	items: FeedItem[]
	// sin feed: los que anuncia la página
	advertised: string[]
}

interface ParseArgs extends FeedRules {
	body: string
	base: string
	summaryChars: number
}

// corre en una tab en blanco de usar y tirar (page.evaluate), con el DOMParser del navegador: autocontenida
const parseFeed = (a: ParseArgs): Feed => {
	const clean = (s?: string | null): string | undefined => s?.replace(/\s+/g, ' ').trim() || undefined
	const absolute = (href?: string | null): string | undefined => {
		const raw = href?.trim()
		if (!raw) return undefined
		try {
			return new URL(raw, a.base).href
		} catch {
			return raw
		}
	}
	// fechas rfc 822 (rss) o iso (atom, json) a iso; una que no se entiende queda tal cual
	const iso = (s?: string): string | undefined => {
		if (!s) return undefined
		const t = Date.parse(s)
		return Number.isNaN(t) ? s : new Date(t).toISOString()
	}
	// el resumen suele venir como html escapado: su texto, recortado. un documento de DOMParser no ejecuta
	// scripts ni carga recursos
	const plain = (html?: string | null): string | undefined => {
		const t = clean(html ? new DOMParser().parseFromString(html, 'text/html').body.textContent : undefined)
		if (!t || !a.summaryChars) return undefined
		return t.length > a.summaryChars ? `${t.slice(0, a.summaryChars)}…` : t
	}
	const listed = <T>(xs: T[]): T[] | undefined => (xs.length ? xs : undefined)
	// un id que ya va dentro del link (el propio link, el token de google news) no aporta nada
	const withId = (item: FeedItem, id?: string): FeedItem => ({ ...item, id: id && !item.link?.includes(id) ? id : undefined })

	// json feed (jsonfeed.org)
	if (a.body.trimStart().startsWith('{')) {
		const j = JSON.parse(a.body) as { title?: unknown; items?: unknown }
		if (!Array.isArray(j.items)) return { format: null, items: [], advertised: [] }
		const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
		const nameOf = (v: unknown): string | undefined =>
			v && typeof v === 'object' ? str((v as Record<string, unknown>).name) : undefined
		return {
			format: 'json',
			title: clean(str(j.title)),
			advertised: [],
			items: (j.items as Record<string, unknown>[]).map((i) =>
				withId(
					{
						title: clean(str(i.title)),
						link: absolute(str(i.url) ?? str(i.external_url)),
						published: iso(str(i.date_published) ?? str(i.date_modified)),
						author: clean(nameOf(Array.isArray(i.authors) ? i.authors[0] : i.author)),
						categories: Array.isArray(i.tags) ? listed(i.tags.filter((t): t is string => typeof t === 'string')) : undefined,
						summary: plain(str(i.summary) ?? str(i.content_text) ?? str(i.content_html)),
					},
					str(i.id),
				),
			),
		}
	}

	// rss 2.0, rss 1.0 (rdf) y atom, por nombre local: los prefijos (dc:, content:, atom:) varían de un feed a otro
	const doc = new DOMParser().parseFromString(a.body, 'text/xml')
	const root = doc.documentElement
	const format = doc.querySelector(a.parseError) ? undefined : a.roots[root.localName]
	if (!format) {
		const page = new DOMParser().parseFromString(a.body, 'text/html')
		const advertised = Array.from(page.querySelectorAll(a.advertised), (l) => absolute(l.getAttribute('href')))
		return { format: null, items: [], advertised: advertised.filter((u): u is string => Boolean(u)) }
	}
	// el primer hijo con alguno de los nombres, en su orden de preferencia
	const named = (el: Element, names: readonly string[]): Element | undefined =>
		names.map((n) => Array.from(el.children).find((c) => c.localName === n)).find(Boolean)
	const all = (el: Element, names: readonly string[]): Element[] =>
		Array.from(el.children).filter((c) => names.includes(c.localName))
	// atom: el <link href> alternate (o sin rel); rss: el texto de <link>
	const linkOf = (item: Element): string | undefined => {
		const links = all(item, a.link)
		const hrefs = links.filter((l) => l.hasAttribute('href'))
		const best = hrefs.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate') ?? hrefs[0]
		return absolute(best ? best.getAttribute('href') : links[0]?.textContent)
	}
	const authorOf = (item: Element): string | undefined => {
		const el = named(item, a.author)
		return clean((el && named(el, [a.authorName]))?.textContent ?? el?.textContent)
	}
	const channel = Array.from(root.children).find((c) => c.localName === a.channel) ?? root
	return {
		format,
		title: clean(named(channel, a.title)?.textContent),
		advertised: [],
		items: a.item
			.flatMap((n) => Array.from(doc.getElementsByTagNameNS('*', n)))
			.map((item) =>
				withId(
					{
						title: clean(named(item, a.title)?.textContent),
						link: linkOf(item),
						published: iso(clean(named(item, a.published)?.textContent)),
						author: authorOf(item),
						categories: listed(
							all(item, a.category)
								.map((c) => clean(c.getAttribute('term') ?? c.textContent))
								.filter((c): c is string => Boolean(c)),
						),
						summary: plain(named(item, a.summary)?.textContent),
					},
					clean(named(item, a.id)?.textContent),
				),
			),
	}
}

export const registerFeed = (server: McpServer, session: Session): void => {
	server.registerTool(
		'read_feed',
		{
			title: 'Read feed',
			description:
				'Read an RSS, Atom or JSON feed as compact JSON items (title, link, published, author, categories, summary, id) in the order the feed lists them. Pass `since` when polling to keep only newer items. Given a web page instead, it lists the feeds the page advertises. It is a plain HTTP request that identifies itself as odysea, not as a browser, so it reaches feeds of sites that block automated browsers; it goes through the same origin allowlist. Open the items with read_many or read_page.',
			inputSchema: {
				url: z.string().describe('feed url, or a page that advertises its feeds'),
				since: z
					.string()
					.optional()
					.describe('ISO date or date-time: only items published after it (undated items are left out)'),
				offset: z.number().int().min(0).optional().describe('first item to return'),
				limit: z.number().int().positive().max(MAX_FEED_LIMIT).optional().describe(`items to return, default ${DEFAULT_FEED_LIMIT}`),
				summaryChars: z
					.number()
					.int()
					.min(0)
					.max(MAX_SUMMARY_CHARS)
					.optional()
					.describe(`summary length per item, default ${DEFAULT_SUMMARY_CHARS}; 0 leaves summaries out`),
			},
		},
		async ({ url, since, offset, limit, summaryChars }) => {
			const cutoff = since === undefined ? undefined : Date.parse(since)
			if (cutoff !== undefined && Number.isNaN(cutoff)) throw new Error(`since must be an ISO date, got "${since}"`)
			const res = await session.fetch(url)
			const [status, final, type] = [res.status(), res.url(), res.headers()['content-type'] ?? 'no content-type']
			const body = await res.text()
			await res.dispose()
			if (status >= HTTP_ERROR_MIN) throw new Error(`HTTP ${status} fetching ${final}`)
			const feed = await withScratchTab(session, (tab) =>
				tab.page.evaluate(parseFeed, {
					...FEED_RULES,
					body,
					base: final,
					summaryChars: summaryChars ?? DEFAULT_SUMMARY_CHARS,
				}),
			)
			if (!feed.format) {
				if (!feed.advertised.length) throw new Error(`not a feed, and the page advertises none: ${final} (${type})`)
				return text(`not a feed: ${final} advertises\n${feed.advertised.join('\n')}`)
			}
			const kept =
				cutoff === undefined
					? feed.items
					: feed.items.filter((i) => i.published !== undefined && Date.parse(i.published) > cutoff)
			const from = offset ?? 0
			const rows = kept.slice(from, from + (limit ?? DEFAULT_FEED_LIMIT))
			const to = from + rows.length
			const head = [
				feed.title ?? final,
				feed.format,
				`HTTP ${status}`,
				`${kept.length} item(s)${since ? ` after ${since}` : ''}`,
				...(rows.length ? [`rows ${from}–${to}`] : []),
			].join(' · ')
			const more = kept.length > to ? `\n… ${kept.length - to} more: read_feed with offset=${to}` : ''
			return text(`${head}\n${final}\n${rows.map((r) => JSON.stringify(r)).join('\n')}${more}`)
		},
	)
}
