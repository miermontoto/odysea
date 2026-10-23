// límites y valores por defecto de toda la sesión, el resto del código no usa números mágicos
export const VERSION = '0.6.0'
// identidad para quien lanza odysea como binario (`odysea --identify`): el nombre del paquete en npm (en npm,
// `odysea` a secas es otro proyecto) y la versión del contrato de cara a un runner. PROTOCOL sube solo cuando
// cambia ese contrato: las env vars (ODYSEA_STATE_FILE, ODYSEA_ALLOWED_ORIGINS, ODYSEA_SESSION_TOOL,
// ODYSEA_AUTOSAVE_MS) y la cli `login` / `probe` con su salida
export const PACKAGE_NAME = '@miermontoto/odysea'
export const TOOL_NAME = 'odysea'
export const PROTOCOL = 1

export const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const
export const MIN_VIEWPORT_PX = 200
export const MAX_VIEWPORT_PX = 3840

export const DEFAULT_NAV_TIMEOUT_MS = 20_000
export const DEFAULT_ACTION_TIMEOUT_MS = 10_000
export const MAX_WAIT_TIME_MS = 30_000

export const MAX_LOG_ENTRIES = 500 // tope del ring buffer de red y consola por tab
export const RECENT_RESPONSE_WINDOW_MS = 5_000 // margen para dar por buena una respuesta que llegó entre dos tool calls
export const DEFAULT_LIST_LIMIT = 50 // entradas devueltas por defecto al listar logs
export const HTTP_ERROR_MIN = 400

export const MAX_SNAPSHOT_CHARS = 30_000 // texto máximo de un aria snapshot
export const MAX_MATCH_CHARS = 4_000 // html máximo por elemento en dom_query
export const DEFAULT_QUERY_LIMIT = 5
export const MAX_BODY_CHARS = 20_000 // cuerpo de respuesta máximo en network_details
export const MAX_EVAL_CHARS = 10_000 // resultado máximo de evaluate

// los storage states guardados contienen cookies y tokens vivos: permisos solo-usuario y nombres sin rutas
export const SESSION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
export const SESSION_FILE_MODE = 0o600
export const SESSION_DIR_MODE = 0o700
// sufijo aleatorio del tmp de un guardado atómico (tmp en el mismo dir + rename)
export const TMP_SUFFIX_BYTES = 4

// autosave (ODYSEA_AUTOSAVE_MS) acotado; el guardado al cerrar nunca cuelga el apagado
export const AUTOSAVE_MIN_MS = 1_000
export const AUTOSAVE_MAX_MS = 3_600_000
export const SHUTDOWN_SAVE_TIMEOUT_MS = 5_000

// cli: autosave mientras la persona inicia sesión a mano y status que el probe da por sesión caída
export const LOGIN_AUTOSAVE_MS = 5_000
export const LOGGED_OUT_STATUSES: readonly number[] = [401, 403]
export const EXIT_CODE = { ok: 0, error: 1, config: 2, loginAborted: 3 } as const

// allowlist de orígenes (ODYSEA_ALLOWED_ORIGINS): solo esquemas navegables, un comodín necesita al menos
// dos etiquetas debajo (*.net no vale) y lo bloqueado se aborta como bloqueado por el cliente
export const NAVIGABLE_SCHEMES: readonly string[] = ['http:', 'https:']
export const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' }
export const MAX_PORT = 65_535
export const MIN_WILDCARD_BASE_LABELS = 2
export const BLOCKED_ABORT_CODE = 'blockedbyclient'
// lo que el main frame puede mostrar sin salir de la allowlist: páginas en blanco y de error del motor
// (about:neterror en firefox). un blob: se juzga por el origen que lleva dentro
export const INERT_SCHEMES: readonly string[] = ['about:', 'chrome-error:']
export const BLOB_SCHEME = 'blob:'
// adonde vuelve una tab cuyo main frame acabó fuera de la allowlist por una redirección
export const BLANK_URL = 'about:blank'

export const SCROLL_STEP_PX = 600
export const SCREENSHOT_JPEG_QUALITY = 80

// lectura (read_page / read_many): una navegación de lectura no espera a `load` más allá de esto (los
// anuncios y trackers de un medio lo retrasan sin que cambie el texto, que ya está en domcontentloaded)
export const READ_SETTLE_MS = 5_000
export const DEFAULT_READ_CHARS = 20_000
export const MAX_READ_CHARS = 100_000
// por página en read_many: un lote no debe llenar el contexto del agente
export const DEFAULT_MANY_READ_CHARS = 6_000
export const MAX_MANY_URLS = 10
export const DEFAULT_MANY_CONCURRENCY = 4
export const MAX_MANY_CONCURRENCY = 8
// un trozo se corta en el último salto de línea si cae en este último tramo del tope, no a mitad de frase
export const MIN_CUT_RATIO = 0.8

// conversión dom → markdown dentro de la página. viaja como argumento: la función que la usa se serializa
// sin su módulo y no ve nada de fuera
export interface MarkdownRules {
	noise: string
	chrome: string
	prose: string
	minProseChars: number
	minMainChars: number
	mainCoverage: number
	blockTags: readonly string[]
	blockish: string
	linkSchemes: readonly string[]
	meta: Readonly<Record<'published' | 'modified' | 'author' | 'site' | 'canonical' | 'time' | 'jsonLd', string>>
}

export const MARKDOWN_RULES: MarkdownRules = {
	// nunca es contenido
	noise:
		'script, style, noscript, template, svg, canvas, iframe, object, embed, video, audio, button, input, select, textarea, dialog, [hidden]',
	// navegación y marco del sitio (también banners de cookies modales): fuera salvo con selector explícito
	chrome:
		'nav, aside, footer, header:not(article header, main header), [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"], [aria-modal="true"]',
	// bloques de prosa que puntúan para el contenido principal: los más internos, con su texto sin el de enlaces
	prose: 'p, pre, blockquote, li, dd, td',
	// un bloque más corto no es prosa (menús, botones, metadatos)
	minProseChars: 25,
	// con menos prosa en toda la página no hay contenido principal (portadas, listas de enlaces): se lee entera
	minMainChars: 200,
	// el contenido principal es el contenedor más profundo que reúne esta fracción de la prosa
	mainCoverage: 0.7,
	// etiquetas que abren párrafo; el resto se lee en línea
	blockTags: [
		'ADDRESS', 'ARTICLE', 'CENTER', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER',
		'HEADER', 'LI', 'MAIN', 'NAV', 'P', 'SECTION', 'SUMMARY', 'TR',
	],
	// un enlace o una celda de una tabla de maquetación con alguno de estos dentro se lee como bloque, no en línea
	blockish: 'table, div, p, ul, ol, pre, blockquote, h1, h2, h3, h4, h5, h6',
	// solo estos enlaces se numeran; el resto (javascript:, mailto:, anclas de la misma página) queda en texto
	linkSchemes: ['http:', 'https:'],
	// metadatos de artículo: meta tags primero, json-ld (NewsArticle y compañía) después
	meta: {
		published:
			'meta[property="article:published_time"], meta[name="date"], meta[itemprop="datePublished"], meta[name="pubdate"]',
		modified: 'meta[property="article:modified_time"], meta[itemprop="dateModified"]',
		author: 'meta[name="author"], meta[property="article:author"]',
		site: 'meta[property="og:site_name"]',
		canonical: 'link[rel="canonical"]',
		// sin fecha en metadatos, la del primer <time> del contenido (en un foro, la del primer post)
		time: 'time[datetime]',
		jsonLd: 'script[type="application/ld+json"]',
	},
}

// extract / load_more
export const DEFAULT_EXTRACT_LIMIT = 50
export const MAX_EXTRACT_LIMIT = 500
export const MAX_FIELD_CHARS = 2_000
// campo "css@attr": el nombre de atributo tras la última @; si no lo parece, la @ es parte del selector
export const FIELD_ATTR_RE = /^[a-zA-Z_:][\w:.-]*$/
// campo que lee el propio item
export const SELF_FIELD = '.'
// atributos que se devuelven como url absoluta
export const URL_ATTRS: readonly string[] = ['href', 'src', 'action', 'poster', 'cite', 'data-href']
export const DEFAULT_LOAD_ROUNDS = 10
export const MAX_LOAD_ROUNDS = 50
// tras cada vuelta de load_more, lo que se espera a que aparezcan items nuevos y cada cuánto se cuentan
export const LOAD_SETTLE_MS = 3_000
export const LOAD_POLL_MS = 250

// peticiones fuera de una tab (read_feed): se identifican como odysea, con el contacto de ODYSEA_CONTACT si lo hay
// (sec edgar exige uno); nunca se hacen pasar por un navegador
export const FETCH_AGENT = `${PACKAGE_NAME}/${VERSION}`
// el contacto va en una cabecera: solo ascii imprimible, sin saltos de línea que inyecten otras
export const CONTACT_RE = /^[\x20-\x7e]{1,200}$/
export const FEED_ACCEPT =
	'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8'
export const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308]
export const MAX_FETCH_REDIRECTS = 5

// read_feed
export const DEFAULT_FEED_LIMIT = 30
export const MAX_FEED_LIMIT = 200
export const DEFAULT_SUMMARY_CHARS = 280
export const MAX_SUMMARY_CHARS = 5_000

// formatos de feed (rss 2.0, rss 1.0/rdf, atom, json feed) por nombre local de sus elementos, en orden de
// preferencia. viaja como argumento a la página, como MARKDOWN_RULES
export interface FeedRules {
	roots: Readonly<Record<string, string>>
	item: readonly string[]
	channel: string
	title: readonly string[]
	link: readonly string[]
	id: readonly string[]
	published: readonly string[]
	author: readonly string[]
	authorName: string
	category: readonly string[]
	summary: readonly string[]
	// <link rel="alternate"> con los que una página html anuncia sus feeds
	advertised: string
	// el elemento que mete el DOMParser cuando el xml no se puede parsear
	parseError: string
}

export const FEED_RULES: FeedRules = {
	roots: { rss: 'rss', feed: 'atom', RDF: 'rdf' },
	item: ['item', 'entry'],
	channel: 'channel',
	title: ['title'],
	link: ['link'],
	id: ['guid', 'id'],
	published: ['pubDate', 'published', 'date', 'issued', 'updated', 'modified'],
	author: ['creator', 'author'],
	authorName: 'name',
	category: ['category', 'subject'],
	// el resumen antes que el contenido entero (content:encoded): más corto y suficiente para decidir
	summary: ['description', 'summary', 'encoded', 'content'],
	advertised:
		'link[rel~="alternate"][type*="rss"], link[rel~="alternate"][type*="atom"], link[rel~="alternate"][type*="feed+json"]',
	parseError: 'parsererror',
}

// content-types cuyo cuerpo tiene sentido devolver como texto
export const TEXTUAL_CONTENT = /json|text|xml|javascript|urlencoded|graphql/i
