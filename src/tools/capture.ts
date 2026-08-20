import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DEFAULT_QUERY_LIMIT, MAX_MATCH_CHARS, MAX_SNAPSHOT_CHARS, SCREENSHOT_JPEG_QUALITY } from '../constants.js'
import type { Session } from '../session.js'
import { clip, selectorParam, tabIdParam, text } from '../shared.js'

export const registerCapture = (server: McpServer, session: Session): void => {
	server.registerTool(
		'screenshot',
		{
			title: 'Screenshot',
			description: 'Capture the page (viewport or full) or a single element as an image.',
			inputSchema: {
				tabId: tabIdParam,
				selector: selectorParam.optional().describe('capture just this element instead of the page'),
				fullPage: z.boolean().optional().describe('capture the whole scrollable page, not just the viewport'),
				format: z.enum(['jpeg', 'png']).optional().describe('default jpeg (smaller), use png for pixel-exact checks'),
			},
		},
		async ({ tabId, selector, fullPage, format }) => {
			const tab = await session.tab(tabId)
			const type = format ?? 'jpeg'
			const quality = type === 'jpeg' && { quality: SCREENSHOT_JPEG_QUALITY }
			const buffer = selector
				? await tab.locate(selector).screenshot({ type, ...quality })
				: await tab.page.screenshot({ type, fullPage, ...quality })
			return {
				content: [
					{ type: 'image' as const, data: buffer.toString('base64'), mimeType: `image/${type}` },
					{ type: 'text' as const, text: await tab.describe() },
				],
			}
		},
	)

	server.registerTool(
		'dom_snapshot',
		{
			title: 'DOM snapshot',
			description:
				'Accessibility-tree snapshot of the page (roles, names, structure), iframes included. Each element carries a [ref=eN] marker usable directly as selector ("ref=eN") in every other tool: prefer that over guessing css. Refs go stale when the dom changes or a new snapshot is taken; re-snapshot then.',
			inputSchema: {
				tabId: tabIdParam,
				selector: selectorParam.optional().describe('snapshot only this subtree'),
				maxChars: z.number().int().positive().optional().describe(`truncation limit, default ${MAX_SNAPSHOT_CHARS}`),
			},
		},
		async ({ tabId, selector, maxChars }) => {
			const tab = await session.tab(tabId)
			// el modo ai emite las refs [ref=eN] e incluye el contenido de los iframes
			const snapshot = selector
				? await tab.locate(selector).ariaSnapshot({ mode: 'ai' })
				: await tab.page.ariaSnapshot({ mode: 'ai' })
			return text(`${await tab.describe()}\n${clip(snapshot, maxChars ?? MAX_SNAPSHOT_CHARS)}`)
		},
	)

	server.registerTool(
		'dom_query',
		{
			title: 'DOM query',
			description:
				'Inspect the elements matching a selector: total match count plus the outerHTML (or innerText) of the first matches. Use it to debug markup, attributes and classes.',
			inputSchema: {
				selector: selectorParam,
				tabId: tabIdParam,
				limit: z.number().int().positive().optional().describe(`matches to show, default ${DEFAULT_QUERY_LIMIT}`),
				textOnly: z.boolean().optional().describe('return innerText instead of outerHTML'),
			},
		},
		async ({ selector, tabId, limit, textOnly }) => {
			const tab = await session.tab(tabId)
			const locator = tab.locate(selector)
			const count = await locator.count()
			if (count === 0) return text(`0 matches for ${selector}`)
			const shown = Math.min(count, limit ?? DEFAULT_QUERY_LIMIT)
			const parts = await Promise.all(
				Array.from({ length: shown }, async (_, i) => {
					const el = locator.nth(i)
					const content = textOnly ? await el.innerText() : await el.evaluate((node) => node.outerHTML)
					return `--- match ${i + 1} of ${count} ---\n${clip(content, MAX_MATCH_CHARS)}`
				}),
			)
			return text(`${count} match(es) for ${selector}\n${parts.join('\n')}`)
		},
	)
}
