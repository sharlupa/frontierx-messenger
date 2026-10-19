// The browser tab tells about unread messages: a red circle with the count in
// the top-right corner of its icon, and "(3) FrontierX" as the title. An
// installed app (PWA) also gets the count on its icon where the system
// supports it.

const SIZE = 64
const BASE_TITLE = "FrontierX"

type Original = { link: HTMLLinkElement; href: string; type: string | null }
let originals: Original[] | null = null
let baseImage: Promise<HTMLImageElement | null> | null = null
let shown = ""
let generation = 0

function iconLinks(): Original[] {
	if (!originals) {
		originals = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="shortcut icon"]')).map((link) => ({
			link,
			href: link.getAttribute("href") ?? "",
			type: link.getAttribute("type"),
		}))
	}
	return originals
}

function loadBase(): Promise<HTMLImageElement | null> {
	if (!baseImage) {
		const source = iconLinks().find((item) => item.href.endsWith(".svg"))?.href ?? iconLinks()[0]?.href ?? "/favicon.svg"
		baseImage = new Promise((resolve) => {
			const img = new Image()
			img.onload = () => resolve(img)
			img.onerror = () => resolve(null)
			img.src = source
		})
	}
	return baseImage
}

export function badgeLabel(count: number): string {
	if (count <= 0) return ""
	return count > 99 ? "99+" : String(count)
}

async function drawIcon(label: string): Promise<string | null> {
	const base = await loadBase()
	const canvas = document.createElement("canvas")
	canvas.width = SIZE
	canvas.height = SIZE
	const ctx = canvas.getContext("2d")
	if (!ctx) return null
	if (base) ctx.drawImage(base, 0, 0, SIZE, SIZE)
	// A pill that grows with the number, pinned to the top-right corner, with a
	// thin ring so it reads on light and dark tab strips alike.
	ctx.font = "700 " + (label.length > 2 ? 24 : 30) + "px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
	const height = 38
	const width = Math.max(height, Math.ceil(ctx.measureText(label).width) + 16)
	const x = SIZE - width
	const y = 0
	const radius = height / 2
	ctx.beginPath()
	ctx.moveTo(x + radius, y)
	ctx.arcTo(x + width, y, x + width, y + height, radius)
	ctx.arcTo(x + width, y + height, x, y + height, radius)
	ctx.arcTo(x, y + height, x, y, radius)
	ctx.arcTo(x, y, x + width, y, radius)
	ctx.closePath()
	ctx.fillStyle = "#ff3b30"
	ctx.fill()
	ctx.lineWidth = 3
	ctx.strokeStyle = "#ffffff"
	ctx.stroke()
	ctx.fillStyle = "#ffffff"
	ctx.textAlign = "center"
	ctx.textBaseline = "middle"
	ctx.fillText(label, x + width / 2, y + height / 2 + 2)
	try {
		return canvas.toDataURL("image/png")
	} catch {
		return null
	}
}

// Shows `count` unread messages on the tab; 0 puts the plain icon back.
export function setTabBadge(count: number): void {
	if (typeof document === "undefined") return
	const label = badgeLabel(count)
	document.title = label ? "(" + label + ") " + BASE_TITLE : BASE_TITLE
	const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
	try {
		if (count > 0) void nav.setAppBadge?.(count)?.catch(() => undefined)
		else void nav.clearAppBadge?.()?.catch(() => undefined)
	} catch {
		// not supported here
	}
	if (label === shown) return
	shown = label
	const mine = ++generation
	if (!label) {
		for (const item of iconLinks()) swapIcon(item, item.href, item.type)
		return
	}
	void drawIcon(label).then((url) => {
		if (url && mine === generation) for (const item of iconLinks()) swapIcon(item, url, "image/png")
	})
}

// Browsers notice a new icon element more reliably than a changed address.
function swapIcon(item: Original, href: string, type: string | null) {
	const next = item.link.cloneNode() as HTMLLinkElement
	next.setAttribute("href", href)
	if (type) next.setAttribute("type", type)
	else next.removeAttribute("type")
	item.link.replaceWith(next)
	item.link = next
}
