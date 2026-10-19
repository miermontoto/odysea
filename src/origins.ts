import { BLOB_SCHEME, DEFAULT_PORTS, INERT_SCHEMES, MAX_PORT, MIN_WILDCARD_BASE_LABELS, NAVIGABLE_SCHEMES } from './constants.js'

// allowlist de orígenes (ODYSEA_ALLOWED_ORIGINS): `scheme://host[:port]` separados por comas. `*.` delante
// del host admite una o más etiquetas de subdominio pero nunca el apex; sin puerto vale solo el puerto por
// defecto del esquema, igual que un origin. puro para poder probarlo sin browser.
export interface OriginPattern {
	scheme: string
	host: string
	wildcard: boolean
	// '' = el puerto por defecto del esquema (como URL.port)
	port: string
}

const PATTERN_RE = /^(https?):\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}))?$/i

// el puerto por defecto escrito explícito (https://x:443) es el mismo origin que sin puerto
const normPort = (scheme: string, port: string): string => (port === DEFAULT_PORTS[scheme] ? '' : port)

export const parseOriginPattern = (raw: string): OriginPattern => {
	const m = PATTERN_RE.exec(raw)
	if (!m) throw new Error(`invalid origin pattern "${raw}", expected http(s)://host[:port] or http(s)://*.domain`)
	const [, proto, star, host, port = ''] = m
	if (Number(port) > MAX_PORT) throw new Error(`invalid port in origin pattern "${raw}"`)
	if (star && host.split('.').length < MIN_WILDCARD_BASE_LABELS)
		throw new Error(`origin pattern "${raw}" is too broad: a wildcard needs at least ${MIN_WILDCARD_BASE_LABELS} labels after *.`)
	const scheme = `${proto.toLowerCase()}:`
	return { scheme, host: host.toLowerCase(), wildcard: Boolean(star), port: normPort(scheme, port) }
}

// vacía o ausente = sin allowlist (todo permitido, como siempre)
export const parseOriginPatterns = (raw: string | undefined): OriginPattern[] | undefined => {
	const parts = (raw ?? '')
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean)
	return parts.length ? parts.map(parseOriginPattern) : undefined
}

const parseUrl = (url: string): URL | undefined => {
	try {
		return new URL(url)
	} catch {
		return undefined
	}
}

const hostMatches = (p: OriginPattern, host: string): boolean =>
	p.wildcard ? host.endsWith(`.${p.host}`) : host === p.host

// una url es navegable si es http(s) y su origin casa con algún patrón; file:, data:, about: nunca
export const isAllowedUrl = (url: string, patterns: readonly OriginPattern[]): boolean => {
	const u = parseUrl(url)
	return (
		u !== undefined &&
		NAVIGABLE_SCHEMES.includes(u.protocol) &&
		patterns.some((p) => p.scheme === u.protocol && p.port === u.port && hostMatches(p, u.hostname))
	)
}

// dónde puede quedarse el main frame tras navegar: una url permitida, una página inerte (en blanco o de
// error) o un blob: de un origen permitido. todo lo demás (file:, data:, otro origen) se expulsa
export const isAllowedFrameUrl = (url: string, patterns: readonly OriginPattern[]): boolean => {
	const u = parseUrl(url)
	if (!u) return false
	if (INERT_SCHEMES.includes(u.protocol)) return true
	// el pathname de blob:https://x/uuid es la url interna, con su origen
	return isAllowedUrl(u.protocol === BLOB_SCHEME ? u.pathname : url, patterns)
}

export const describeOrigins =(patterns: readonly OriginPattern[]): string =>
	patterns.map((p) => `${p.scheme}//${p.wildcard ? '*.' : ''}${p.host}${p.port ? `:${p.port}` : ''}`).join(', ')
