import { isAbsolute } from 'node:path'
import { AUTOSAVE_MAX_MS, AUTOSAVE_MIN_MS, CONTACT_RE } from './constants.js'
import { parseOriginPatterns, type OriginPattern } from './origins.js'

// configuración del servidor mcp por entorno, validada al arrancar: un valor inválido lanza y el proceso
// sale antes del primer tool call. sin ninguna de estas variables, odysea se comporta como siempre.
export interface ServerConfig {
	// modo fichero único: carga y guarda siempre en esta ruta, sin el directorio de sesiones
	stateFile?: string
	// tool `session` registrada (ODYSEA_SESSION_TOOL=0 la quita)
	sessionTool: boolean
	// autosave periódico y al cerrar; ausente = solo guardados explícitos
	autosaveMs?: number
	// allowlist de orígenes navegables; ausente = sin restricción
	allowedOrigins?: readonly OriginPattern[]
	// contacto que declaran las peticiones fuera de una tab (feeds), p.ej. un email
	contact?: string
}

const contactOf = (raw: string | undefined): string | undefined => {
	if (!raw) return undefined
	if (!CONTACT_RE.test(raw)) throw new Error('ODYSEA_CONTACT must be printable ascii, up to 200 characters')
	return raw
}

const autosaveInterval = (raw: string | undefined): number | undefined => {
	if (!raw) return undefined
	const ms = Number(raw)
	if (!Number.isFinite(ms) || ms <= 0) throw new Error(`ODYSEA_AUTOSAVE_MS must be a positive number of ms, got "${raw}"`)
	return Math.min(Math.max(ms, AUTOSAVE_MIN_MS), AUTOSAVE_MAX_MS)
}

export const loadConfig = (env: NodeJS.ProcessEnv): ServerConfig => {
	const stateFile = env.ODYSEA_STATE_FILE || undefined
	if (stateFile && !isAbsolute(stateFile)) throw new Error(`ODYSEA_STATE_FILE must be an absolute path, got "${stateFile}"`)
	return {
		stateFile,
		sessionTool: env.ODYSEA_SESSION_TOOL !== '0',
		autosaveMs: autosaveInterval(env.ODYSEA_AUTOSAVE_MS),
		allowedOrigins: parseOriginPatterns(env.ODYSEA_ALLOWED_ORIGINS),
		contact: contactOf(env.ODYSEA_CONTACT),
	}
}
