// Location and contact messages. Like media and polls they are plain JSON
// behind a prefix, carried inside the end-to-end encrypted message body: the
// server never learns where someone is or whose card was shared.

export const LOCATION_PREFIX = "fxloc:1:"
export const CONTACT_PREFIX = "fxcontact:1:"

export type LocationPayload = {
	lat: number
	lon: number
	// Radius in metres the device reported, when it knew.
	accuracy?: number | null
	label?: string | null
}

export type ContactPayload = {
	// A FrontierX account, when the card is one.
	userId?: string | null
	username?: string | null
	displayName: string
	phone?: string | null
	email?: string | null
}

function clampText(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null
	const text = value.replace(/\s+/g, " ").trim()
	return text ? text.slice(0, max) : null
}

export function encodeLocation(location: LocationPayload): string {
	const payload: LocationPayload = {
		lat: Math.round(location.lat * 1e6) / 1e6,
		lon: Math.round(location.lon * 1e6) / 1e6,
	}
	if (typeof location.accuracy === "number" && Number.isFinite(location.accuracy)) payload.accuracy = Math.round(location.accuracy)
	const label = clampText(location.label, 120)
	if (label) payload.label = label
	return LOCATION_PREFIX + JSON.stringify(payload)
}

export function parseLocation(text: string | null): LocationPayload | null {
	if (!text || !text.startsWith(LOCATION_PREFIX)) return null
	try {
		const raw = JSON.parse(text.slice(LOCATION_PREFIX.length)) as Record<string, unknown>
		const lat = Number(raw.lat)
		const lon = Number(raw.lon)
		if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
		const accuracy = raw.accuracy === undefined || raw.accuracy === null ? null : Number(raw.accuracy)
		return { lat, lon, accuracy: accuracy !== null && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null, label: clampText(raw.label, 120) }
	} catch {
		return null
	}
}

export function encodeContact(contact: ContactPayload): string {
	const payload: ContactPayload = { displayName: clampText(contact.displayName, 80) ?? "" }
	const userId = clampText(contact.userId, 80)
	const username = clampText(contact.username, 40)
	const phone = clampText(contact.phone, 40)
	const email = clampText(contact.email, 120)
	if (userId) payload.userId = userId
	if (username) payload.username = username
	if (phone) payload.phone = phone
	if (email) payload.email = email
	return CONTACT_PREFIX + JSON.stringify(payload)
}

export function parseContact(text: string | null): ContactPayload | null {
	if (!text || !text.startsWith(CONTACT_PREFIX)) return null
	try {
		const raw = JSON.parse(text.slice(CONTACT_PREFIX.length)) as Record<string, unknown>
		const displayName = clampText(raw.displayName, 80)
		if (!displayName) return null
		const username = clampText(raw.username, 40)
		return {
			displayName,
			userId: clampText(raw.userId, 80),
			username: username && /^[A-Za-z0-9_.]{3,32}$/.test(username) ? username : null,
			phone: clampText(raw.phone, 40),
			email: clampText(raw.email, 120),
		}
	} catch {
		return null
	}
}

export function formatCoordinates(location: LocationPayload): string {
	const lat = Math.abs(location.lat).toFixed(5) + (location.lat >= 0 ? " N" : " S")
	const lon = Math.abs(location.lon).toFixed(5) + (location.lon >= 0 ? " E" : " W")
	return lat + ", " + lon
}

// Links that open the point in a map app of the reader's choice. Nothing is
// loaded until the reader follows one of them.
export function mapLinks(location: LocationPayload): Array<{ id: "osm" | "google" | "apple" | "yandex"; label: string; url: string }> {
	const lat = location.lat.toFixed(6)
	const lon = location.lon.toFixed(6)
	return [
		{ id: "osm", label: "OpenStreetMap", url: "https://www.openstreetmap.org/?mlat=" + lat + "&mlon=" + lon + "#map=17/" + lat + "/" + lon },
		{ id: "google", label: "Google Maps", url: "https://www.google.com/maps/search/?api=1&query=" + lat + "," + lon },
		{ id: "apple", label: "Apple Maps", url: "https://maps.apple.com/?ll=" + lat + "," + lon + "&q=" + lat + "," + lon },
		{ id: "yandex", label: "Yandex Maps", url: "https://yandex.ru/maps/?pt=" + lon + "," + lat + "&z=17&l=map" },
	]
}

// Web Mercator tile maths for the in-app map preview (OpenStreetMap tiles,
// loaded only when the reader asks to see the map).
export function tileFor(lat: number, lon: number, zoom: number): { x: number; y: number; px: number; py: number } {
	const scale = 256 * Math.pow(2, zoom)
	const worldX = ((lon + 180) / 360) * scale
	const sin = Math.sin((lat * Math.PI) / 180)
	const worldY = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
	return { x: Math.floor(worldX / 256), y: Math.floor(worldY / 256), px: worldX, py: worldY }
}

export function latLonAt(worldX: number, worldY: number, zoom: number): { lat: number; lon: number } {
	const scale = 256 * Math.pow(2, zoom)
	const lon = (worldX / scale) * 360 - 180
	const n = Math.PI - (2 * Math.PI * worldY) / scale
	const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
	return { lat, lon }
}

// A vCard for "save to contacts" on the reader's device.
export function contactVCard(contact: ContactPayload): string {
	const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (ch) => "\\" + ch)
	const lines = ["BEGIN:VCARD", "VERSION:3.0", "FN:" + escape(contact.displayName)]
	if (contact.phone) lines.push("TEL;TYPE=CELL:" + escape(contact.phone))
	if (contact.email) lines.push("EMAIL:" + escape(contact.email))
	if (contact.username) lines.push("NOTE:FrontierX @" + escape(contact.username))
	lines.push("END:VCARD")
	return lines.join("\r\n") + "\r\n"
}
