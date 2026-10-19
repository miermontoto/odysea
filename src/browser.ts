import { chromium, firefox, webkit, type Browser, type BrowserContextOptions } from 'playwright'
import { DEFAULT_VIEWPORT } from './constants.js'

const ENGINES = { chromium, firefox, webkit } as const

// motor de ODYSEA_BROWSER (chromium por defecto); headless salvo ODYSEA_HEADED=1 o que quien llama decida
export const launchBrowser = (headless = process.env.ODYSEA_HEADED !== '1'): Promise<Browser> =>
	(ENGINES[process.env.ODYSEA_BROWSER as keyof typeof ENGINES] ?? chromium).launch({ headless })

// opciones de contexto comunes al servidor mcp y a la cli
export const contextOptions = (storageState?: string): BrowserContextOptions => ({
	viewport: { ...DEFAULT_VIEWPORT },
	// opt-in para frontends locales con certificados self-signed
	ignoreHTTPSErrors: process.env.ODYSEA_IGNORE_HTTPS_ERRORS === '1',
	storageState,
})
