import type { FileManifest } from "./filecrypto"

export interface LocalFileKeyMaterial {
	key: Uint8Array
	manifest: FileManifest
	name: string
	mime: string
}

export interface LocalFileCopy extends LocalFileKeyMaterial {
	blobs: Uint8Array[]
}

type StoredKeyMaterial = {
	id: string
	key: ArrayBuffer
	manifest: FileManifest
	name: string
	mime: string
}

type StoredCopy = {
	id: string
	blobs: ArrayBuffer[]
}

const DB_NAME = "frontierx-managed-files"
const DB_VERSION = 1
const KEYS_STORE = "keys"
const COPIES_STORE = "copies"
let databasePromise: Promise<IDBDatabase> | null = null

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
	})
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve()
		transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"))
		transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"))
	})
}

function openDatabase(): Promise<IDBDatabase> {
	if (databasePromise) return databasePromise
	databasePromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION)
		request.onupgradeneeded = () => {
			const database = request.result
			if (!database.objectStoreNames.contains(KEYS_STORE)) database.createObjectStore(KEYS_STORE, { keyPath: "id" })
			if (!database.objectStoreNames.contains(COPIES_STORE)) database.createObjectStore(COPIES_STORE, { keyPath: "id" })
		}
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error ?? new Error("Unable to open managed file storage"))
		request.onblocked = () => reject(new Error("Managed file storage is blocked by another FrontierX tab"))
	})
	return databasePromise
}

async function requestPersistentStorage(): Promise<void> {
	if (typeof navigator === "undefined" || !navigator.storage?.persist) return
	try {
		await navigator.storage.persist()
	} catch {
		// Persistence is a browser policy request. IndexedDB remains usable when it is denied.
	}
}

/** Stores only encrypted chunks plus local key material inside the app origin. */
export async function saveLocalCopy(id: string, copy: LocalFileCopy): Promise<void> {
	await requestPersistentStorage()
	const database = await openDatabase()
	const transaction = database.transaction([KEYS_STORE, COPIES_STORE], "readwrite")
	const keyRecord: StoredKeyMaterial = {
		id,
		key: copyBuffer(copy.key),
		manifest: copy.manifest,
		name: copy.name,
		mime: copy.mime,
	}
	const copyRecord: StoredCopy = { id, blobs: copy.blobs.map(copyBuffer) }
	transaction.objectStore(KEYS_STORE).put(keyRecord)
	transaction.objectStore(COPIES_STORE).put(copyRecord)
	await transactionDone(transaction)
}

/** Retains device-local key material after removing encrypted file bytes. */
export async function getLocalKeyMaterial(id: string): Promise<LocalFileKeyMaterial | null> {
	const database = await openDatabase()
	const transaction = database.transaction(KEYS_STORE, "readonly")
	const record = await requestValue(
		transaction.objectStore(KEYS_STORE).get(id) as IDBRequest<StoredKeyMaterial | undefined>,
	)
	await transactionDone(transaction)
	if (!record) return null
	return {
		key: new Uint8Array(record.key.slice(0)),
		manifest: record.manifest,
		name: record.name,
		mime: record.mime,
	}
}

export async function loadLocalCopy(id: string): Promise<LocalFileCopy | null> {
	const database = await openDatabase()
	const transaction = database.transaction([KEYS_STORE, COPIES_STORE], "readonly")
	const [material, copy] = await Promise.all([
		requestValue(transaction.objectStore(KEYS_STORE).get(id) as IDBRequest<StoredKeyMaterial | undefined>),
		requestValue(transaction.objectStore(COPIES_STORE).get(id) as IDBRequest<StoredCopy | undefined>),
	])
	await transactionDone(transaction)
	if (!material || !copy) return null
	return {
		key: new Uint8Array(material.key.slice(0)),
		manifest: material.manifest,
		name: material.name,
		mime: material.mime,
		blobs: copy.blobs.map((blob) => new Uint8Array(blob.slice(0))),
	}
}

/** Deletes encrypted file bytes only after a server backup confirms receipt. */
export async function removeLocalCopy(id: string): Promise<void> {
	const database = await openDatabase()
	const transaction = database.transaction(COPIES_STORE, "readwrite")
	transaction.objectStore(COPIES_STORE).delete(id)
	await transactionDone(transaction)
}

export async function listLocalCopyIds(): Promise<string[]> {
	const database = await openDatabase()
	const transaction = database.transaction(COPIES_STORE, "readonly")
	const keys = await requestValue(transaction.objectStore(COPIES_STORE).getAllKeys() as IDBRequest<IDBValidKey[]>)
	await transactionDone(transaction)
	return keys.filter((key): key is string => typeof key === "string")
}

/** Removes all device-only recovery material after a user chooses permanent deletion. */
export async function forgetLocalFile(id: string): Promise<void> {
	const database = await openDatabase()
	const transaction = database.transaction([KEYS_STORE, COPIES_STORE], "readwrite")
	transaction.objectStore(KEYS_STORE).delete(id)
	transaction.objectStore(COPIES_STORE).delete(id)
	await transactionDone(transaction)
}
