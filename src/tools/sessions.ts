import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sessionsDir, type Session } from '../session.js'
import { text } from '../shared.js'

const requireName = (name?: string): string => {
	if (!name) throw new Error('name is required for this action')
	return name
}

export const registerSessions = (server: McpServer, session: Session): void => {
	server.registerTool(
		'session',
		{
			title: 'Session',
			description:
				'Persist and restore browser state (cookies, localStorage, indexeddb) as named sessions so logins survive server restarts. save dumps the current state; load starts a fresh context from a saved one (open tabs, logs and refs are discarded); list and delete manage the saved set. Env ODYSEA_SESSION=<name> auto-loads one at startup.',
			inputSchema: {
				action: z.enum(['save', 'load', 'list', 'delete']),
				name: z.string().optional().describe('session name; save defaults to the currently loaded session'),
			},
		},
		async ({ action, name }) => {
			switch (action) {
				case 'save': {
					const saved = await session.saveSession(name)
					return text(`saved session "${saved.name}" -> ${saved.file}`)
				}
				case 'load': {
					await session.loadSession(requireName(name))
					return text(`loaded session "${name}": fresh context, previous tabs closed`)
				}
				case 'list': {
					const rows = await session.listSessions()
					return text(
						rows.length
							? rows
									.map((r) => `${r.current ? '*' : ' '} ${r.name} (saved ${r.savedAt.toISOString()})`)
									.join('\n')
							: `no saved sessions in ${sessionsDir()}`,
					)
				}
				case 'delete': {
					await session.deleteSession(requireName(name))
					return text(`deleted session "${name}"`)
				}
			}
		},
	)
}
