import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import { api } from "../lib/api"
import { errorText } from "../lib/errorText"
import type { Conversation, Friend } from "../lib/types"
import { useSettings } from "../state/settings"
import { SegToggle } from "./SegToggle"
import { Avatar, Banner, Button, Chip, ListGroup, ListItem, Sheet, TextField } from "./m3"
import { IAdd, IBot, IClose, IPeople } from "./m3icons"

export function NewConversationDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (conversation: Conversation) => void
}) {
  const { t } = useSettings()
  const [kind, setKind] = useState<"group" | "channel">("group")
  const [title, setTitle] = useState("")
  const [selected, setSelected] = useState<Friend[]>([])
  const [query, setQuery] = useState("")
  const [friends, setFriends] = useState<Friend[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void api.listFriends().then((res) => { if (active) setFriends(res.friends) }).catch(() => {})
    return () => { active = false }
  }, [])

  const selectedIds = new Set(selected.map((f) => f.id))
  const q = query.trim().toLowerCase()
  const suggestions = friends.filter((f) => !selectedIds.has(f.id) && (q === "" || (f.displayName || "").toLowerCase().includes(q) || f.username.toLowerCase().includes(q)))

  function addUser(item: Friend) {
    setSelected((prev) => (prev.some((f) => f.id === item.id) ? prev : [...prev, item]))
    setQuery("")
  }
  function removeSel(id: string) {
    setSelected((prev) => prev.filter((f) => f.id !== id))
  }

  async function onSubmit(e?: FormEvent) {
    e?.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await api.createConversation({
        kind,
        title: title.trim() || undefined,
        memberUsernames: selected.length > 0 ? selected.map((f) => f.username) : undefined,
      })
      onCreated(res.conversation)
    } catch (err) {
      setError(errorText(err, t("createConversationFailed")))
      setBusy(false)
    }
  }

  return (
    <Sheet title={kind === "channel" ? t("newChannel") : t("newGroup")} icon={<IPeople />} iconShape={kind === "channel" ? "clover" : "cookie"} iconTone="green" onClose={onClose} size="md"
      actions={
        <>
          <Button variant="text" onClick={onClose}>{t("cancel")}</Button>
          <Button variant="filled" busy={busy} onClick={() => void onSubmit()}>{busy ? t("creating") : kind === "channel" ? t("newChannel") : t("newGroup")}</Button>
        </>
      }
    >
      {error ? <Banner tone="error">{error}</Banner> : null}
      <SegToggle options={[{ value: "group", label: t("kindGroup") }, { value: "channel", label: t("kindChannel") }]} value={kind} onChange={(next) => setKind(next)} ariaLabel={t("newGroup")} />
      <TextField label={t("groupName")} value={title} maxLength={80} onChange={setTitle} autoFocus onEnter={() => void onSubmit()} />
      <div className="m3-list-section">
        <div className="m3-list-label">{t("members")}</div>
        {selected.length > 0 ? (
          <div className="m3-chip-row member-chips">
            {selected.map((f) => (
              <Chip key={f.id} selected icon={<IClose size={14} />} onClick={() => removeSel(f.id)}>{f.displayName || f.username}</Chip>
            ))}
          </div>
        ) : null}
        <TextField label={t("typeUsername")} value={query} onChange={setQuery} supporting={t("onlyFriendsHint")} />
        {suggestions.length > 0 ? (
          <ListGroup>
            {suggestions.slice(0, 20).map((f) => (
              <ListItem
                key={f.id}
                leading={<Avatar src={f.avatar} label={f.displayName || f.username} seed={f.id} size={36} />}
                title={<>{f.displayName || f.username}{(f as { isBot?: boolean }).isBot ? <span className="bot-badge"><IBot size={11} /> BOT</span> : null}</>}
                subtitle={"@" + f.username}
                onClick={() => addUser(f)}
                trailing={<IAdd size={18} />}
              />
            ))}
          </ListGroup>
        ) : friends.length === 0 ? (
          <p className="settings-intro">{t("noFriendsYet")}</p>
        ) : null}
      </div>
    </Sheet>
  )
}
