import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Browser, BrowserContext, ConsoleMessage, Frame, Locator, Page, Request, Response, Route } from 'playwright'
import { contextOptions, launchBrowser } from './browser.js'
import {
	BLANK_URL,
	BLOCKED_ABORT_CODE,
	DEFAULT_ACTION_TIMEOUT_MS,
	DEFAULT_NAV_TIMEOUT_MS,
	MAX_LOG_ENTRIES,
	SESSION_NAME_RE,
} from './constants.js'
import { describeOrigins, isAllowedFrameUrl, isAllowedUrl, type OriginPattern } from './origins.js'
import { existingState, SaveQueue, saveState } from './state.js'

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

// main frame de una navegación (tab o popup); undefined para subrecursos e iframes
const mainNavFrame = (request: Request): Frame | undefined => {
	if (!request.isNavigationRequest()) return undefined
	const frame = request.frame()
	return frame.parentFrame() ? undefined : frame
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
	// última navegación del main frame que abortó la allowlist de orígenes (Session.guard la traduce) y
	// la vuelta a about:blank en vuelo cuando la cortó una redirección
	blocked?: string
	evicting?: Promise<unknown>
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

export interface SessionOptions {
	// modo fichero único (ODYSEA_STATE_FILE): carga y guarda siempre ahí, sin el directorio de sesiones
	stateFile?: string
	// allowlist de orígenes (ODYSEA_ALLOWED_ORIGINS); ausente = sin restricción
	allowedOrigins?: readonly OriginPattern[]
}

// sesión única del servidor: browser perezoso (no se paga el arranque hasta la primera acción),
// registro de tabs direccionables por id y noción de tab activa
export class Session {
	#browser?: Browser
	#context?: BrowserContext
	#tabs = new Map<number, Tab>()
	#byPage = new WeakMap<Page, Tab>()
	#nextTab = 1
	#active?: Tab
	// sesión persistida cargada (o pendiente de aplicar cuando se cree el contexto); en modo fichero
	// único no hay sesiones con nombre
	#sessionName?: string
	// todo guardado del contexto (autosave, la tool y el final) va en cadena: nunca se pisan
	#saves = new SaveQueue()
	#autosave?: NodeJS.Timeout

	constructor(readonly options: SessionOptions = {}) {
		this.#sessionName = options.stateFile ? undefined : process.env.ODYSEA_SESSION
	}

	async #ensureContext(): Promise<BrowserContext> {
		if (this.#context) return this.#context
		this.#browser ??= await launchBrowser()
		const allowed = this.options.allowedOrigins
		this.#context = await this.#browser.newContext({
			...contextOptions(await this.#usableState()),
			// con allowlist, un service worker podría servir navegaciones sin pasar por route: se bloquean
			...(allowed && { serviceWorkers: 'block' as const }),
		})
		this.#context.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS)
		this.#context.setDefaultNavigationTimeout(DEFAULT_NAV_TIMEOUT_MS)
		// registrar aquí cada page nueva cubre también popups y window.open
		this.#context.on('page', (page) => this.#register(page))
		if (allowed) await this.#context.route('**/*', (route, request) => this.#gate(route, request, allowed))
		return this.#context
	}

	// allowlist de orígenes, solo en el main frame (tabs y popups): subrecursos e iframes pasan, así que acota
	// dónde opera el agente, no es una barrera de exfiltración. la primera url de cada navegación se aborta
	// aquí antes de salir (clics, location, window.open, formularios). sin allowlist este gate no existe.
	#gate(route: Route, request: Request, allowed: readonly OriginPattern[]): Promise<void> {
		const frame = mainNavFrame(request)
		if (!frame || isAllowedUrl(request.url(), allowed)) return route.fallback()
		this.#mark(frame.page(), request.url())
		return route.abort(BLOCKED_ABORT_CODE)
	}

	// playwright solo enruta la primera url de una cadena de redirecciones (y lo que se cumple con fulfill
	// tampoco vuelve a pasar): un salto fuera de la allowlist se corta en cuanto sale su request y, si aun así
	// llega a hacer commit, al navegar, devolviendo la tab a about:blank. route tampoco ve file: ni data:
	// (navegados por js), así que el commit expulsa todo lo que no sea permitido, inerte o un blob: permitido
	#watchRedirects(page: Page, allowed: readonly OriginPattern[]): void {
		page.on('request', (request) => {
			if (mainNavFrame(request) && request.redirectedFrom() && !isAllowedUrl(request.url(), allowed))
				this.#evict(page, request.url())
		})
		page.on('framenavigated', (frame) => {
			const url = frame.url()
			if (!frame.parentFrame() && !isAllowedFrameUrl(url, allowed)) this.#evict(page, url)
		})
	}

	#evict(page: Page, url: string): void {
		const tab = this.#byPage.get(page)
		if (tab?.blocked === url) return
		this.#mark(page, url)
		const back = page.goto(BLANK_URL).catch(() => {})
		if (tab) tab.evicting = back
	}

	// lo bloqueado queda en la consola de la tab y en tab.blocked, para que la tool lo diga en vez de un timeout
	#mark(page: Page, url: string): void {
		const tab = this.#byPage.get(page)
		if (!tab) return
		tab.blocked = url
		push(tab.console, { type: 'blocked', text: `navigation blocked, origin not allowed: ${url}`, location: '', at: Date.now() })
	}

	// route no ve esquemas no http (file:, data:), así que toda url que abre una tool se comprueba antes
	assertAllowed(url: string): void {
		const allowed = this.options.allowedOrigins
		if (allowed && !isAllowedUrl(url, allowed))
			throw new Error(`origin not allowed: ${url} (allowed: ${describeOrigins(allowed)})`)
	}

	// ejecuta una navegación de una tool: comprueba la url pedida y traduce un aborto de la allowlist
	// (p.ej. una redirección a otro origen) a un error claro en vez del net::ERR genérico del motor
	async guard<T>(tab: Tab, navigate: () => Promise<T>, url?: string): Promise<T> {
		if (url !== undefined) this.assertAllowed(url)
		// una vuelta a about:blank anterior aún en vuelo interrumpiría esta navegación: se espera antes
		await tab.evicting
		tab.blocked = undefined
		tab.evicting = undefined
		// el error sale con la tab ya asentada en about:blank, sin eventos tardíos de la redirección cortada
		const refuse = async (): Promise<never> => {
			await tab.evicting
			throw new Error(`origin not allowed: ${tab.blocked}`)
		}
		const result = await navigate().catch((err: Error) => (tab.blocked ? refuse() : Promise.reject(err)))
		// una redirección fuera de la allowlist puede cortarse después de que la navegación resolviera
		return tab.blocked ? refuse() : result
	}

	// idempotente: el evento 'page' y newTab pueden ver la misma página
	#register(page: Page): Tab {
		const known = this.#byPage.get(page)
		if (known) return known
		const tab = new Tab(this.#nextTab++, page)
		this.#tabs.set(tab.id, tab)
		this.#byPage.set(page, tab)
		if (this.options.allowedOrigins) this.#watchRedirects(page, this.options.allowedOrigins)
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
		if (url) this.assertAllowed(url)
		const context = await this.#ensureContext()
		const tab = this.#register(await context.newPage())
		this.#active = tab
		if (url) await this.guard(tab, () => tab.page.goto(url))
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
		const { stateFile } = this.options
		if (stateFile) {
			const found = await existingState(stateFile)
			if (!found) console.error(`odysea: state file ${stateFile} not found, starting clean`)
			return found
		}
		if (!this.#sessionName) return undefined
		const found = await existingState(sessionPath(this.#sessionName))
		if (!found) {
			console.error(`odysea: session "${this.#sessionName}" not found, starting clean`)
			this.#sessionName = undefined
		}
		return found
	}

	// en modo fichero único el directorio de sesiones no existe para el agente
	#namedOnly(action: string): void {
		if (this.options.stateFile) throw new Error(`session ${action} is unavailable in single-file mode (ODYSEA_STATE_FILE)`)
	}

	// en modo fichero único se guarda siempre en él y el nombre se ignora
	async saveSession(name?: string): Promise<{ name: string; file: string }> {
		const { stateFile } = this.options
		const resolved = stateFile ? basename(stateFile) : (name ?? this.#sessionName)
		if (!resolved) throw new Error('no session name given and none loaded, pass name')
		const context = this.#context
		if (!context) throw new Error('nothing to save yet, navigate somewhere first')
		const file = stateFile ?? sessionPath(resolved)
		await this.#saves.enqueue(() => saveState(context, file))
		if (!stateFile) this.#sessionName = resolved
		return { name: resolved, file }
	}

	// destino de los guardados automáticos: el fichero único o la sesión cargada; sin ninguno, nada
	#autosaveTarget(): string | undefined {
		return this.options.stateFile ?? (this.#sessionName ? sessionPath(this.#sessionName) : undefined)
	}

	// guardado automático: devuelve el fichero escrito, o undefined si no había contexto, destino o (en un tick
	// con otro guardado en vuelo) nada que hacer: el siguiente tick ya capta lo nuevo. el final (`fresh`, al
	// cerrar) se encola detrás del que haya en vuelo, así su estado es el último en escribirse
	async persist(fresh = false): Promise<string | undefined> {
		const file = this.#autosaveTarget()
		const context = this.#context
		if (!file || !context || (this.#saves.busy && !fresh)) return undefined
		await this.#saves.enqueue(() => saveState(context, file))
		return file
	}

	startAutosave(everyMs: number): void {
		clearInterval(this.#autosave)
		// unref: el timer no mantiene vivo el proceso
		this.#autosave = setInterval(
			() => void this.persist().catch((err) => console.error(`odysea: autosave failed: ${err}`)),
			everyMs,
		).unref()
	}

	// cargar implica contexto nuevo: playwright solo aplica storage state al crearlo,
	// así que las tabs, logs y refs actuales se descartan (el browser sigue vivo)
	async loadSession(name: string): Promise<void> {
		this.#namedOnly('load')
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
		this.#namedOnly('list')
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
		this.#namedOnly('delete')
		await rm(sessionPath(name)).catch(() => {
			throw new Error(`no saved session "${name}"`)
		})
		if (this.#sessionName === name) this.#sessionName = undefined
	}

	async dispose(): Promise<void> {
		clearInterval(this.#autosave)
		await this.#browser?.close().catch(() => {})
	}
}
