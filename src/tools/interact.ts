import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { MAX_WAIT_TIME_MS, RECENT_RESPONSE_WINDOW_MS, SCROLL_STEP_PX } from '../constants.js'
import type { NetworkEntry, Session, Tab } from '../session.js'
import { selectorParam, tabIdParam, text } from '../shared.js'

const fmtNetworkResult = (entry: NetworkEntry | undefined, fallback: string): string =>
	entry ? `[${entry.id}] ${entry.failure ? `FAILED(${entry.failure})` : entry.status} ${entry.method} ${entry.url}` : fallback

// espera una respuesta cuya url contenga el patrón, resolviendo dos trampas: la respuesta pudo llegar
// entre dos tool calls (se revisa el log reciente primero) y un request fallido nunca produce respuesta
// (se compite contra requestfailed para no colgar hasta el timeout justo en los casos que se depuran)
const awaitResponse = async (tab: Tab, urlPattern: string): Promise<string> => {
	// completada = con status o failure; no exigir durationMs porque requestfinished llega tras el body
	// y la segunda tool call puede colarse en ese hueco
	const recent = tab.network.findLast(
		(e) =>
			e.url.includes(urlPattern) &&
			(e.status !== undefined || e.failure !== undefined) &&
			e.startedAt + (e.durationMs ?? 0) >= Date.now() - RECENT_RESPONSE_WINDOW_MS,
	)
	if (recent) return `${fmtNetworkResult(recent, '')} (already completed)`
	const pResponse = tab.page
		.waitForResponse((r) => r.url().includes(urlPattern))
		.then((r) => ({ request: r.request(), fallback: `${r.status()} ${r.url()}` }))
	const pFailed = tab.page
		.waitForEvent('requestfailed', { predicate: (req) => req.url().includes(urlPattern) })
		.then((req) => ({ request: req, fallback: `FAILED ${req.url()}` }))
	const winner = Promise.race([pResponse, pFailed])
	// el perdedor rechazará al agotar su timeout; sin esto sería un unhandled rejection
	pResponse.catch(() => {})
	pFailed.catch(() => {})
	const { request, fallback } = await winner
	return fmtNetworkResult(
		tab.network.find((e) => e.request === request),
		fallback,
	)
}

export const registerInteract = (server: McpServer, session: Session): void => {
	server.registerTool(
		'click',
		{
			title: 'Click',
			description:
				'Click an element (auto-waits for it to be visible and stable). The selector must resolve to exactly one element; refine it if playwright reports multiple matches.',
			inputSchema: {
				selector: selectorParam,
				tabId: tabIdParam,
				button: z.enum(['left', 'right', 'middle']).optional(),
				doubleClick: z.boolean().optional(),
			},
		},
		async ({ selector, tabId, button, doubleClick }) => {
			const tab = await session.tab(tabId)
			const locator = tab.locate(selector)
			await (doubleClick ? locator.dblclick({ button }) : locator.click({ button }))
			return text(`clicked ${selector} - ${await tab.describe()}`)
		},
	)

	server.registerTool(
		'fill',
		{
			title: 'Fill',
			description: 'Clear an input, textarea or contenteditable and type a value into it.',
			inputSchema: { selector: selectorParam, value: z.string(), tabId: tabIdParam },
		},
		async ({ selector, value, tabId }) => {
			const tab = await session.tab(tabId)
			await tab.locate(selector).fill(value)
			return text(`filled ${selector} - ${await tab.describe()}`)
		},
	)

	server.registerTool(
		'press_key',
		{
			title: 'Press key',
			description: 'Press a key or combination, on an element or on the page keyboard.',
			inputSchema: {
				key: z.string().describe('playwright key name, e.g. Enter, Escape, Tab, Control+a'),
				selector: selectorParam.optional().describe('focus this element first'),
				tabId: tabIdParam,
			},
		},
		async ({ key, selector, tabId }) => {
			const tab = await session.tab(tabId)
			await (selector ? tab.locate(selector).press(key) : tab.page.keyboard.press(key))
			return text(`pressed ${key} - ${await tab.describe()}`)
		},
	)

	server.registerTool(
		'select_option',
		{
			title: 'Select option',
			description: 'Select one or more options of a <select> element by their value attribute.',
			inputSchema: {
				selector: selectorParam,
				values: z.array(z.string()).min(1).describe('value attributes of the options to select'),
				tabId: tabIdParam,
			},
		},
		async ({ selector, values, tabId }) => {
			const tab = await session.tab(tabId)
			const selected = await tab.locate(selector).selectOption(values)
			return text(`selected [${selected.join(', ')}] in ${selector} - ${await tab.describe()}`)
		},
	)

	server.registerTool(
		'hover',
		{
			title: 'Hover',
			description: 'Hover the mouse over an element, e.g. to open menus or reveal tooltips.',
			inputSchema: { selector: selectorParam, tabId: tabIdParam },
		},
		async ({ selector, tabId }) => {
			const tab = await session.tab(tabId)
			await tab.locate(selector).hover()
			return text(`hovering ${selector} - ${await tab.describe()}`)
		},
	)

	server.registerTool(
		'scroll',
		{
			title: 'Scroll',
			description: 'Scroll an element into view, or scroll the page vertically by an amount of pixels.',
			inputSchema: {
				tabId: tabIdParam,
				selector: selectorParam.optional().describe('scroll this element into view instead'),
				dy: z.number().int().optional().describe(`pixels to scroll, negative scrolls up, default ${SCROLL_STEP_PX}`),
			},
		},
		async ({ tabId, selector, dy }) => {
			const tab = await session.tab(tabId)
			if (selector) {
				await tab.locate(selector).scrollIntoViewIfNeeded()
				return text(`scrolled ${selector} into view`)
			}
			const amount = dy ?? SCROLL_STEP_PX
			// scrollBy en vez de mouse.wheel para que funcione igual en los tres engines
			await tab.page.evaluate((px) => window.scrollBy(0, px), amount)
			return text(`scrolled by ${amount}px`)
		},
	)

	server.registerTool(
		'handle_dialog',
		{
			title: 'Handle dialog',
			description:
				'Arm the response for the NEXT js dialog (alert/confirm/prompt) in a tab; call it BEFORE the action that triggers the dialog. One-shot: it reverts to the default afterwards. Unarmed dialogs are auto-dismissed and logged in console_messages as [dialog].',
			inputSchema: {
				action: z.enum(['accept', 'dismiss']),
				promptText: z.string().optional().describe('text to enter when accepting a prompt'),
				tabId: tabIdParam,
			},
		},
		async ({ action, promptText, tabId }) => {
			const tab = await session.tab(tabId)
			tab.dialogAction = { accept: action === 'accept', promptText }
			return text(
				`next dialog in tab ${tab.id} will be ${action === 'accept' ? 'accepted' : 'dismissed'}${promptText !== undefined ? ` with "${promptText}"` : ''}`,
			)
		},
	)

	server.registerTool(
		'wait_for',
		{
			title: 'Wait for',
			description:
				'Wait for an element state, a network response, a page load state and/or a fixed time. Use after actions that trigger async ui updates or api calls.',
			inputSchema: {
				tabId: tabIdParam,
				selector: selectorParam.optional(),
				state: z
					.enum(['visible', 'hidden', 'attached', 'detached'])
					.optional()
					.describe('element state to wait for when selector is given, default visible'),
				urlPattern: z
					.string()
					.optional()
					.describe(
						'wait until a network response whose url contains this substring arrives (e.g. "/api/save"); reports its status and request id, or the failure if the request never completes',
					),
				loadState: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
				timeMs: z.number().int().positive().max(MAX_WAIT_TIME_MS).optional().describe('fixed wait in milliseconds'),
			},
		},
		async ({ tabId, selector, state, urlPattern, loadState, timeMs }) => {
			if (!selector && !urlPattern && !loadState && !timeMs)
				throw new Error('provide at least one of selector, urlPattern, loadState or timeMs')
			const tab = await session.tab(tabId)
			if (selector) await tab.locate(selector).waitFor({ state: state ?? 'visible' })
			const network = urlPattern ? `\nnetwork: ${await awaitResponse(tab, urlPattern)}` : ''
			if (loadState) await tab.page.waitForLoadState(loadState)
			if (timeMs) await tab.page.waitForTimeout(timeMs)
			return text(`wait complete - ${await tab.describe()}${network}`)
		},
	)
}
