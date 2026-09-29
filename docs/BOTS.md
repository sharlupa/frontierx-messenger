# FrontierX bots

A bot is an account you control from your own program. Chats with bots stay
end-to-end encrypted: the bot holds its own identity key, members' apps hand
it copies of the chat keys wrapped for that key, and the server only relays
ciphertext.

Боты FrontierX — аккаунты, которыми управляет ваша программа. Переписка с ботом
остаётся сквозь зашифрованной: у бота свой ключ, приложения участников передают
ему ключи чатов, сервер видит только шифротекст. Ниже — SDK для Node.js и
описание Bot API.

## Quick start

1. In the app: **Settings → Bots & API → Create bot**. Copy the token (`fxb_…`);
   it is shown once. A new token can be issued at any time, the old one stops
   working immediately.
2. Download the SDK (one file, no dependencies, Node.js 20+):

   ```sh
   curl -O https://frontierx.zkito.fun/sdk/frontierx-bot.mjs
   ```

3. Write the bot:

   ```js
   import { FrontierXBot, format } from "./frontierx-bot.mjs"

   const bot = new FrontierXBot({
     token: process.env.FRONTIERX_BOT_TOKEN,
     stateFile: "./frontierx-bot-state.json", // the bot's identity key: keep it private
   })

   bot.command("start", (ctx) => ctx.reply("Hello, " + format.bold(ctx.sender.displayName) + "!"))
   bot.command("where", (ctx) => bot.sendLocation(ctx.conversationId, { lat: 55.7539, lon: 37.6208, label: "Red Square" }))
   bot.on("text", (ctx) => ctx.reply("You said: " + ctx.text))
   bot.on("media", async (ctx) => {
     const bytes = await ctx.download() // decrypted attachment
     await ctx.reply(ctx.media.name + ": " + bytes.length + " bytes")
   })
   bot.command("plans", (ctx) => ctx.reply("Choose a plan:", {
     buttons: [
       [{ text: "Month", data: "buy:month" }, { text: "Year", data: "buy:year" }],
       [{ text: "Help", url: "https://example.com/help" }],
     ],
   }))
   bot.action(/^buy:(month|year)$/, async (ctx) => {
     await ctx.answer("Invoice created")               // a short notice for the person
     await ctx.edit("Plan: " + ctx.match[1], { buttons: [[{ text: "Pay", url: "https://pay.example.com/…" }]] })
   })
   bot.command("photo", (ctx) => ctx.replyWithPhoto("./qr.png", { caption: "Scan to connect" }))
   bot.command("config", (ctx) => ctx.replyWithFile(Buffer.from("vless://…"), { name: "vpn.conf" }))
   bot.on("error", ({ error }) => console.error(error))

   await bot.start()
   ```

4. `FRONTIERX_BOT_TOKEN=fxb_… node bot.mjs`, then open the bot in the app
   (its username in search, or **Open chat with the bot** in its settings).

## SDK reference

`new FrontierXBot(options)`

| option | default | |
| --- | --- | --- |
| `token` | `FRONTIERX_BOT_TOKEN` | the bot token |
| `baseUrl` | `FRONTIERX_URL` or `https://frontierx.zkito.fun` | must be https (plain http only for localhost) |
| `stateFile` | `./frontierx-bot-state.json` | identity key and update offset, written with mode 0600 |
| `pollTimeout` | `45` | long-polling timeout, seconds (0-50) |
| `logger` | `console` | |

Events (`bot.on(name, handler)`), handlers get a context `ctx`:

| event | when |
| --- | --- |
| `text`, `media`, `location`, `contact` | a new message of that kind (commands with a handler are not repeated here) |
| `message` | every new message, after the kind-specific event |
| `edited` | a message was edited |
| `deleted` | a message was deleted (`ctx.messageId`) |
| `conversation` | the bot was started or added to a group (`ctx.send(text)`) |
| `callback` | a button was pressed and no `bot.action` matched it |
| `update` | any other update |
| `error` | a handler threw or a request failed (`{ error, ctx?, update? }`) |

`bot.command(name, handler)` handles `/name args`; `ctx.command` and `ctx.args`
are set. Commands registered this way are published to the app's command
suggestions (descriptions can be edited in the app or with `setCommands`).

Context fields: `conversationId`, `conversation`, `message` (id, senderId,
createdAt, replyTo, silent), `sender` (id, username, displayName, isBot),
`kind`, `text`, `media`, `location`, `contact`, `edited`, and the helpers
`reply(text, { silent })`, `send(text, { replyTo, silent })`, `typing()`,
`download()`, `replyWithFile(input, options)`, `replyWithPhoto(…)`, `replyWithVideo(…)`.

Methods: `sendText(conversationId, text, { replyTo, silent })`,
`sendLocation(conversationId, { lat, lon, label, accuracy })`,
`sendContact(conversationId, { displayName, username, userId, phone, email })`,
`sendFile(conversationId, input, options)`, `sendPhoto(…)`, `sendVideo(…)`, `sendDocument(…)`,
`editText(conversationId, messageId, text)`, `deleteMessage(conversationId, messageId)`,
`sendTyping(conversationId)`, `leave(conversationId)`, `setCommands([{ command, description }])`,
`getConversations()`, `getConversation(conversationId)`, `downloadMedia(media)`,
`start()`, `stop()`, `webhookHandler(secret)`, `setWebhook(url, secret)`, `deleteWebhook()`.

Formatting helpers: `format.bold`, `italic`, `strike`, `code`, `pre`, `quote`,
`spoiler` — the same markup the apps use (`*bold*`, `_italic_`, `~strike~`,
`` `code` ``, `||spoiler||`).

Silent messages (`{ silent: true }`) arrive without sound or notification.

### Buttons under messages

Pass `buttons` to `sendText`, `reply`, `editText`/`ctx.edit` or `sendFile`/`sendPhoto`/`sendVideo`:
rows (up to 8) of buttons (up to 8 per row). A button is `{ text, data }` — the
press comes back to the bot — or `{ text, url }`, which opens an http(s) link.
Labels are up to 64 characters, `data` up to 256.

`bot.action(pattern, handler)` handles presses whose data equals the string or
matches the RegExp (`ctx.match`). The context has `data`, `from` (who pressed),
`conversationId`, `messageId`, `answer(text?, { alert })`, `edit(text, { buttons })`,
`reply(text, options)` and `send(text, options)`. The press is answered
automatically when the handler returns; call `ctx.answer("…")` to show the
person a short notice (a toast, or a dialog with `alert: true`). Editing without
`buttons` removes them.

What a button carries travels sealed with the chat key, like the messages:
the server only relays it to the bot that sent the message.

### Files, photos and videos

`input` is a file path, a `Buffer` or a `Uint8Array`. Options: `name`, `mime`
(guessed from the extension), `caption`, `spoiler` (photos and videos arrive
blurred until tapped), `replyTo`, `silent`, and for videos `duration` (seconds)
and `poster` (a small `data:image/jpeg;base64,…` preview). Photo sizes are read
from PNG, GIF and JPEG files automatically. Photos show as photos, videos play
in the chat, everything else arrives as a file with a download button.

The SDK encrypts the file on your side with a new key per file, uploads only
the ciphertext and puts the key into the (encrypted) message — the server never
sees the file, its name or its type. Limits are the same as for people (1 GB
per file, the account's storage quota); the whole file is held in memory while
it is encrypted.

### Webhooks instead of polling

```js
import { createServer } from "node:http"
const secret = "a-long-random-string"
await bot.setWebhook("https://bot.example.com/frontierx", secret)
createServer(bot.webhookHandler(secret)).listen(8443)
```

Webhooks must be public `https://` addresses (private and local addresses are
refused). Every delivery carries the header `x-frontierx-bot-secret`; the
handler rejects requests without the right secret. After 20 failed deliveries
in a row the webhook is switched off and updates wait for `getUpdates`.

## Bot API (HTTP)

Base: `https://frontierx.zkito.fun/api/bot/v1/<method>`, header
`Authorization: Bot <token>`. Answers are `{ "ok": true, "result": … }` or an
HTTP error with `{ "error": "…" }`. GET methods take query parameters, POST
methods a JSON body. Limit: 120 requests per second per bot; sending 30 per
second, 60 per minute in a direct chat, 20 per minute in a group.

| method | | parameters |
| --- | --- | --- |
| `getMe` | GET | — |
| `setIdentityKey` | POST | `publicKey` (base64 raw P-256) |
| `getUpdates` | GET | `offset`, `limit` (≤100), `timeout` (s, ≤50) |
| `setWebhook` / `deleteWebhook` / `getWebhookInfo` | POST/POST/GET | `url`, `secret` |
| `setCommands` | POST | `commands: [{ command, description }]` |
| `getConversations` | GET | — |
| `getConversation` | GET | `conversationId` |
| `getMessages` | GET | `conversationId`, `limit`, `before` |
| `sendMessage` | POST | `conversationId`, `ciphertext`, `replyTo?`, `silent?` |
| `editMessage` | POST | `conversationId`, `messageId`, `ciphertext` |
| `deleteMessage` | POST | `conversationId`, `messageId` |
| `sendTyping` | POST | `conversationId` |
| `leaveConversation` | POST | `conversationId` |
| `getKeys` | GET | `conversationId` |
| `createKeyEpoch` | POST | `conversationId`, `keyId`, `expectedCurrentKeyId`, `check`, `shares` |
| `shareKeys` | POST | `conversationId`, `shares` |
| `rejectKey` | POST | `conversationId`, `keyId` |
| `createFile` | POST | `conversationId`, `name` and `mime` (both sealed like a message), `size` → `{ fileId }` |
| `uploadFile` | POST | query `fileId`, body: the encrypted bytes |
| `answerCallback` | POST | `callbackId`, `text?` (sealed), `alert?` |
| `downloadFile` | GET | `fileId` (returns the encrypted bytes) |

Updates: `message`, `message_edited` (`conversationId`, `conversation`,
`message`, `sender`), `message_deleted` (`conversationId`, `messageId`),
`conversation_added` (`conversation`, `addedBy` or `startedBy`),
`keys_updated` (`conversationId`), `callback` (`callbackId`, `conversationId`,
`messageId`, `from`, `data` sealed with the chat key). Each has an `updateId`; asking for
`offset = updateId + 1` acknowledges everything before it.

### Encryption, for your own client

- Identity key: ECDH P-256; the public key is the raw point in base64.
- Chat keys: 32 random bytes, named `k_<base64url of 12 bytes>` (the first key
  of older chats is named `legacy`).
- A copy for a member (`shares`): ECDH with a fresh P-256 key, HKDF-SHA256
  (salt `fx:share:<conversationId>:<keyId>`, info `fx:share:v2`), AES-256-GCM
  with additional data `fx:share:v2:<conversationId>:<keyId>`.
- Messages: `fx2:<keyId>:<base64(iv ‖ ciphertext)>`, AES-256-GCM, additional
  data `fx2|<conversationId>|<keyId>`. Sending with a key that is not the
  chat's current one is refused with `409 conversation key changed`.
- `check` for a new key: AES-GCM of `frontierx-conversation-key` under the key,
  additional data `fx:cek-check:v1:<conversationId>:<keyId>`, as base64(iv ‖ ct).

The SDK source is the reference implementation of all of this.

## Security

- The token opens the Bot API only: no user route accepts it, bots cannot sign
  in, send friend requests, create bots or place calls.
- A bot sees only chats it was started in or added to (groups only when
  **Can join groups** is on), and only messages sent after it joined, in
  encrypted form.
- Only the token's hash is stored on the server. Keep the token and the state
  file secret; if either leaks, issue a new token in the app (and delete the
  state file to get a new identity key: members re-share the keys).
- Webhook addresses are checked against private and local networks on every
  delivery.
