import { useEffect, useRef, useState } from "react"
import type { LocationPayload } from "../lib/richmsg"
import { formatCoordinates } from "../lib/richmsg"
import { useSettings } from "../state/settings"
import { LoadingIndicator } from "./Expressive"
import { MapView } from "./MapView"
import { Banner, Button, Sheet, TextField } from "./m3"
import { ILocation, IWarning } from "./m3icons"

type Fix = { lat: number; lon: number; accuracy: number | null }

// Where the map opens when the device cannot tell: roughly the last place sent
// from this device (rounded to about ten kilometres), else a view of Europe.
const LAST_PLACE_KEY = "fx.lastPlace"

function lastPlace(): { lat: number; lon: number; zoom: number } {
	try {
		const raw = JSON.parse(localStorage.getItem(LAST_PLACE_KEY) ?? "null") as { lat?: unknown; lon?: unknown } | null
		const lat = Number(raw?.lat)
		const lon = Number(raw?.lon)
		if (raw && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180) return { lat, lon, zoom: 11 }
	} catch {
		// nothing remembered
	}
	return { lat: 50, lon: 20, zoom: 4 }
}

function rememberPlace(lat: number, lon: number): void {
	try {
		localStorage.setItem(LAST_PLACE_KEY, JSON.stringify({ lat: Math.round(lat * 10) / 10, lon: Math.round(lon * 10) / 10 }))
	} catch {
		// private mode: nothing is remembered
	}
}

// Sharing a place: the device's position (asked only when this sheet opens),
// adjustable by dragging the map under the pin, with an optional name.
export function LocationSheet(props: { onClose: () => void; onSend: (location: LocationPayload) => void }) {
	const { t } = useSettings()
	const [fix, setFix] = useState<Fix | null>(null)
	const [picked, setPicked] = useState<{ lat: number; lon: number } | null>(null)
	const [label, setLabel] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [locating, setLocating] = useState(false)
	const [manual, setManual] = useState<{ zoom: number } | null>(null)
	// A late answer from the device must not move a map the person is using.
	const pickedByHand = useRef(false)

	const locate = () => {
		if (typeof navigator === "undefined" || !navigator.geolocation) {
			setError(t("locationUnsupported"))
			return
		}
		pickedByHand.current = false
		setLocating(true)
		setError(null)
		navigator.geolocation.getCurrentPosition(
			(position) => {
				setLocating(false)
				if (pickedByHand.current) return
				const next = { lat: position.coords.latitude, lon: position.coords.longitude, accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null }
				setManual(null)
				setFix(next)
				setPicked({ lat: next.lat, lon: next.lon })
			},
			(err) => {
				setLocating(false)
				if (pickedByHand.current) return
				setError(err.code === 1 ? t("locationDenied") : t("locationFailed"))
			},
			{ enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 },
		)
	}

	useEffect(() => {
		locate()
	}, [])

	// Without the device's position the place is picked by hand on the map.
	const pickOnMap = () => {
		pickedByHand.current = true
		const start = lastPlace()
		setError(null)
		setManual({ zoom: start.zoom })
		setFix({ lat: start.lat, lon: start.lon, accuracy: null })
		setPicked({ lat: start.lat, lon: start.lon })
	}

	const moved = manual !== null || (fix && picked ? Math.abs(fix.lat - picked.lat) > 1e-5 || Math.abs(fix.lon - picked.lon) > 1e-5 : false)
	const send = () => {
		if (!picked) return
		rememberPlace(picked.lat, picked.lon)
		props.onSend({ lat: picked.lat, lon: picked.lon, accuracy: moved ? null : fix?.accuracy ?? null, label: label.trim() || null })
		props.onClose()
	}

	return (
		<Sheet title={t("locationTitle")} subtitle={t("locationSubtitle")} icon={<ILocation />} iconShape="pentagon" iconTone="green" onClose={props.onClose} size="md"
			actions={
				<>
					<Button variant="text" onClick={props.onClose}>{t("cancel")}</Button>
					<Button variant="filled" disabled={!picked} onClick={send}>{moved ? t("locationSendPicked") : t("locationSendMine")}</Button>
				</>
			}
		>
			{error ? (
				<Banner tone="warning" icon={<IWarning />} actions={<><Button variant="text" onClick={locate}>{t("tryAgain")}</Button><Button variant="tonal" onClick={pickOnMap}>{t("locationPickOnMap")}</Button></>}>{error}</Banner>
			) : null}
			{fix ? (
				<>
					<MapView key={manual ? "manual" : "fix"} lat={fix.lat} lon={fix.lon} zoom={manual ? manual.zoom : 16} interactive onMove={(lat, lon) => setPicked({ lat, lon })} className="location-sheet-map" />
					<p className="settings-intro location-coords">
						{picked ? formatCoordinates({ lat: picked.lat, lon: picked.lon }) : ""}
						{!moved && fix.accuracy ? " · ±" + Math.round(fix.accuracy) + " " + t("metres") : ""}
					</p>
					<TextField label={t("locationLabel")} value={label} maxLength={120} onChange={setLabel} />
					<p className="m3-note">{t("locationPrivacyNote")}</p>
				</>
			) : locating ? (
				<div className="location-wait">
					<LoadingIndicator size={56} />
					<span>{t("locationFinding")}</span>
					<Button variant="text" onClick={() => { setLocating(false); pickOnMap() }}>{t("locationPickOnMap")}</Button>
				</div>
			) : null}
		</Sheet>
	)
}
