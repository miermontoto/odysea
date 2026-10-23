import { MARKDOWN_RULES, MIN_CUT_RATIO, type MarkdownRules } from './constants.js'
import type { Tab } from './session.js'

// lectura de una página como markdown para un agente: el contenido principal (o la página, o un elemento) con
// enlaces de referencia numerados y los metadatos de artículo. sin dependencias: la conversión corre dentro de la
// página, en el isolated world de playwright (inmune al csp), y solo viaja el resultado

// main: el contenedor que reúne la prosa; full: la página sin navegación, banners ni pies
export type ReadMode = 'main' | 'full'

interface ConvertOptions extends MarkdownRules {
	detectMain: boolean
	dropChrome: boolean
}

export interface PageRead {
	markdown: string
	// url de cada enlace numerado: [n] es links[n - 1]
	links: string[]
	// el contenedor leído, p.ej. "article" o "div#content"
	root: string
	meta: [string, string][]
}

// corre dentro de la página (locator.evaluate): autocontenida, todo lo que usa le llega en `o`
const convert = (root: Element, o: ConvertOptions): PageRead => {
	// marcas internas de sangría y bloques pre: la limpieza final de espacios no debe tocarlos
	const INDENT = '\u0002'
	const PRE = '\u0000'
	const blockTags = new Set(o.blockTags)
	const here = location.href.split('#')[0]
	const links: string[] = []
	const refs = new Map<string, number>()
	const pres: string[] = []

	const collapse = (s: string): string => s.replace(/\s+/g, ' ')
	const flat = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim()
	const tidy = (s: string): string => s.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
	const block = (s: string): string => (s.trim() ? `\n\n${s.trim()}\n\n` : '')
	const prefix = (s: string, first: string, rest: string): string =>
		s
			.split('\n')
			.map((line, i) => (i ? rest : first) + line)
			.join('\n')
	const parse = (href: string): URL | null => {
		try {
			return new URL(href)
		} catch {
			return null
		}
	}
	// checkVisibility da false a display: contents (no tiene caja) aunque sus hijos se vean
	const visible = (el: Element): boolean =>
		el.checkVisibility?.() !== false || getComputedStyle(el).display === 'contents'
	const skip = (el: Element): boolean => el.matches(o.noise) || (o.dropChrome && el.matches(o.chrome)) || !visible(el)

	// número de un enlace, el mismo cada vez que se repite
	const ref = (href: string): number => {
		const known = refs.get(href)
		if (known !== undefined) return known
		refs.set(href, links.push(href))
		return links.length
	}

	const children = (el: Element, inLink: boolean): string =>
		Array.from(el.childNodes, (node) => walk(node, inLink)).join('')

	// enlaces de referencia [texto][n]; dentro de un enlace, solo el texto. una tarjeta (enlace con bloques
	// dentro) va en su propio párrafo para no pegarse a la siguiente
	const link = (a: HTMLAnchorElement, inLink: boolean): string => {
		const label = flat(children(a, true))
		const url = parse(a.href)
		if (inLink || !label || !url || !o.linkSchemes.includes(url.protocol) || (url.hash && url.href.split('#')[0] === here))
			return label
		const out = `[${label.replace(/[[\]]/g, '\\$&')}][${ref(url.href)}]`
		return a.querySelector(o.blockish) ? block(out) : out
	}

	const list = (el: Element, inLink: boolean): string => {
		const start = el.tagName === 'OL' ? (el as HTMLOListElement).start || 1 : 0
		return Array.from(el.children)
			.filter((li) => li.tagName === 'LI' && !skip(li))
			.map((li) => tidy(children(li, inLink)).replace(/\n{2,}/g, '\n'))
			.filter(Boolean)
			.map((body, i) => prefix(body, start ? `${start + i}. ` : '- ', INDENT))
			.join('\n')
	}

	// tabla de maquetación (foros y agregadores antiguos): la fila en una línea si sus celdas son texto. un bloque
	// vacío (iconos dibujados con css, como la flecha de voto de hn) no la parte
	const blocky = (c: Element): boolean =>
		Array.from(c.querySelectorAll(o.blockish)).some((b) => (b.textContent ?? '').trim() !== '')
	const layoutRow = (cells: HTMLTableCellElement[], inLink: boolean): string =>
		cells.some(blocky)
			? cells.map((c) => block(children(c, inLink))).join('')
			: cells
					.map((c) => flat(children(c, inLink)))
					.filter(Boolean)
					.join(' ')

	// tabla de datos (con cabecera, th o caption) en markdown; el resto, de maquetación
	const table = (t: HTMLTableElement, inLink: boolean): string => {
		const cells = (r: HTMLTableRowElement): HTMLTableCellElement[] => Array.from(r.cells).filter((c) => !skip(c))
		const rows = Array.from(t.rows).filter((r) => !skip(r) && (r.textContent ?? '').trim() !== '')
		const data = t.tHead !== null || t.caption !== null || rows.some((r) => cells(r).some((c) => c.tagName === 'TH'))
		if (!data)
			return rows
				.map((r) => layoutRow(cells(r), inLink))
				.filter(Boolean)
				.join('\n')
		if (!rows.length) return ''
		const width = Math.max(...rows.map((r) => cells(r).length))
		const lines = rows.map(
			(r) => `| ${cells(r).map((c) => flat(children(c, inLink)).replaceAll('|', '\\|')).join(' | ')} |`,
		)
		return [lines[0], `|${' --- |'.repeat(width)}`, ...lines.slice(1)].join('\n')
	}

	const walk = (node: Node, inLink: boolean): string => {
		if (node.nodeType === Node.TEXT_NODE) return collapse(node.textContent ?? '')
		if (node.nodeType !== Node.ELEMENT_NODE) return ''
		const el = node as Element
		if (skip(el)) return ''
		const heading = /^H([1-6])$/.exec(el.tagName)
		if (heading) {
			const title = flat(children(el, inLink))
			return inLink || !title ? title : block(`${'#'.repeat(Number(heading[1]))} ${title}`)
		}
		switch (el.tagName) {
			case 'A':
				return link(el as HTMLAnchorElement, inLink)
			case 'BR':
				return '\n'
			case 'HR':
				return '\n\n---\n\n'
			case 'IMG': {
				const alt = flat((el as HTMLImageElement).alt)
				return alt && !inLink ? `![${alt}]` : alt
			}
			case 'PRE':
				return block(`${PRE}${pres.push(el.textContent ?? '') - 1}${PRE}`)
			case 'CODE':
				return `\`${collapse(el.textContent ?? '')}\``
			// la fecha relativa de un foro ("hace 3 horas") con la absoluta que lleva el atributo
			case 'TIME': {
				const shown = flat(children(el, inLink))
				const at = el.getAttribute('datetime')
				return at && at !== shown ? `${shown} (${at})` : shown
			}
			case 'BLOCKQUOTE':
				return block(prefix(tidy(children(el, inLink)), '> ', '> '))
			case 'UL':
			case 'OL':
				return block(list(el, inLink))
			case 'TABLE':
				return block(table(el as HTMLTableElement, inLink))
		}
		const inner = children(el, inLink)
		return blockTags.has(el.tagName) ? block(inner) : inner
	}

	// contenido principal: cada bloque de prosa (el más interno, sin el texto de sus enlaces) suma a todos sus
	// ancestros, y se baja desde la raíz mientras un hijo reúna `mainCoverage` de toda la prosa. así un artículo
	// queda en su cuerpo y un hilo de foro en el contenedor de todos sus posts, sin laterales
	const findMain = (): Element => {
		const score = new Map<Element, number>()
		const textOf = (el: Element): number => collapse(el.textContent ?? '').trim().length
		const proseOf = (el: Element): number =>
			textOf(el) - Array.from(el.querySelectorAll('a'), textOf).reduce((sum, n) => sum + n, 0)
		const bubble = (el: Element | null, n: number): void => {
			if (!el || el === root) return
			score.set(el, (score.get(el) ?? 0) + n)
			bubble(el.parentElement, n)
		}
		const blocks = Array.from(root.querySelectorAll(o.prose))
			.filter((b) => !b.querySelector(o.prose) && !b.closest(o.noise) && !(o.dropChrome && b.closest(o.chrome)) && visible(b))
			.map((b) => [b, proseOf(b)] as const)
			.filter(([, n]) => n >= o.minProseChars)
		blocks.forEach(([b, n]) => bubble(b, n))
		const total = blocks.reduce((sum, [, n]) => sum + n, 0)
		const descend = (el: Element): Element => {
			const next = Array.from(el.children).find((c) => (score.get(c) ?? 0) >= o.mainCoverage * total)
			return next ? descend(next) : el
		}
		return total < o.minMainChars ? root : descend(root)
	}

	// metadatos: meta tags, luego json-ld (objetos, arrays y @graph), luego el primer <time> del contenido
	const metaOf = (sel: string): string | undefined =>
		document.querySelector(sel)?.getAttribute('content')?.trim() || undefined
	const ldItems = (j: unknown): Record<string, unknown>[] =>
		Array.isArray(j)
			? j.flatMap(ldItems)
			: j && typeof j === 'object'
				? [j as Record<string, unknown>, ...ldItems((j as Record<string, unknown>)['@graph'] ?? [])]
				: []
	const ld = Array.from(document.querySelectorAll(o.meta.jsonLd)).flatMap((s) => {
		try {
			return ldItems(JSON.parse(s.textContent ?? ''))
		} catch {
			return []
		}
	})
	// un autor de json-ld puede ser un texto, un objeto con name o una lista de ellos
	const named = (v: unknown): string | undefined =>
		typeof v === 'string'
			? v
			: Array.isArray(v)
				? named(v[0])
				: v && typeof v === 'object'
					? named((v as Record<string, unknown>).name)
					: undefined
	const ldOf = (key: string): string | undefined => named(ld.find((item) => item[key])?.[key])

	const main = o.detectMain ? findMain() : root
	const canonical = (document.querySelector(o.meta.canonical) as HTMLLinkElement | null)?.href
	// el <time> solo vale como fecha si hay un contenido concreto: en una portada sería la de su primera entrada
	const firstTime = main === document.body ? undefined : (main.querySelector(o.meta.time)?.getAttribute('datetime') ?? undefined)
	const meta: [string, string | undefined][] = [
		['published', metaOf(o.meta.published) ?? ldOf('datePublished') ?? firstTime],
		['modified', metaOf(o.meta.modified) ?? ldOf('dateModified')],
		['author', metaOf(o.meta.author) ?? ldOf('author')],
		['site', metaOf(o.meta.site)],
		['canonical', canonical && canonical !== location.href ? canonical : undefined],
		['lang', document.documentElement.lang || undefined],
	]
	const label =
		main === document.body
			? 'body'
			: `${main.tagName.toLowerCase()}${main.id ? `#${main.id}` : ''}${main.classList[0] ? `.${main.classList[0]}` : ''}`

	const markdown = walk(main, false)
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n[ \t]+/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		// nodos de texto contiguos aportan cada uno su espacio
		.replace(/ {2,}/g, ' ')
		.replaceAll(INDENT, '  ')
		.replace(new RegExp(`${PRE}(\\d+)${PRE}`, 'g'), (_, i: string) => `\`\`\`\n${pres[Number(i)].replace(/\n+$/, '')}\n\`\`\``)
		.trim()
	return { markdown, links, root: label, meta: meta.filter((m): m is [string, string] => Boolean(m[1])) }
}

// lee la tab (o un elemento suyo, tal cual: sin detectar contenido principal ni quitar navegación). un selector
// que no casa con exactamente uno falla en el acto, sin esperar el timeout de la acción
export const readPage = async (tab: Tab, selector: string | undefined, mode: ReadMode): Promise<PageRead> => {
	const target = tab.locate(selector ?? 'body')
	const matches = selector ? await target.count() : 1
	if (matches !== 1)
		throw new Error(
			matches
				? `${matches} elements match ${selector}, read_page reads one: refine it, or use extract for lists`
				: `nothing matches ${selector}`,
		)
	return target.evaluate(convert, { ...MARKDOWN_RULES, detectMain: !selector && mode === 'main', dropChrome: !selector })
}

export interface PageSlice {
	body: string
	// "[n]: url" de los enlaces citados en este trozo, no de toda la página
	refs: string[]
	from: number
	to: number
	total: number
}

// sin enlaces: [texto][n] queda en texto, para barridos donde no se van a seguir
const LINK_REF_RE = /\[((?:\\.|[^\\\]])*)\]\[\d+\]/g
export const dropLinks = (read: PageRead): PageRead => ({
	...read,
	markdown: read.markdown.replace(LINK_REF_RE, (_, label: string) => label.replace(/\\([[\]])/g, '$1')),
	links: [],
})

// un trozo desde `offset`, cortado en el último salto de línea si cae cerca del tope
export const slicePage = (read: PageRead, offset: number, maxChars: number): PageSlice => {
	const total = read.markdown.length
	if (offset > 0 && offset >= total) throw new Error(`offset ${offset} is past the end (${total} chars)`)
	const end = Math.min(total, offset + maxChars)
	const nl = read.markdown.lastIndexOf('\n', end)
	const to = end < total && nl > offset + maxChars * MIN_CUT_RATIO ? nl : end
	const body = read.markdown.slice(offset, to)
	const cited = [...new Set(Array.from(body.matchAll(/\]\[(\d+)\]/g), (m) => Number(m[1])))].sort((a, b) => a - b)
	return { body, refs: cited.map((n) => `[${n}]: ${read.links[n - 1]}`), from: offset, to, total }
}

// hechos de la página, el trozo, sus enlaces y cómo seguir; `more` dice qué llamada trae el resto desde un offset
export const fmtRead = (read: PageRead, slice: PageSlice, status: number | undefined, more: (offset: number) => string): string => {
	const facts = [status !== undefined ? `HTTP ${status}` : '', ...read.meta.map(([k, v]) => `${k} ${v}`)].filter(Boolean)
	const rest = slice.total - slice.to
	return [
		...(facts.length ? [facts.join(' · ')] : []),
		`content: ${read.root} · chars ${slice.from}–${slice.to} of ${slice.total}`,
		'',
		slice.body || '(no readable text)',
		...(slice.refs.length ? ['', ...slice.refs] : []),
		...(rest > 0 ? ['', `… ${rest} more chars: ${more(slice.to)}`] : []),
	].join('\n')
}
