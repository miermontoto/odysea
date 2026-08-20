import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

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
