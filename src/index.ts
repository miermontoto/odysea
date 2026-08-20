#!/usr/bin/env node
// odysea: navegador headless nativo de mcp para que los agentes usen y depuren frontends
// ojo: stdout pertenece al protocolo stdio de mcp, cualquier log debe ir a stderr
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Session } from './session.js'
import { registerCapture } from './tools/capture.js'
import { registerDebug } from './tools/debug.js'
import { registerInteract } from './tools/interact.js'
import { registerNavigation } from './tools/navigation.js'
import { registerSessions } from './tools/sessions.js'

const session = new Session()
const server = new McpServer({ name: 'odysea', version: '0.4.0' })

for (const register of [registerNavigation, registerCapture, registerDebug, registerInteract, registerSessions])
	register(server, session)

// cerrar el browser al morir el proceso para no dejar chromiums huérfanos
const shutdown = async (): Promise<void> => {
	await session.dispose()
	process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await server.connect(new StdioServerTransport())
console.error('odysea listening on stdio')
