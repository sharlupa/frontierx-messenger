import { useState } from "react"
import type { ContactPayload, LocationPayload } from "../lib/richmsg"
import { contactVCard, formatCoordinates, mapLinks } from "../lib/richmsg"
import { useSettings } from "../state/settings"
import { MapView } from "./MapView"
import { Avatar, Menu } from "./m3"
import { IChat, IContact, IDownload, ILocation, IMap, IMail, IPhone } from "./m3icons"

// A shared place. The map is not loaded until the reader asks for it (tiles
// come from OpenStreetMap, which would otherwise learn where people look).
export function LocationBubble(props: { location: LocationPayload }) {
	const { t } = useSettings()
	const [showMap, setShowMap] = useState(false)
	const [menu, setMenu] = useState<HTMLElement | null>(null)
	const { location } = props
	return (
		<div className="location-card">
			{showMap ? (
				<MapView lat={location.lat} lon={location.lon} zoom={15} accuracy={location.accuracy} className="location-card-map" />
			) : (
				<button type="button" className="location-card-placeholder" onClick={() => setShowMap(true)} aria-label={t("locationShowMap")}>
					<span className="location-card-grid" aria-hidden="true" />
					<span className="location-card-pin" aria-hidden="true"><ILocation size={30} /></span>
					<span className="location-card-show">{t("locationShowMap")}</span>
				</button>
			)}
			<div className="location-card-body">
				<div className="location-card-text">
					<span className="location-card-title">{location.label || t("locationShort")}</span>
					<span className="location-card-sub">{formatCoordinates(location)}{location.accuracy ? " · ±" + Math.round(location.accuracy) + " " + t("metres") : ""}</span>
				</div>
				<button type="button" className="m3-btn tonal location-card-open" onClick={(event) => setMenu(event.currentTarget)}>
					<IMap size={18} />
					<span>{t("locationOpenIn")}</span>
				</button>
			</div>
			{menu ? (
				<Menu
					anchor={menu}
					onClose={() => setMenu(null)}
					items={mapLinks(location).map((link) => ({ key: link.id, label: link.label, icon: <IMap size={18} />, onSelect: () => window.open(link.url, "_blank", "noopener,noreferrer") }))}
				/>
			) : null}
		</div>
	)
}

// A shared contact card: a FrontierX account (open a chat or add them), or a
// name with a phone number or e-mail that can be saved to the device.
export function ContactBubble(props: { contact: ContactPayload; onMessage?: (username: string) => void }) {
	const { t } = useSettings()
	const { contact } = props
	const saveCard = () => {
		const url = URL.createObjectURL(new Blob([contactVCard(contact)], { type: "text/vcard;charset=utf-8" }))
		const link = document.createElement("a")
		link.href = url
		link.download = (contact.displayName || "contact").replace(/[\\/:*?"<>|]+/g, "_") + ".vcf"
		document.body.appendChild(link)
		link.click()
		link.remove()
		window.setTimeout(() => URL.revokeObjectURL(url), 2000)
	}
	return (
		<div className="contact-card">
			<div className="contact-card-head">
				<Avatar label={contact.displayName} seed={contact.userId ?? contact.displayName} size={48} />
				<div className="contact-card-text">
					<span className="contact-card-name">{contact.displayName}</span>
					{contact.username ? <span className="contact-card-sub">@{contact.username}</span> : null}
					{contact.phone ? <a className="contact-card-sub contact-card-link" href={"tel:" + contact.phone.replace(/[^+\d]/g, "")}><IPhone size={14} /> {contact.phone}</a> : null}
					{contact.email ? <a className="contact-card-sub contact-card-link" href={"mailto:" + contact.email}><IMail size={14} /> {contact.email}</a> : null}
				</div>
				<span className="contact-card-icon" aria-hidden="true"><IContact size={18} /></span>
			</div>
			<div className="contact-card-actions">
				{contact.username && props.onMessage ? (
					<button type="button" className="m3-btn tonal" onClick={() => props.onMessage?.(contact.username as string)}>
						<IChat size={18} />
						<span>{t("contactMessage")}</span>
					</button>
				) : null}
				{contact.phone || contact.email ? (
					<button type="button" className="m3-btn text" onClick={saveCard}>
						<IDownload size={18} />
						<span>{t("contactSave")}</span>
					</button>
				) : null}
			</div>
		</div>
	)
}
