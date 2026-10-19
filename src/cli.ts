import { isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { contextOptions, launchBrowser } from './browser.js'
import { EXIT_CODE, LOGGED_OUT_STATUSES, LOGIN_AUTOSAVE_MS, VERSION } from './constants.js'
import { existingState, SaveQueue, saveState } from './state.js'

// subcomandos de la cli: sin protocolo mcp, así que stdout es de la cli (versión y el json del probe) y
// los avisos para la persona siguen yendo a stderr
const USAGE = `usage:
  odysea                                   mcp server on stdio
  odysea --version
  odysea login --state-file <path> --url <url>
  odysea probe --state-file <path> --url <url> [--login-pattern <regex>]`

const OPTIONS = {
	version: { type: 'boolean' },
	'state-file': { type: 'string' },
	url: { type: 'string' },
	'login-pattern': { type: 'string' },
} as const

type CliOptions = Partial<Record<'state-file' | 'url' | 'login-pattern', string>>

const required = (opts: CliOptions, key: keyof CliOptions): string => {
	const value = opts[key]
	if (!value) throw new Error(`--${key} is required`)
	return value
}

// el fichero se resuelve contra el cwd: la cli la usa una persona, no el agente
const stateFileOf = (opts: CliOptions): string => {
	const file = required(opts, 'state-file')
	return isAbsolute(file) ? file : resolve(file)
}

// browser visible para iniciar sesión a mano (mfa, captcha): se guarda al pulsar enter y, mientras tanto,
// cada pocos segundos, así cerrar la ventana no pierde el login (queda el último autosave)
const login = async (opts: CliOptions): Promise<number> => {
	const file = stateFileOf(opts)
	const url = required(opts, 'url')
	const browser = await launchBrowser(false)
	const context = await browser.newContext({ ...contextOptions(await existingState(file)), viewport: null })
	await (await context.newPage()).goto(url)
	console.error(`odysea: log in in the browser window, then press Enter here to save to ${file}`)
	// en cadena: el guardado de enter se escribe después de cualquier autosave en vuelo, nunca antes
	const saves = new SaveQueue()
	const save = (): Promise<void> => saves.enqueue(() => saveState(context, file))
	const autosave = setInterval(() => {
		if (!saves.busy) void save().catch((err) => console.error(`odysea: autosave failed: ${err}`))
	}, LOGIN_AUTOSAVE_MS)
	const outcome = await new Promise<'saved' | 'closed'>((done) => {
		const rl = createInterface({ input: process.stdin })
		rl.once('line', () => {
			rl.close()
			done('saved')
		})
		browser.once('disconnected', () => {
			rl.close()
			done('closed')
		})
	})
	clearInterval(autosave)
	if (outcome === 'closed') {
		// que el autosave en vuelo termine su rename en vez de dejar un tmp a medias
		await saves.settled()
		console.error('odysea: the browser closed before Enter, kept the last autosave (if any)')
		return EXIT_CODE.loginAborted
	}
	await save()
	await browser.close()
	console.error(`odysea: saved ${file}`)
	return EXIT_CODE.ok
}

interface ProbeResult {
	ok: boolean
	status: number | null
	finalUrl: string | null
	loggedOut: boolean
	reason: string | null
}

// comprueba si un estado guardado sigue con la sesión viva: headless, nunca escribe el fichero.
// una sola línea json en stdout; código 0 si el probe se ejecutó (aunque la sesión esté caída)
const probe = async (opts: CliOptions): Promise<number> => {
	const emit = (r: ProbeResult): void => console.log(JSON.stringify(r))
	try {
		const file = stateFileOf(opts)
		const url = required(opts, 'url')
		const pattern = opts['login-pattern']
		const loginRe = pattern ? new RegExp(pattern) : undefined
		const state = await existingState(file)
		if (!state) throw new Error(`state file ${file} not found`)
		const browser = await launchBrowser(true)
		try {
			const page = await (await browser.newContext(contextOptions(state))).newPage()
			const status = (await page.goto(url))?.status() ?? null
			const finalUrl = page.url()
			const reason =
				status !== null && LOGGED_OUT_STATUSES.includes(status)
					? `http ${status}`
					: loginRe?.test(finalUrl)
						? 'redirected to login'
						: null
			emit({ ok: true, status, finalUrl, loggedOut: reason !== null, reason })
			return EXIT_CODE.ok
		} finally {
			await browser.close()
		}
	} catch (err) {
		emit({ ok: false, status: null, finalUrl: null, loggedOut: false, reason: (err as Error).message })
		return EXIT_CODE.error
	}
}

const COMMANDS: Readonly<Record<string, (opts: CliOptions) => Promise<number>>> = { login, probe }

// devuelve el código de salida; los errores de uso salen con EXIT_CODE.config y el uso en stderr
export const runCli = async (args: string[]): Promise<number> => {
	try {
		const { values, positionals } = parseArgs({ args, options: OPTIONS, allowPositionals: true })
		if (values.version) {
			console.log(VERSION)
			return EXIT_CODE.ok
		}
		const command = positionals.length === 1 ? COMMANDS[positionals[0]] : undefined
		if (!command) {
			console.error(USAGE)
			return EXIT_CODE.config
		}
		return await command(values)
	} catch (err) {
		console.error(`odysea: ${(err as Error).message}\n${USAGE}`)
		return EXIT_CODE.error
	}
}
