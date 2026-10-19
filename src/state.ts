import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BrowserContext } from 'playwright'
import { SESSION_DIR_MODE, SESSION_FILE_MODE, TMP_SUFFIX_BYTES } from './constants.js'

// los storage states contienen cookies y tokens vivos: se escriben atómicos (tmp en el mismo dir +
// rename), así un lector nunca ve un json a medias y un proceso muerto a mitad deja como mucho un tmp
// huérfano, nunca el estado truncado. permisos solo-usuario; el modo del dir solo aplica si se crea.
export const writeAtomic = async (file: string, data: string): Promise<void> => {
	await mkdir(dirname(file), { recursive: true, mode: SESSION_DIR_MODE })
	const tmp = `${file}.tmp-${process.pid}-${randomBytes(TMP_SUFFIX_BYTES).toString('hex')}`
	try {
		await writeFile(tmp, data, { mode: SESSION_FILE_MODE, flag: 'wx' })
		await rename(tmp, file)
	} catch (err) {
		await rm(tmp, { force: true })
		throw err
	}
}

// guardados en cadena sobre un mismo destino: cada uno espera al anterior (aunque fallara), así dos
// renames nunca se cruzan y el último pedido es el último en escribirse. sin esto un autosave en vuelo
// podía terminar después del guardado final y pisarlo con un estado más viejo
export class SaveQueue {
	#tail?: Promise<void>

	// hay un guardado en vuelo
	get busy(): boolean {
		return this.#tail !== undefined
	}

	// espera al guardado en vuelo, si lo hay, sin propagar su error
	settled(): Promise<void> {
		return this.#tail?.catch(() => {}) ?? Promise.resolve()
	}

	// la limpieza va dentro de la misma promesa: quien espera el guardado ya ve busy=false al seguir
	enqueue(save: () => Promise<void>): Promise<void> {
		const current: Promise<void> = this.settled()
			.then(save)
			.finally(() => {
				if (this.#tail === current) this.#tail = undefined
			})
		this.#tail = current
		return current
	}
}

// indexedDB incluido: apps tipo firebase auth guardan ahí sus tokens
export const saveState = async (context: BrowserContext, file: string): Promise<void> =>
	writeAtomic(file, JSON.stringify(await context.storageState({ indexedDB: true })))

// la ruta si el fichero existe; arrancar limpio o fallar lo decide quien llama
export const existingState = (file: string): Promise<string | undefined> =>
	stat(file).then(
		() => file,
		() => undefined,
	)
