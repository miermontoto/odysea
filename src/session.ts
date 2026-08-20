import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
	chromium,
	firefox,
	webkit,
	type Browser,
	type BrowserContext,
	type ConsoleMessage,
	type Locator,
	type Page,
	type Request,
	type Response,
} from 'playwright'
import {
	DEFAULT_ACTION_TIMEOUT_MS,
	DEFAULT_NAV_TIMEOUT_MS,
	DEFAULT_VIEWPORT,
	MAX_LOG_ENTRIES,
	SESSION_DIR_MODE,
	SESSION_FILE_MODE,
	SESSION_NAME_RE,
} from './constants.js'

// directorio de sesiones persistidas, xdg por defecto y sobreescribible por env
export const sessionsDir = (): string =>
	process.env.ODYSEA_SESSIONS_DIR ??
	join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'odysea', 'sessions')

const sessionPath = (name: string): string => {
	if (!SESSION_NAME_RE.test(name)) throw new Error(`invalid session name "${name}", use letters, digits, - and _`)
	return join(sessionsDir(), `${name}.json`)
}

export interface NetworkEntry {
	id: number
	method: string
	url: string
	resourceType: string
	startedAt: number
	status?: number
	failure?: string
	durationMs?: number
	// referencias vivas de playwright para headers y body bajo demanda, nunca se serializan
	request?: Request
	response?: Response
}

export interface ConsoleEntry {
	type: string
	text: string
	location: string
	at: number
}

// ring buffer barato: descarta lo más antiguo al superar el tope
const push = <T>(log: T[], entry: T): void => {
	if (log.push(entry) > MAX_LOG_ENTRIES) log.shift()
}

const fmtLocation = (msg: ConsoleMessage): string => {
	const { url, lineNumber } = msg.location()
	return url ? `${url}:${lineNumber}` : ''
}

// una pestaña viva: la página de playwright más sus logs de red y consola,
// capturados por eventos desde el primer momento para que existan cuando el agente pregunte
export class Tab {
	readonly network: NetworkEntry[] = []
	readonly console: ConsoleEntry[] = []
	// respuesta armada por handle_dialog para el próximo dialog; one-shot
	dialogAction?: { accept: boolean; promptText?: string }
	#nextRequest = 1

	constructor(
		readonly id: number,
		readonly page: Page,
	) {
		const pending = new WeakMap<Request, NetworkEntry>()

		page.on('request', (req) => {
			const entry: NetworkEntry = {
				id: this.#nextRequest++,
				method: req.method(),
				url: req.url(),
				resourceType: req.resourceType(),
				startedAt: Date.now(),
				request: req,
			}
			pending.set(req, entry)
			push(this.network, entry)
		})
		page.on('response', (res) => {
			const entry = pending.get(res.request())
			if (entry) {
				entry.status = res.status()
				entry.response = res
			}
		})
		page.on('requestfinished', (req) => {
			const entry = pending.get(req)
			if (entry) entry.durationMs = Date.now() - entry.startedAt
		})
		page.on('requestfailed', (req) => {
			const entry = pending.get(req)
			if (entry) {
				entry.failure = req.failure()?.errorText ?? 'failed'
				entry.durationMs = Date.now() - entry.startedAt
			}
		})
		page.on('websocket', (ws) =>
			push(this.network, {
				id: this.#nextRequest++,
				method: 'WS',
				url: ws.url(),
				resourceType: 'websocket',
				startedAt: Date.now(),
			}),
		)

		page.on('console', (msg) =>
			push(this.console, { type: msg.type(), text: msg.text(), location: fmtLocation(msg), at: Date.now() }),
		)
		page.on('pageerror', (err) =>
			push(this.console, { type: 'pageerror', text: err.stack ?? String(err), location: '', at: Date.now() }),
		)

		// con listener registrado playwright deja de auto-descartar dialogs y resolverlos pasa a ser
		// responsabilidad nuestra: se aplica lo armado (dismiss por defecto) y siempre queda traza en consola
		page.on('dialog', (dialog) => {
			const armed = this.dialogAction
			this.dialogAction = undefined
			void (armed?.accept ? dialog.accept(armed.promptText) : dialog.dismiss()).catch(() => {})
			push(this.console, {
				type: 'dialog',
				text: `${dialog.type()}("${dialog.message()}") -> ${armed?.accept ? 'accepted' : 'dismissed'}${armed ? '' : ' (auto; arm handle_dialog before triggering to control it)'}`,
				location: '',
				at: Date.now(),
			})
		})
	}

	// acepta selectores playwright y también las refs que emite dom_snapshot,
	// tal cual aparecen ("ref=e5", con scope de frame "ref=f1e3") o ya como engine ("aria-ref=e5")
	locate(selector: string): Locator {
		return this.page.locator(selector.replace(/^ref=((?:f\d+)?e\d+)$/, 'aria-ref=$1'))
	}

	// resumen de una línea para que el agente sepa dónde está tras cada acción
	async describe(): Promise<string> {
		const title = await this.page.title().catch(() => '')
		return `[tab ${this.id}] ${this.page.url()}${title ? ` - ${title}` : ''}`
	}
}

const ENGINES = { chromium, firefox, webkit } as const

// sesión única del servidor: browser perezoso (no se paga el arranque hasta la primera acción),
// registro de tabs direccionables por id y noción de tab activa
export class Session {
	#browser?: Browser
	#context?: BrowserContext
	#tabs = new Map<number, Tab>()
	#byPage = new WeakMap<Page, Tab>()
	#nextTab = 1
	#active?: Tab
	// sesión persistida cargada (o pendiente de aplicar cuando se cree el contexto)
	#sessionName? = process.env.ODYSEA_SESSION

	async #ensureContext(): Promise<BrowserContext> {
		if (this.#context) return this.#context
		const engine = ENGINES[process.env.ODYSEA_BROWSER as keyof typeof ENGINES] ?? chromium
		this.#browser ??= await engine.launch({ headless: process.env.ODYSEA_HEADED !== '1' })
		this.#context = await this.#browser.newContext({
			viewport: { ...DEFAULT_VIEWPORT },
			// opt-in para frontends locales con certificados self-signed
			ignoreHTTPSErrors: process.env.ODYSEA_IGNORE_HTTPS_ERRORS === '1',
			storageState: await this.#usableState(),
		})
		this.#context.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS)
		this.#context.setDefaultNavigationTimeout(DEFAULT_NAV_TIMEOUT_MS)
		// registrar aquí cada page nueva cubre también popups y window.open
		this.#context.on('page', (page) => this.#register(page))
		return this.#context
	}

	// idempotente: el evento 'page' y newTab pueden ver la misma página
	#register(page: Page): Tab {
		const known = this.#byPage.get(page)
		if (known) return known
		const tab = new Tab(this.#nextTab++, page)
		this.#tabs.set(tab.id, tab)
		this.#byPage.set(page, tab)
		this.#active ??= tab
		page.on('close', () => {
			this.#tabs.delete(tab.id)
			if (this.#active === tab) this.#active = this.#tabs.values().next().value
		})
		return tab
	}

	// resuelve la tab pedida o la activa, creando la primera si aún no existe ninguna
	async tab(tabId?: number): Promise<Tab> {
		if (tabId !== undefined) {
			const tab = this.#tabs.get(tabId)
			if (!tab) throw new Error(`no tab with id ${tabId}, use tabs {action: "list"} to see open tabs`)
			return tab
		}
		return this.#active ?? this.newTab()
	}

	async newTab(url?: string): Promise<Tab> {
		const context = await this.#ensureContext()
		const tab = this.#register(await context.newPage())
		this.#active = tab
		if (url) await tab.page.goto(url)
		return tab
	}

	tabs(): Tab[] {
		return [...this.#tabs.values()]
	}

	get active(): Tab | undefined {
		return this.#active
	}

	activate(tab: Tab): void {
		this.#active = tab
	}

	get sessionName(): string | undefined {
		return this.#sessionName
	}

	// ruta del estado a aplicar al crear el contexto; si el fichero no existe se arranca limpio avisando
	async #usableState(): Promise<string | undefined> {
		if (!this.#sessionName) return undefined
		const file = sessionPath(this.#sessionName)
		return stat(file).then(
			() => file,
			() => {
				console.error(`odysea: session "${this.#sessionName}" not found, starting clean`)
				this.#sessionName = undefined
				return undefined
			},
		)
	}

	async saveSession(name?: string): Promise<{ name: string; file: string }> {
		const resolved = name ?? this.#sessionName
		if (!resolved) throw new Error('no session name given and none loaded, pass name')
		if (!this.#context) throw new Error('nothing to save yet, navigate somewhere first')
		const file = sessionPath(resolved)
		await mkdir(sessionsDir(), { recursive: true, mode: SESSION_DIR_MODE })
		// indexedDB incluido: apps tipo firebase auth guardan ahí sus tokens
		const state = await this.#context.storageState({ indexedDB: true })
		await writeFile(file, JSON.stringify(state), { mode: SESSION_FILE_MODE })
		this.#sessionName = resolved
		return { name: resolved, file }
	}

	// cargar implica contexto nuevo: playwright solo aplica storage state al crearlo,
	// así que las tabs, logs y refs actuales se descartan (el browser sigue vivo)
	async loadSession(name: string): Promise<void> {
		const file = sessionPath(name)
		await stat(file).catch(() => {
			throw new Error(`no saved session "${name}", use session {action: "list"}`)
		})
		this.#sessionName = name
		if (this.#context) {
			await this.#context.close()
			this.#context = undefined
			this.#tabs.clear()
			this.#active = undefined
		}
	}

	async listSessions(): Promise<{ name: string; savedAt: Date; current: boolean }[]> {
		const files = await readdir(sessionsDir()).catch(() => [] as string[])
		return Promise.all(
			files
				.filter((f) => f.endsWith('.json'))
				.map(async (f) => {
					const name = f.slice(0, -'.json'.length)
					return { name, savedAt: (await stat(join(sessionsDir(), f))).mtime, current: name === this.#sessionName }
				}),
		)
	}

	async deleteSession(name: string): Promise<void> {
		await rm(sessionPath(name)).catch(() => {
			throw new Error(`no saved session "${name}"`)
		})
		if (this.#sessionName === name) this.#sessionName = undefined
	}

	async dispose(): Promise<void> {
		await this.#browser?.close().catch(() => {})
	}
}
