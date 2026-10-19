// límites y valores por defecto de toda la sesión, el resto del código no usa números mágicos
export const VERSION = '0.5.0'

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

// content-types cuyo cuerpo tiene sentido devolver como texto
export const TEXTUAL_CONTENT = /json|text|xml|javascript|urlencoded|graphql/i
