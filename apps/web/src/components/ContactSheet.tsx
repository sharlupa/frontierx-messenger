import { useEffect, useState } from "react"
import { api } from "../lib/api"
import type { ContactPayload } from "../lib/richmsg"
import type { Friend } from "../lib/types"
import { useSettings } from "../state/settings"
import { LoadingBlock } from "./Expressive"
import { SegToggle } from "./SegToggle"
import { Avatar, Button, ListGroup, ListItem, Sheet, TextField } from "./m3"
import { IContact } from "./m3icons"

// Sharing a contact: one of your FrontierX friends (tap to open a chat with
// them), or a card with a name and a phone number or e-mail.
export function ContactSheet(props: { onClose: () => void; onSend: (contact: ContactPayload) => void }) {
	const { t } = useSettings()
	const [tab, setTab] = useState<"friends" | "manual">("friends")
	const [friends, setFriends] = useState<Friend[] | null>(null)
	const [query, setQuery] = useState("")
	const [name, setName] = useState("")
	const [phone, setPhone] = useState("")
	const [email, setEmail] = useState("")

	useEffect(() => {
		let active = true
		void api.listFriends().then((res) => { if (active) setFriends(res.friends) }).catch(() => { if (active) setFriends([]) })
		return () => { active = false }
	}, [])

	const term = query.trim().toLocaleLowerCase()
	const list = (friends ?? []).filter((friend) => !term || (friend.displayName || friend.username).toLocaleLowerCase().includes(term) || friend.username.toLocaleLowerCase().includes(term))
	const manualValid = name.trim().length > 0 && (phone.trim().length > 0 || email.trim().length > 0)

	const send = (contact: ContactPayload) => {
		props.onSend(contact)
		props.onClose()
	}

	return (
		<Sheet title={t("contactTitle")} icon={<IContact />} iconShape="cookie" iconTone="blue" onClose={props.onClose} size="md"
			actions={tab === "manual" ? (
				<>
					<Button variant="text" onClick={props.onClose}>{t("cancel")}</Button>
					<Button variant="filled" disabled={!manualValid} onClick={() => send({ displayName: name.trim(), phone: phone.trim() || null, email: email.trim() || null })}>{t("send")}</Button>
				</>
			) : undefined}
		>
			<SegToggle options={[{ value: "friends", label: t("contactFriends") }, { value: "manual", label: t("contactManual") }]} value={tab} onChange={setTab} ariaLabel={t("contactTitle")} />
			{tab === "friends" ? (
				<>
					<TextField label={t("searchChats")} type="search" value={query} onChange={setQuery} />
					{!friends ? (
						<LoadingBlock size={40} />
					) : list.length === 0 ? (
						<p className="settings-intro">{t("noFriendsYet")}</p>
					) : (
						<ListGroup>
							{list.map((friend) => (
								<ListItem
									key={friend.id}
									leading={<Avatar src={friend.avatar} label={friend.displayName || friend.username} seed={friend.id} size={40} />}
									title={friend.displayName || friend.username}
									subtitle={"@" + friend.username}
									onClick={() => send({ userId: friend.id, username: friend.username, displayName: friend.displayName || friend.username })}
								/>
							))}
						</ListGroup>
					)}
				</>
			) : (
				<>
					<TextField label={t("contactName")} value={name} maxLength={80} onChange={setName} autoFocus />
					<TextField label={t("contactPhone")} type="tel" inputMode="tel" autoComplete="off" value={phone} maxLength={40} onChange={setPhone} />
					<TextField label={t("emailAddress")} type="email" inputMode="email" autoComplete="off" value={email} maxLength={120} onChange={setEmail} />
				</>
			)}
		</Sheet>
	)
}
