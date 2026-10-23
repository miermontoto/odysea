import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Locator } from 'playwright'
import { z } from 'zod'
import {
	DEFAULT_EXTRACT_LIMIT,
	DEFAULT_LOAD_ROUNDS,
	FIELD_ATTR_RE,
	LOAD_POLL_MS,
	LOAD_SETTLE_MS,
	MAX_EXTRACT_LIMIT,
	MAX_FIELD_CHARS,
	MAX_LOAD_ROUNDS,
	READ_SETTLE_MS,
	SELF_FIELD,
	URL_ATTRS,
} from '../constants.js'
import type { Session, Tab } from '../session.js'
import { openForReading, selectorParam, tabIdParam, text, urlParam } from '../shared.js'

// qué leer de cada item: su texto o un atributo, del propio item (css null) o de su primer descendiente que case
interface Field {
	css: string | null
	attr: string | null
}

// "css", "css@attr", "@attr" o "."; una @ cuyo resto no parece un atributo es parte del selector
const parseField = (spec: string): Field => {
	const at = spec.lastIndexOf('@')
	const attr = at >= 0 && FIELD_ATTR_RE.test(spec.slice(at + 1)) ? spec.slice(at + 1) : null
	const css = (attr ? spec.slice(0, at) : spec).trim()
	return { css: css && css !== SELF_FIELD ? css : null, attr }
}

interface RowsArgs {
	fields: [string, Field][]
	offset: number
	limit: number
	maxChars: number
	urlAttrs: readonly string[]
}

type Row = Record<string, string | null>

// corre dentro de la página sobre todos los items (locator.evaluateAll): autocontenida
const readRows = (items: Element[], a: RowsArgs): { total: number; rows: Row[] } => {
	const value = (item: Element, f: Field): string | null => {
		const el = f.css ? item.querySelector(f.css) : item
		if (!el) return null
		if (!f.attr) return ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, a.maxChars)
		const raw = el.getAttribute(f.attr)
		if (raw === null || !a.urlAttrs.includes(f.attr)) return raw?.slice(0, a.maxChars) ?? null
		try {
			return new URL(raw, document.baseURI).href
		} catch {
			return raw
		}
	}
	return {
		total: items.length,
		rows: items
			.slice(a.offset, a.offset + a.limit)
			.map((item) => Object.fromEntries(a.fields.map(([name, f]) => [name, value(item, f)]))),
	}
}

type Stop = 'count' | 'rounds' | 'button' | 'stalled'

interface LoadGoal {
	count: number
	rounds: number
	button?: string
}

interface Loaded {
	n: number
	rounds: number
	stop: Stop
}

// un paso: clic en el botón (si no reaparece visible, se acabó) o el último item al fondo y una pantalla más,
// que es lo que dispara los IntersectionObserver de un feed infinito
const advance = async (tab: Tab, items: Locator, n: number, button?: string): Promise<boolean> => {
	if (button) {
		const target = tab.locate(button).first()
		const shown = await target.waitFor({ state: 'visible', timeout: LOAD_SETTLE_MS }).then(
			() => true,
			() => false,
		)
		if (shown) await target.click()
		return shown
	}
	if (n) await items.last().evaluate((el) => el.scrollIntoView({ block: 'end' }))
	await tab.page.evaluate(() => window.scrollBy(0, window.innerHeight))
	return true
}

// cuenta hasta que haya más de `from` items o venza el plazo
const grown = async (tab: Tab, items: Locator, from: number, deadline: number): Promise<number> => {
	const n = await items.count()
	if (n > from || Date.now() >= deadline) return n
	await tab.page.waitForTimeout(LOAD_POLL_MS)
	return grown(tab, items, from, deadline)
}

const load = async (tab: Tab, items: Locator, goal: LoadGoal, done = 0, known?: number): Promise<Loaded> => {
	const n = known ?? (await items.count())
	if (n >= goal.count) return { n, rounds: done, stop: 'count' }
	if (done >= goal.rounds) return { n, rounds: done, stop: 'rounds' }
	if (!(await advance(tab, items, n, goal.button))) return { n, rounds: done, stop: 'button' }
	const next = await grown(tab, items, n, Date.now() + LOAD_SETTLE_MS)
	return next > n ? load(tab, items, goal, done + 1, next) : { n: next, rounds: done + 1, stop: 'stalled' }
}

const why = (stop: Stop, goal: LoadGoal): string =>
	({
		count: `reached ${goal.count}`,
		rounds: `stopped after ${goal.rounds} round(s)`,
		button: 'the load-more button is gone or hidden',
		stalled: `nothing new ${LOAD_SETTLE_MS} ms after the last round (end of the feed, or a list that recycles its nodes: extract between rounds there)`,
	})[stop]

export const registerExtract = (server: McpServer, session: Session): void => {
	server.registerTool(
		'extract',
		{
			title: 'Extract',
			description:
				'Pull structured rows out of a page: one JSON object per element matching `items`, one value per field. A field is a css selector inside the item ("a.title") for its text, "selector@attr" for an attribute ("a.title@href"; urls come back absolute), "@attr" for the item\'s own attribute or "." for the item\'s own text; a field that finds nothing is null. Find the selectors first with dom_query or dom_snapshot; grow a feed first with load_more.',
			inputSchema: {
				items: selectorParam.describe('the repeating element, one per row (playwright syntax or a ref=eN)'),
				fields: z.record(z.string(), z.string()).describe('field name → "css", "css@attr", "@attr" or "."'),
				url: urlParam,
				tabId: tabIdParam,
				offset: z.number().int().min(0).optional().describe('first row to return'),
				limit: z.number().int().positive().max(MAX_EXTRACT_LIMIT).optional().describe(`rows to return, default ${DEFAULT_EXTRACT_LIMIT}`),
			},
		},
		async ({ items, fields, url, tabId, offset, limit }) => {
			const specs = Object.entries(fields)
			if (!specs.length) throw new Error('fields is empty, name at least one, e.g. {"title": "a"}')
			const tab = await session.tab(tabId)
			const locator = tab.locate(items)
			// recién abierta, una spa puede pintar los items después de load: se les da un margen acotado
			if (url) {
				await openForReading(session, tab, url)
				await locator.first().waitFor({ timeout: READ_SETTLE_MS }).catch(() => {})
			}
			const from = offset ?? 0
			const { total, rows } = await locator.evaluateAll(readRows, {
				fields: specs.map(([name, spec]): [string, Field] => [name, parseField(spec)]),
				offset: from,
				limit: limit ?? DEFAULT_EXTRACT_LIMIT,
				maxChars: MAX_FIELD_CHARS,
				urlAttrs: URL_ATTRS,
			})
			const to = from + rows.length
			const head = `${await tab.describe()}\n${total} item(s) for ${items}${rows.length ? ` · rows ${from}–${to}` : ''}`
			const more = total > to ? `\n… ${total - to} more: extract with offset=${to}` : ''
			return text(`${head}\n${rows.map((r) => JSON.stringify(r)).join('\n')}${more}`)
		},
	)

	server.registerTool(
		'load_more',
		{
			title: 'Load more',
			description:
				'Grow a feed or list that loads more on scroll or with a "load more" button, in one call: repeats until at least `count` elements match `items`, nothing new appears or the rounds run out, and says how many there are. Then read them with extract or read_page. Feeds that recycle their nodes (virtualized lists) never grow: extract between rounds there.',
			inputSchema: {
				items: selectorParam.describe('the elements the feed adds, e.g. "article" or ".comment"'),
				count: z.number().int().positive().describe('stop once at least this many match'),
				button: selectorParam.optional().describe('a button that appends more items in place, clicked each round; without it, scrolls'),
				rounds: z.number().int().positive().max(MAX_LOAD_ROUNDS).optional().describe(`most rounds to try, default ${DEFAULT_LOAD_ROUNDS}`),
				tabId: tabIdParam,
			},
		},
		async ({ items, count, button, rounds, tabId }) => {
			const tab = await session.tab(tabId)
			const goal = { count, rounds: rounds ?? DEFAULT_LOAD_ROUNDS, button }
			const loaded = await load(tab, tab.locate(items), goal)
			return text(
				`${loaded.n} item(s) for ${items} after ${loaded.rounds} round(s): ${why(loaded.stop, goal)} - ${await tab.describe()}`,
			)
		},
	)
}
