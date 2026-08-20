import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DEFAULT_LIST_LIMIT, HTTP_ERROR_MIN, MAX_BODY_CHARS, MAX_EVAL_CHARS, TEXTUAL_CONTENT } from '../constants.js'
import type { NetworkEntry, Session } from '../session.js'
import { clip, selectorParam, tabIdParam, text } from '../shared.js'

const isError = (e: NetworkEntry): boolean =>
	e.failure !== undefined || (e.status !== undefined && e.status >= HTTP_ERROR_MIN)

const fmtEntry = (e: NetworkEntry): string =>
	`[${e.id}] ${e.failure ? `FAILED(${e.failure})` : (e.status ?? 'pending')} ${e.method} ${e.url} ` +
	`(${e.resourceType}${e.durationMs !== undefined ? `, ${e.durationMs}ms` : ''})`

const fmtHeaders = (headers: Record<string, string>): string[] =>
	Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`)

// playwright evalúa los strings como expresiones, así que una función pasada como string nunca
// llegaría a invocarse; se envuelve en una Function real (sin closures) cuyo source viaja al
// browser y se compila en el isolated world de playwright, inmune al csp de la página
const wrapExpression = (expression: string): (() => unknown) =>
	new Function(
		`const __r = (${expression}); return typeof __r === 'function' ? __r() : __r`,
	) as () => unknown

const wrapWithElement = (expression: string): ((el: SVGElement | HTMLElement) => unknown) =>
	new Function('el', `return (${expression})(el)`) as (el: SVGElement | HTMLElement) => unknown

export const registerDebug = (server: McpServer, session: Session): void => {
	server.registerTool(
		'network_requests',
		{
			title: 'Network requests',
			description:
				'List the network requests captured for a tab since it opened (newest last). Each line starts with an id usable with network_details.',
			inputSchema: {
				tabId: tabIdParam,
				filter: z.string().optional().describe('substring to match against the url'),
				onlyErrors: z.boolean().optional().describe('only failed requests and http status >= 400'),
				limit: z.number().int().positive().optional().describe(`max entries returned, default ${DEFAULT_LIST_LIMIT}`),
				clear: z.boolean().optional().describe('empty the log after reading it'),
			},
		},
		async ({ tabId, filter, onlyErrors, limit, clear }) => {
			const tab = await session.tab(tabId)
			const matches = tab.network.filter(
				(e) => (!filter || e.url.includes(filter)) && (!onlyErrors || isError(e)),
			)
			const shown = matches.slice(-(limit ?? DEFAULT_LIST_LIMIT))
			const summary = `${matches.length} matching of ${tab.network.length} captured requests${clear ? ' (log cleared)' : ''}`
			if (clear) tab.network.length = 0
			return text(shown.length ? `${summary}\n${shown.map(fmtEntry).join('\n')}` : summary)
		},
	)

	server.registerTool(
		'network_details',
		{
			title: 'Network request details',
			description:
				'Full detail of one captured request: request/response headers, post data and response body (textual bodies only, truncated). Bodies may be gone after navigating away.',
			inputSchema: {
				requestId: z.number().int().describe('id shown by network_requests'),
				tabId: tabIdParam,
				maxBodyChars: z.number().int().positive().optional().describe(`body truncation limit, default ${MAX_BODY_CHARS}`),
			},
		},
		async ({ requestId, tabId, maxBodyChars }) => {
			const tab = await session.tab(tabId)
			const entry = tab.network.find((e) => e.id === requestId)
			if (!entry) throw new Error(`no captured request with id ${requestId} in tab ${tab.id}`)
			const max = maxBodyChars ?? MAX_BODY_CHARS
			const lines = [
				`${entry.method} ${entry.url}`,
				`status: ${entry.failure ?? entry.status ?? 'pending'}${entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : ''}`,
			]
			const { request, response } = entry
			if (request) {
				lines.push('', 'request headers:', ...fmtHeaders(await request.allHeaders().catch(() => request.headers())))
				const post = request.postData()
				if (post) lines.push('', 'request body:', clip(post, max))
			}
			if (response) {
				const headers = await response.allHeaders().catch(() => response.headers())
				lines.push('', 'response headers:', ...fmtHeaders(headers))
				const body = await response.body().catch(() => undefined)
				const contentType = headers['content-type'] ?? ''
				if (!body) lines.push('', 'response body: no longer available (page probably navigated away)')
				// sin content-type se intenta utf8 y se cae a binario solo si la decodificación no es limpia
				else if (TEXTUAL_CONTENT.test(contentType) || (!contentType && !body.toString('utf8').includes('�')))
					lines.push('', 'response body:', clip(body.toString('utf8'), max))
				else lines.push('', `response body: binary (${contentType || 'unknown type'}), ${body.length} bytes`)
			}
			return text(lines.join('\n'))
		},
	)

	server.registerTool(
		'console_messages',
		{
			title: 'Console messages',
			description:
				'Console output, uncaught page errors and js dialog events (alert/confirm/prompt) captured for a tab since it opened (newest last).',
			inputSchema: {
				tabId: tabIdParam,
				level: z
					.enum(['log', 'info', 'warning', 'error', 'debug', 'dialog'])
					.optional()
					.describe('filter by severity; error also includes uncaught exceptions, dialog shows js dialogs'),
				limit: z.number().int().positive().optional().describe(`max entries returned, default ${DEFAULT_LIST_LIMIT}`),
				clear: z.boolean().optional().describe('empty the log after reading it'),
			},
		},
		async ({ tabId, level, limit, clear }) => {
			const tab = await session.tab(tabId)
			const matches = tab.console.filter(
				(e) => !level || e.type === level || (level === 'error' && e.type === 'pageerror'),
			)
			const shown = matches.slice(-(limit ?? DEFAULT_LIST_LIMIT))
			const summary = `${matches.length} matching of ${tab.console.length} captured messages${clear ? ' (log cleared)' : ''}`
			if (clear) tab.console.length = 0
			return text(
				shown.length
					? `${summary}\n${shown.map((e) => `[${e.type}] ${e.text}${e.location ? ` (${e.location})` : ''}`).join('\n')}`
					: summary,
			)
		},
	)

	server.registerTool(
		'evaluate',
		{
			title: 'Evaluate JS',
			description:
				'Run javascript in the page and return the json-serialized result. Pass an expression ("document.title") or a function ("() => location.href"); with selector, a function receiving the element ("el => el.value").',
			inputSchema: {
				expression: z.string(),
				tabId: tabIdParam,
				selector: selectorParam.optional().describe('run against this element instead of the page'),
			},
		},
		async ({ expression, tabId, selector }) => {
			const tab = await session.tab(tabId)
			const result = selector
				? await tab.locate(selector).evaluate(wrapWithElement(expression))
				: await tab.page.evaluate(wrapExpression(expression))
			return text(clip(result === undefined ? 'undefined' : JSON.stringify(result), MAX_EVAL_CHARS))
		},
	)
}
