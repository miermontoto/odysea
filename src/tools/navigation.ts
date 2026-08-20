import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { MAX_VIEWPORT_PX, MIN_VIEWPORT_PX } from '../constants.js'
import type { Session } from '../session.js'
import { tabIdParam, text } from '../shared.js'

const waitUntilParam = z
	.enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
	.optional()
	.describe('lifecycle event to wait for, default load (use networkidle for SPAs that fetch on boot)')

const requireId = (tabId?: number): number => {
	if (tabId === undefined) throw new Error('tabId is required for this action')
	return tabId
}

export const registerNavigation = (server: McpServer, session: Session): void => {
	server.registerTool(
		'navigate',
		{
			title: 'Navigate',
			description: 'Open a url in a tab (creates the first tab automatically). Returns http status, final url and title.',
			inputSchema: {
				url: z.string().describe('absolute url, e.g. http://localhost:5173'),
				tabId: tabIdParam,
				waitUntil: waitUntilParam,
			},
		},
		async ({ url, tabId, waitUntil }) => {
			const tab = await session.tab(tabId)
			const res = await tab.page.goto(url, { waitUntil })
			return text(`${res ? `HTTP ${res.status()} - ` : ''}${await tab.describe()}`)
		},
	)

	server.registerTool(
		'reload',
		{
			title: 'Reload',
			description: 'Reload the current page of a tab.',
			inputSchema: { tabId: tabIdParam, waitUntil: waitUntilParam },
		},
		async ({ tabId, waitUntil }) => {
			const tab = await session.tab(tabId)
			await tab.page.reload({ waitUntil })
			return text(await tab.describe())
		},
	)

	server.registerTool(
		'back',
		{
			title: 'Go back',
			description: 'Go back one entry in the tab history.',
			inputSchema: { tabId: tabIdParam },
		},
		async ({ tabId }) => {
			const tab = await session.tab(tabId)
			const res = await tab.page.goBack()
			return text(res ? await tab.describe() : `no previous page in history - ${await tab.describe()}`)
		},
	)

	server.registerTool(
		'tabs',
		{
			title: 'Tabs',
			description:
				'Manage tabs: list them, open a new one, select the active one or close one. Popups opened by the page (window.open, target=_blank) show up in the list too.',
			inputSchema: {
				action: z.enum(['list', 'new', 'select', 'close']),
				tabId: z.number().int().optional().describe('required for select and close'),
				url: z.string().optional().describe('optional url to open when action is new'),
			},
		},
		async ({ action, tabId, url }) => {
			switch (action) {
				case 'list': {
					const lines = await Promise.all(
						session.tabs().map(async (t) => `${t === session.active ? '*' : ' '} ${await t.describe()}`),
					)
					return text(lines.length ? lines.join('\n') : 'no open tabs yet, navigate somewhere first')
				}
				case 'new':
					return text(await (await session.newTab(url)).describe())
				case 'select': {
					const tab = await session.tab(requireId(tabId))
					session.activate(tab)
					await tab.page.bringToFront()
					return text(`active: ${await tab.describe()}`)
				}
				case 'close': {
					const tab = await session.tab(requireId(tabId))
					await tab.page.close()
					return text(`closed tab ${tab.id}`)
				}
			}
		},
	)

	server.registerTool(
		'resize',
		{
			title: 'Resize viewport',
			description: 'Resize the viewport of a tab, e.g. to test responsive breakpoints.',
			inputSchema: {
				width: z.number().int().min(MIN_VIEWPORT_PX).max(MAX_VIEWPORT_PX),
				height: z.number().int().min(MIN_VIEWPORT_PX).max(MAX_VIEWPORT_PX),
				tabId: tabIdParam,
			},
		},
		async ({ width, height, tabId }) => {
			const tab = await session.tab(tabId)
			await tab.page.setViewportSize({ width, height })
			return text(`viewport ${width}x${height} - ${await tab.describe()}`)
		},
	)
}
