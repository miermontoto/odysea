#!/usr/bin/env node
// odysea: navegador headless nativo de mcp para que los agentes usen y depuren frontends
// ojo: stdout pertenece al protocolo stdio de mcp, cualquier log debe ir a stderr
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { runCli } from './cli.js'
import { loadConfig, type ServerConfig } from './config.js'
import { EXIT_CODE, SHUTDOWN_SAVE_TIMEOUT_MS, VERSION } from './constants.js'
import { Session } from './session.js'
import { registerCapture } from './tools/capture.js'
import { registerDebug } from './tools/debug.js'
import { registerInteract } from './tools/interact.js'
import { registerNavigation } from './tools/navigation.js'
import { registerSessions } from './tools/sessions.js'

// el timer no mantiene vivo el proceso: un guardado colgado nunca bloquea el apagado
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
	Promise.race([
		p,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref()),
	])

const serve = async (): Promise<void> => {
	const config = ((): ServerConfig => {
		try {
			return loadConfig(process.env)
		} catch (err) {
			console.error(`odysea: ${(err as Error).message}`)
			return process.exit(EXIT_CODE.config)
		}
	})()

	const session = new Session({ stateFile: config.stateFile, allowedOrigins: config.allowedOrigins })
	const server = new McpServer({ name: 'odysea', version: VERSION })

	const registrars = [registerNavigation, registerCapture, registerDebug, registerInteract]
	for (const register of config.sessionTool ? [...registrars, registerSessions] : registrars) register(server, session)

	// cerrar el browser al morir el proceso para no dejar chromiums huérfanos; con autosave, antes se
	// guarda (acotado en el tiempo). una segunda señal sale sin esperar
	let closing = false
	const shutdown = async (): Promise<void> => {
		if (closing) process.exit(EXIT_CODE.ok)
		closing = true
		if (config.autosaveMs)
			await withTimeout(session.persist(true), SHUTDOWN_SAVE_TIMEOUT_MS).catch((err) =>
				console.error(`odysea: final save failed: ${err}`),
			)
		await session.dispose()
		process.exit(EXIT_CODE.ok)
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)

	if (config.autosaveMs) {
		session.startAutosave(config.autosaveMs)
		// el transport de stdio no reacciona al eof de stdin: sin cliente se guarda y se cierra
		process.stdin.once('end', () => void shutdown())
		server.server.onclose = () => void shutdown()
	}

	await server.connect(new StdioServerTransport())
	console.error('odysea listening on stdio')
}

// con argumentos es la cli (--version, login, probe); sin ellos, el servidor mcp de siempre. exitCode y no
// exit(): con stdout en un pipe asíncrono, exit() podría cortar el json del probe
if (process.argv.length > 2) process.exitCode = await runCli(process.argv.slice(2))
else await serve()
