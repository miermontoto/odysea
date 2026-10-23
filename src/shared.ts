import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { READ_SETTLE_MS } from './constants.js'
import type { Session, Tab } from './session.js'

// respuesta mcp de texto plano, el formato de casi todas las tools
export const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] })

// recorta contenido largo dejando constancia de cuánto se perdió
export const clip = (s: string, max: number): string =>
	s.length <= max ? s : `${s.slice(0, max)}\n… [truncated, ${s.length - max} chars omitted]`

// parámetro común a todas las tools que operan sobre una pestaña
export const tabIdParam = z.number().int().optional().describe('target tab id, defaults to the active tab')

// los selectores aceptan la sintaxis de playwright (css, text=, xpath=...) y las refs de dom_snapshot
export const selectorParam = z
	.string()
	.describe('css selector (playwright syntax, so text= and xpath= also work) or a ref=eN from dom_snapshot')

// las tools de lectura navegan antes de leer si se les pasa una url
export const urlParam = z.string().optional().describe('open this absolute url in the tab first, like navigate')

// navegación de lectura: el texto ya está en domcontentloaded y `load` se espera acotado (los anuncios de un
// medio lo retrasan sin cambiar nada legible). pasa por la allowlist como navigate; devuelve el status http
export const openForReading = async (session: Session, tab: Tab, url: string): Promise<number | undefined> => {
	const res = await session.guard(tab, () => tab.page.goto(url, { waitUntil: 'domcontentloaded' }), url)
	await tab.page.waitForLoadState('load', { timeout: READ_SETTLE_MS }).catch(() => {})
	return res?.status()
}

// map asíncrono con como mucho `limit` tareas en vuelo; los resultados salen en el orden de entrada
export const mapLimit = async <T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> => {
	const results: R[] = new Array(items.length)
	let next = 0
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const i = next++
			results[i] = await fn(items[i], i)
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
	return results
}

// tab de usar y tirar que no le quita la activa al agente; se cierra al terminar, falle o no. también sirve de
// página en blanco donde parsear sin que el código de ninguna web pueda tocar el resultado
export const withScratchTab = async <T>(session: Session, fn: (tab: Tab) => Promise<T>): Promise<T> => {
	const tab = await session.newTab(undefined, false)
	try {
		return await fn(tab)
	} finally {
		await tab.page.close().catch(() => {})
	}
}
