/* FrontierX — витрина: язык, определение системы и живые версии из манифеста обновлений. */
(function () {
	"use strict"

	var LANG_KEY = "frontierx.lang"
	var TOKEN_KEY = "fx.token"
	var MANIFEST_URL = "/releases/manifest.json"

	function store(key) { try { return localStorage.getItem(key) } catch (e) { return null } }
	function save(key, value) { try { localStorage.setItem(key, value) } catch (e) {} }

	var EN = {
		"nav.home": "Home",
		"nav.features": "Features",
		"nav.menu": "Menu",
		"nav.aria": "Main menu",
		"foot.product": "Product",
		"foot.account": "Account",
		"foot.docs": "Documents",
		"foot.sums": "Checksums",
		"home.title": "FrontierX — end-to-end encrypted messenger",
		"home.eyebrow": "End-to-end encryption by default",
		"home.h1": "Conversations <em>only you can see</em>",
		"home.lede": "Messages, files and calls are encrypted right on your device. Open FrontierX in the browser or install the app — your history follows you everywhere.",
		"home.cta1": "Download the app",
		"home.cta2": "Open in browser",
		"home.fact1": "Free",
		"home.fact2": "No phone number",
		"home.fact3": "No ads or trackers",
		"home.mock.av": "T",
		"home.mock.name": "Team",
		"home.mock.state": "3 online",
		"home.mock.m1": "Call at 6 pm?",
		"home.mock.m2": "Yes, I’ll send the mock-up first",
		"home.mock.m3": "Deal 👍",
		"home.mock.input": "Message",
		"home.chip1": "End-to-end encrypted",
		"home.chip2": "Call 12:48",
		"home.why.eyebrow": "Why FrontierX",
		"home.why.t": "Everything you need to talk. Nothing extra about you.",
		"home.t1.t": "Your keys stay with you",
		"home.t1.d": "The encryption key is created on your device and never leaves it. The server only keeps ciphertext — not even it can read your chats.",
		"home.more": "Learn more",
		"home.t2.t": "Protected calls",
		"home.t2.d": "Voice travels encrypted and the server never records it. You can share your screen.",
		"home.t3.t": "Files up to 1 GB",
		"home.t3.d": "Photos, videos and documents are encrypted before they are sent.",
		"home.t4.t": "Voice messages",
		"home.t5.t": "Polls and quizzes",
		"home.poll.a": "Friday",
		"home.poll.b": "Saturday",
		"home.t6.t": "Folders, archive and disappearing messages",
		"home.chip.all": "All",
		"home.chip.work": "Work",
		"home.chip.home": "Personal",
		"home.t7.t": "Eight themes and lively motion",
		"home.how.eyebrow": "How it works",
		"home.how.t": "Encryption you never have to think about",
		"home.s1.t": "A key on your device",
		"home.s1.d": "When you sign up, the app creates a key pair. The private key is kept only by you.",
		"home.s2.t": "Encrypted before sending",
		"home.s2.d": "Messages and files are encrypted with the chat key while still on your device.",
		"home.s3.t": "The server sees ciphertext",
		"home.s3.d": "It only delivers the data. Only the chat members can decrypt it.",
		"home.how.more": "What exactly the server keeps",
		"home.get.eyebrow": "On every device",
		"home.get.t": "Install it wherever you like",
		"home.web": "Browser",
		"home.web.v": "no install",
		"home.cta.t": "Start chatting in a minute",
		"home.cta.d": "All you need is a username and a password. Email is optional and only used to reset your password.",
		"home.cta.reg": "Create an account",
		"home.cta.feat": "All features",
		"home.apple": "iPhone and Mac",
		"home.apple.v": "from Safari",
		"nav.source": "Code",
		"nav.source.long": "Source code on GitHub",
		"foot.source": "Source code on GitHub",
		"foot.license": "GPL-3.0 license",
		"dl.src.t": "Open source",
		"dl.src.d": "All of FrontierX is open source under the GPL-3.0: the server, the web version, the apps and the bot SDK. You can build the apps yourself.",
		"dl.src.cta": "Open on GitHub",
		"feat.priv.7": "Open source under the GPL-3.0 — <a href=\"https://github.com/sharlupa/frontierx-messenger\" target=\"_blank\" rel=\"noopener\">on GitHub</a>",
		"feat.title": "Features — FrontierX",
		"feat.eyebrow": "Features",
		"feat.h1": "Everything for talking — <em>under encryption</em>",
		"feat.lede": "The features you expect from a modern messenger, where only the participants can see what is said.",
		"feat.nav.chat": "Messages",
		"feat.nav.voice": "Voice",
		"feat.nav.calls": "Calls",
		"feat.nav.media": "Files and media",
		"feat.nav.groups": "Groups and channels",
		"feat.nav.organize": "Staying organised",
		"feat.nav.privacy": "Privacy",
		"feat.nav.look": "Appearance",
		"feat.nav.platforms": "Devices",
		"feat.chat.t": "Messaging the way you’re used to",
		"feat.chat.d": "Personal chats start with a friend request — only people you accepted can write to you.",
		"feat.chat.1": "Replies, forwarding, editing and deleting",
		"feat.chat.2": "Reactions, @mentions and pinned messages",
		"feat.chat.3": "Formatting: <b>*bold*</b>, _italic_, ~strikethrough~, `code` and quotes",
		"feat.chat.4": "Link previews, stickers and GIFs",
		"feat.chat.5": "Drafts sync between devices, encrypted",
		"feat.chat.6": "Offline, a message waits for the network and goes out by itself",
		"feat.chat.7": "Search across all chats and messages right on the device, and chat export to HTML",
		"feat.art.chat1": "Look what came out",
		"feat.art.chat2": "Fire!",
		"feat.art.chat3": "Shipping",
		"feat.art.chat4": "take a look before tonight",
		"feat.voice.t": "Voice messages",
		"feat.voice.d": "Record a voice message with one tap: while recording you see the time and the sound level, and you can discard it right away.",
		"feat.voice.1": "Waveform and tap-to-seek",
		"feat.voice.2": "Playback speed 1×, 1.5× and 2×",
		"feat.voice.3": "Recordings are encrypted like any other file",
		"feat.calls.t": "Calls and screen sharing",
		"feat.calls.d": "Voice calls in personal chats and groups. Audio travels encrypted; the server only helps devices find each other.",
		"feat.calls.1": "Group calls right inside a group chat",
		"feat.calls.2": "Screen sharing during a call",
		"feat.calls.3": "A “you can be heard” meter, and calls ring your phone even when the app is closed",
		"feat.calls.4": "You can allow calls only from contacts or specific people",
		"feat.media.t": "Files, photos and videos up to 1 GB",
		"feat.media.d": "An attachment is encrypted in your browser or app first and only then uploaded. The server never gets the file key.",
		"feat.media.1": "Several files at once, with a caption",
		"feat.media.2": "Full-screen photo and video viewer with swipes",
		"feat.media.3": "A gallery of every photo and video in a chat",
		"feat.media.4": "Videos with a cover and duration that play right in the chat",
		"feat.art.upload": "Sending · 68 MB",
		"feat.groups.t": "Groups, channels and polls",
		"feat.groups.d": "Groups for discussions and channels for announcements. Roles decide who can post and manage.",
		"feat.groups.1": "Roles: owner, admin, member and read-only",
		"feat.groups.2": "Invite by link or QR code — with an expiry you choose",
		"feat.groups.3": "Comments on channel posts",
		"feat.groups.4": "Single- and multiple-choice polls, and quizzes",
		"feat.groups.5": "If you prefer, nobody can add you to a group without your consent",
		"feat.art.poll": "When do we meet?",
		"feat.art.poll3": "Sunday",
		"feat.art.votes": "25 votes",
		"feat.org.t": "Staying organised",
		"feat.org.d": "Sort chats into folders, move the rest to the archive and don’t keep what you don’t need.",
		"feat.org.1": "Folders such as “Work” and “Personal”",
		"feat.org.2": "Archive and muting",
		"feat.org.3": "Disappearing messages: after an hour, a day, a week or 30 days",
		"feat.org.4": "“Saved messages” — a private chat for notes and saved messages",
		"feat.art.ttl": "Disappearing messages",
		"feat.art.ttl2": "After 24 hours",
		"feat.priv.t": "Private by default",
		"feat.priv.d": "Messages, files and drafts are encrypted on your device. The server knows where to deliver data, but not what it says.",
		"feat.priv.1": "Sign up without a phone number; email is optional",
		"feat.priv.2": "Choose who sees you online, your last seen time and who can call you — with exceptions",
		"feat.priv.3": "Ghost mode: nobody sees you online or when you were last here, and read receipts are not sent",
		"feat.priv.4": "A list of your devices and one-tap sign-out of all others",
		"feat.priv.5": "Delete your account with all its data — even without signing in",
		"feat.priv.more": "Privacy policy",
		"feat.art.ghost": "Ghost mode",
		"feat.art.ghost2": "You are invisible",
		"feat.art.on": "On",
		"feat.art.dev": "3 devices",
		"feat.art.dev2": "Sign out the others",
		"feat.look.t": "Make it yours",
		"feat.look.d": "A Material 3 Expressive interface: living shapes, wavy indicators and springy motion.",
		"feat.look.1": "Eight themes and your own accent colour",
		"feat.look.2": "Russian and English",
		"feat.look.3": "Animations: expressive or minimal — the system setting is respected",
		"feat.plat.t": "One conversation on every device",
		"feat.plat.d": "Apps for Windows, Linux and Android, the web version in a browser, and on iPhone and Mac — install from Safari. Sign in on a new device and your history is already there.",
		"feat.plat.1": "The apps update themselves",
		"feat.plat.2": "Notifications on Android without Google services — via UnifiedPush",
		"feat.plat.3": "The web version can be installed as an app",
		"feat.chat.8": "Spoilers for text, photos and videos",
		"feat.chat.9": "Send later and send without sound",
		"feat.media.5": "Location with a map and contact cards — inside the encrypted message",
		"feat.priv.6": "Keys come back with your password, a recovery key or another device — chats are never lost",
		"feat.plat.4": "Several accounts in one app or browser",
		"feat.plat.5": "The iPhone and macOS apps are built on a Mac",
		"feat.nav.bots": "Bots & API",
		"feat.bots.t": "Bots and API",
		"feat.bots.d": "Create a bot in the settings and drive it from your own program: a Node.js SDK, long polling or webhooks.",
		"feat.bots.1": "Chats with bots are encrypted too — a bot has its own key",
		"feat.bots.2": "Bot commands are suggested right in the message field",
		"feat.bots.6": "Buttons under messages — plan choice, menus, payment links",
		"feat.bots.5": "Bots send photos, videos and files — encrypted too",
		"feat.bots.3": "The token opens only the Bot API and only the chats the bot was added to",
		"feat.bots.4": "Delete a bot and its chats disappear with the conversation",
		"feat.bots.more": "Docs and SDK",
		"feat.art.bot1": "Hi! I am the weather bot.",
		"feat.art.bot2": "+18° and sunny",
		"feat.art.bot3": "Bot · encrypted",
		"dl.page.title": "Download — FrontierX",
		"ch.eyebrow": "Updates",
		"pp.eyebrow": "Documents",
		"da.eyebrow": "Account",
		"pp.title": "Privacy Policy — FrontierX",
		"pp.1": "Privacy Policy",
		"pp.2": "Version of 26 September 2026. This page explains what data FrontierX actually keeps on its server, who may gain access to it, and on what terms you use the service.",
		"pp.3": "1. Who processes the data",
		"pp.4": "FrontierX is a private non-commercial project. The service runs on a single rented server and is maintained by the author of the project. There is no company, legal entity or staff behind it. Administrator access to the server belongs to the author of the project and, technically, to the hosting provider.",
		"pp.5": "2. Account data",
		"pp.6": "When you register and use the service, the server keeps:",
		"pp.7": "your username and display name — in the clear;",
		"pp.8": "a hash of your password — the password itself is not stored and cannot be recovered;",
		"pp.9": "the date the account was created;",
		"pp.10": "your avatar, if you uploaded one;",
		"pp.11": "your email address and whether it has been confirmed — only if you linked an email;",
		"pp.12": "privacy settings: who sees your online status and last seen time, who may call you, exceptions to these rules, group invitations only with consent, ghost mode;",
		"pp.12a": "the time of your last visit — when you were last online. Others see it only as your “Last seen time” setting allows, and it is not recorded in ghost mode.",
		"pp.13": "Phone numbers, identity documents, payment details and location are never requested and never stored.",
		"pp.14": "3. Conversations",
		"pp.15": "Message texts are stored on the server <b>only in encrypted form</b>. Conversation keys are created on the participants devices and the server does not have them: the content of messages cannot be read by the server. Drafts of unsent messages are synchronised between your devices in encrypted form as well.",
		"pp.16": "Together with the ciphertext the server keeps the service fields without which delivery is impossible: the message identifier, the chat, the sender, the time it was sent, the time it was edited, the deletion flag and a reference to the message you replied to.",
		"pp.17": "4. Files, stickers and avatars",
		"pp.18": "The contents of the files you send are kept in a separate file storage on the server in encrypted form. The file name and its type are encrypted on your device too, so the server does not see them. What stays in the clear in the database is the file size, who uploaded it, to which chat and when. Uploaded stickers and avatars are stored on the server as ordinary images and are not encrypted.",
		"pp.19": "5. Metadata the server sees in the clear",
		"pp.20": "Encryption protects the content, but not the fact that you are communicating. The following is kept on the server in the clear:",
		"pp.21": "the list of chats, their type, group names and group avatars;",
		"pp.22": "the list of members, their roles, the date they joined, archive and muted-notification flags;",
		"pp.23": "who sent a message to whom and when, together with delivery and read receipts;",
		"pp.24": "reactions to messages and who left them;",
		"pp.25": "pinned and saved messages, and polls. The question and the answer options live inside the encrypted message and are invisible to the server; the database only keeps the number of options and who voted for which number;",
		"pp.26": "friend requests and group invitations. The invitation codes themselves are stored only as an irreversible hash: the invitation link cannot be reconstructed from the database and used to join a group.",
		"pp.27": "This metadata cannot be encrypted from the server without breaking the service itself: the server has to know where to deliver a message, who belongs to a conversation and whom to show in search. Account names and display names are needed for signing in and finding people, avatars are visible to anyone who can find you, and read receipts and the member list are needed for delivery and synchronisation. Some of this can be limited in the settings: ghost mode hides your presence, and accepting requests by invitation only narrows the circle of people who can write to you.",
		"pp.28": "This data shows whom you talk to and how often, even though the messages themselves are unreadable.",
		"pp.29": "6. Encryption keys",
		"pp.30": "The server keeps your public key and the chat keys in wrapped form — each one encrypted so that only a member of the chat can unwrap it. If you enabled the key backup, it is stored on the server encrypted with your password; the server cannot decrypt it. The private key of the device stays in the browser or in the app and is never sent to the server.",
		"pp.31": "7. Sessions and devices",
		"pp.32": "For every sign-in the following is kept: a hash of the session token, the device and browser label, the device identifier, and the times of creation, last activity and expiry. This is what lets you review your sign-ins and end the ones you do not need.",
		"pp.33": "8. IP addresses and logs",
		"pp.34": "IP addresses are not written to the database. They are used only in the memory of the server to limit the rate of sign-in, registration, password-reset and invitation attempts, and they disappear when the service restarts. No separate visit logs are kept for the site; the system journal of the server contains service records about start-ups and errors.",
		"pp.35": "There are no visitor counters, advertising pixels or third-party analytics on the site or in the app.",
		"pp.36": "9. What is kept on your device",
		"pp.37": "Your browser storage keeps: the session token, your profile, the private key of the device, the device identifier, frequently used emoji, and the theme and language you chose. Keys of open chats are held in the temporary storage of the tab and are erased when it is closed.",
		"pp.38": "Clearing the site data in your browser is equivalent to signing out and losing the keys on that device. Without a key backup, old messages cannot be decrypted afterwards.",
		"pp.39": "10. Calls",
		"pp.40": "Audio and video travel directly between participants and are encrypted by the WebRTC transport. Service servers are used to establish the connection: the own server of the project, the public STUN of Google and a third-party public TURN relay. When a direct connection is impossible, the stream goes through the relay. During a call your IP address becomes known to the other participant or to the relay in use. The service does not record calls.",
		"pp.41": "11. Email",
		"pp.42": "Email is used only to confirm your address and to reset your password. Letters are sent through a mail node on the server which relays them via Google, so the address of the recipient and the text of the letter pass through the infrastructure of Google. The database keeps a hash of the confirmation code, the address, the purpose of the code and the number of attempts; a code lives for 15 minutes.",
		"pp.43": "12. Third parties",
		"pp.44": "Besides the author of the project, the following may have access to the data to one degree or another:",
		"pp.45": "the hosting provider of the server — as the owner of the physical infrastructure and the disks;",
		"pp.46": "Cloudflare — the domain is proxied through it, so it sees IP addresses and request headers;",
		"pp.47": "the certificate authority Let us Encrypt — to the extent of the domain name when a certificate is issued;",
		"pp.48": "Google — when the letters with codes are sent;",
		"pp.48a": "Google (Firebase Cloud Messaging) — on Android phones with Google services, message and call notifications are delivered through it. Google sees the device token, the time of the notification, its kind (message or call) and the internal chat number. Notifications contain no names, no message text and no file contents;",
		"pp.49": "the operators of the STUN and TURN servers — to the extent of network addresses and, when relaying, the encrypted media stream.",
		"pp.50": "User data is not sold, is not handed to advertisers and is not used to train models.",
		"pp.51": "13. Retention and backups",
		"pp.52": "Messages, files and metadata are kept as long as the chat and the account exist: there is no automatic deletion by time. A deleted message is marked as deleted and stops being served to the other participants, but the record of the message itself remains in the database.",
		"pp.53": "The database is copied automatically to the same server on a schedule — hourly, daily and weekly copies, plus a few manual archives. Data deleted from the main database therefore survives in the backups for some time.",
		"pp.54": "14. What you can do",
		"pp.55": "You can change your name and avatar, link or unlink an email, end sessions on your devices, delete your own messages, leave chats, and delete your account together with all of your data — on your own, without contacting the author. Linking an email is voluntary: the account works without it, but password recovery will not be possible.",
		"pp.56": "17. Changes to this policy",
		"pp.57": "The policy may change together with the service. The current version is always on this page and its date is given at the top of the document. Continuing to use the service after a change means that you agree to the new version.",
		"pp.58": "18. Disclaimer and acceptance of risk",
		"pp.59": "The service is provided <b>as is</b> and <b>as available</b>, without any warranties, express or implied. Operability, availability, integrity of data, preservation of your conversations, confidentiality and protection against intrusion are not guaranteed.",
		"pp.60": "You use the service at your own risk. To the maximum extent permitted by applicable law, the author of the project, the server administrator and anyone helping to maintain it are not liable for indirect, incidental or consequential damages, lost profit or lost data arising from use of the service. Nothing in this section limits liability that cannot be limited by law, and nothing removes the obligations of the author under applicable data protection law or under the rules of the app stores through which the app is distributed.",
		"pp.61": "a breach of the server, theft of the database, of files, of keys or of metadata;",
		"pp.62": "a leak, publication or distribution of your data by third parties;",
		"pp.63": "leaks caused by a vulnerability in third-party software, a configuration mistake, or events outside the reasonable control of the author;",
		"pp.64": "loss of data, a failure, corruption of the database, an unsuccessful restore from a backup;",
		"pp.65": "suspension or complete shutdown of the service without warning and without a chance to export your data;",
		"pp.66": "actions of the hosting provider, of Cloudflare, of mail services, of the STUN and TURN servers;",
		"pp.67": "actions of other users, including forwarding and publishing your conversations;",
		"pp.68": "loss of access to your account or to your encryption keys on your side.",
		"pp.69": "By registering and continuing to use FrontierX you confirm that you understand the nature of the service and accept the described risks knowingly and voluntarily, to the extent permitted by applicable law.",
		"pp.70": "If such terms are unacceptable to you, do not create an account and do not upload data here. Do not place information in the service whose disclosure would be critical for you.",
		"pp.71": "15. Deleting your account",
		"pp.72": "You can delete the account yourself, without contacting the author. First way: in the app open the settings and confirm deletion with your password in the account deletion section. Second way: the page <a href='/delete-account'>frontierx.zkito.fun/delete-account</a> — it does not require signing in, only your username and password.",
		"pp.73": "What is deleted immediately and irreversibly:",
		"pp.74": "the user record: username, display name, avatar, linked email, password hash;",
		"pp.75": "all messages you sent and files you uploaded, together with their encrypted copies on the server;",
		"pp.76": "the key backup, sessions on all devices, push notification subscriptions;",
		"pp.77": "reactions, poll votes, read receipts, drafts, chat folders, stickers;",
		"pp.78": "friend requests, invite codes you created, membership in all chats;",
		"pp.79": "chats where you remained the only participant are deleted entirely.",
		"pp.80": "What remains: messages written by other participants in shared chats — that is their data. If someone saved the conversation on their own device or made a key backup, that copy is outside the control of the server.",
		"pp.81": "Database backups on the server are rotated on a schedule: hourly copies live about a day, daily ones about a week, weekly ones about a month. Deleted data disappears from them as the rotation goes on.",
		"pp.82": "Deletion is irreversible: the account, the conversations and the keys cannot be restored afterwards.",
		"pp.83": "16. Minimum age",
		"pp.84": "The service is not intended for children. You can create an account from the age of 13; in the European Economic Area and the United Kingdom from the age of 16, unless consent is given by a parent or legal guardian in the manner provided by local law. If the law of your country sets a higher minimum age, that age applies.",
		"pp.85": "The service does not knowingly collect data about children. If it becomes known that an account was created by a child below the permitted age, the account and the data linked to it will be deleted. There is no content moderation: conversations are encrypted and not visible to the author, so responsibility for what is communicated lies with the participants.",
		"pp.86": "The service does not collect or request location data: neither precise nor approximate location is used. During a call your IP address is temporarily visible to the signalling servers and to the other participant — this is how WebRTC works. The IP address is not written to the database.",
		"da.title": "Delete your account — FrontierX",
		"da.h1": "Delete your account",
		"da.lead": "Here you can delete your FrontierX account yourself — signing in is not required. Enter your username and password: the account, messages, files, keys and sessions are removed immediately and irreversibly.",
		"da.user": "Username",
		"da.pass": "Password",
		"da.confirm": "I understand that deletion is irreversible and the data cannot be restored.",
		"da.btn": "Delete account",
		"da.note": "What exactly is deleted and what remains is described in section 15 of the <a href='/privacy'>privacy policy</a>.",
		"da.link": "Delete account",
		"skip": "Skip to content",
		"ch.title": "What's new — FrontierX",
		"ch.h1": "What's new",
		"ch.lede": "Changes to the web version — the one that opens in a browser and runs inside the desktop and Android apps. The apps announce their own updates when they start.",
		"ch.s0929.date": "29 September 2026",
		"ch.s0929.i1.t": "Bots send files, photos and videos",
		"ch.s0929.i1.d": "Bots can now send photos, videos and any files — a QR code or a settings file, for example. The file is encrypted on the bot's side with its own key; the server sees neither the content nor the file name or type. The SDK has sendPhoto, sendVideo and sendFile for this, and photos and videos can go out as spoilers.",
		"ch.s0929.i3.t": "Buttons under bot messages",
		"ch.s0929.i3.d": "Bots can show buttons under their messages — Month and Year to pick a plan, say, or Pay with a link. A press reaches the bot encrypted; the bot can answer with a short notice and change the message with the buttons. Link buttons open the site in the browser.",
		"ch.s0929.i2.t": "Living shapes in windows",
		"ch.s0929.i2.d": "Icons in window headers and settings rows change shape again when you hover or touch them, and the shape morphs in when a window opens.",
		"ch.s0928.date": "28 September 2026",
		"ch.s0928.i1.t": "Encryption keys no longer get lost",
		"ch.s0928.i1.d": "Chats no longer disappear when you sign in on another device or browser. An account now has one main key: the server keeps it only in encrypted form, and it opens with your password, a recovery key or a confirmation from another of your devices. Chat keys no longer drift apart between devices and are never deleted, and after a password reset by e-mail your history comes back with the previous password. In Settings → Security and keys you can create a recovery key and compare safety codes with the person you talk to.",
		"ch.s0928.i2.t": "Several accounts",
		"ch.s0928.i2.d": "One app or browser can hold up to five accounts; switch between them in the menu under the chat list or in the settings. While one account is open, you see how many unread messages the others have.",
		"ch.s0928.i3.t": "Search across all chats",
		"ch.s0928.i3.d": "The field above the chat list finds people, chats and message text in every conversation; the shortcut is Ctrl+K. The Media, Links, Files, Voice and Places filters scroll sideways. Search runs right on your device: messages are decrypted there and the server never sees what you look for.",
		"ch.s0928.i4.t": "Location and contacts",
		"ch.s0928.i4.d": "The paperclip menu now has Location — where you are or any point on the map — and Contact: a friend from your list or a card with a phone number and e-mail. A place arrives as a card that opens in Yandex, Google or Apple Maps; the map itself loads only when someone opens it.",
		"ch.s0928.i5.t": "Spoilers",
		"ch.s0928.i5.d": "Hide text under a spoiler: select it and tap Spoiler, or wrap it in ||double bars||. Photos and videos can be marked as spoilers before sending — they stay blurred for the recipient until tapped.",
		"ch.s0928.i6.t": "Send later and send silently",
		"ch.s0928.i6.d": "Hold the send button or right-click it. Send without sound — the recipient gets no notification sound. Send later — pick a time and the server sends the message itself, even with your devices switched off. Scheduled messages are listed in the chat menu, where you can send them now, reschedule or delete them.",
		"ch.s0928.i7.t": "Bots and the Bot API",
		"ch.s0928.i7.d": "Settings has a new Bots & API section: create a bot, get its token and run it with the Node.js SDK — documentation at /sdk/README.md. Chats with bots are encrypted too; a bot has its own key. The token opens only the Bot API and only the chats the bot was added to; a deleted bot disappears from chats together with the conversation.",
		"ch.s0928.i8.t": "New settings and windows",
		"ch.s0928.i8.d": "The settings were rebuilt in the Material 3 Expressive style: sections with living shapes, a side menu on computers and a sheet sliding up on phones. The friends, members, forwarding, pinned, gallery, poll and folder windows follow the same style.",
		"ch.s0928.i9.t": "iPhone, Mac and Android 0.3.0",
		"ch.s0928.i9.d": "On iPhone and iPad FrontierX installs from Safari (Share → Add to Home Screen) and receives notifications with the app closed on iOS 16.4 and newer; voice messages recorded on an iPhone now play everywhere. The Android app 0.3.0 can send your location. There are now apps for iPhone and macOS — they can only be built on a Mac.",
		"ch.s0926.date": "26 September 2026",
		"ch.s0926.i1.t": "Last seen time",
		"ch.s0926.i1.d": "Under the name in a one-to-one chat you can now see when the person was last online: “last seen 5 minutes ago”, “today at 2:05 PM”, “yesterday at 9:10 PM” or a date. In groups the same shows in the member list. Privacy has a separate “Last seen time” setting — Everyone, Contacts or Nobody, with exceptions for individual people. Your previous choice for the online status now also applies to the time, so nobody’s time became visible on its own. People who cannot see your online status get the new time only after you leave, and ghost mode records nothing.",
		"ch.s0926.i3.t": "“Online” only while you are in the messenger",
		"ch.s0926.i3.d": "Your online status now shows only while you are actually looking at FrontierX. Switch to another tab, minimise the window or go to another app, and after a few seconds others see “last seen just now”; come back and you are online again. Calls are not interrupted and messages keep arriving as usual. In a one-to-one chat the header now says just “online” instead of “1 online”.",
		"ch.s0926.i2.t": "12-hour clock in English",
		"ch.s0926.i2.d": "The English interface shows time the way English writes it: “2:05 PM” instead of “14:05”. The device list now also follows the app’s language rather than the browser’s.",
		"ch.s0924.date": "24 September 2026",
		"ch.s0924.i7.t": "Android notifications without the ongoing notification",
		"ch.s0924.i7.d": "The Android app 0.2.3 receives message and call notifications through the phone’s own push channel, so the permanent “FrontierX is running in the background” notification is no longer needed. Only a “something arrived” signal and a chat number go through Google — no names and no text; the phone asks our server for the chat title itself. Phones without Google services work as before.",
		"ch.s0924.i8.t": "The desktop app lives in the tray",
		"ch.s0924.i8.d": "In version 0.2.1 for Windows and Linux the close button sends FrontierX to the tray, and the app starts with the system, so message and call notifications arrive even with the window closed. The tray menu turns autostart off or quits completely.",
		"ch.s0924.i9.t": "Colours from the website and shapes instead of circles",
		"ch.s0924.i9.d": "The dark and light themes now use the new website’s palette: soft tonal colours, with your own messages in a calm blue bubble. Groups get a cookie-shaped avatar and channels a clover, so the kind of chat shows at a glance. Sign-in screens and empty chats feature slowly morphing shapes. The previous colours live on in the “Telegram” theme.",
		"ch.s0924.i1.t": "New Material 3 Expressive look",
		"ch.s0924.i1.d": "The interface feels more alive: buttons change shape and spring back when pressed, the open chat is highlighted with a soft pill, dialogs and menus open with a springy motion, and new messages glide in from their side. Colours still follow your chosen theme.",
		"ch.s0924.i6.t": "Where the animations are",
		"ch.s0924.i6.d": "<ul class=\"ch-where\"><li><b>Buttons</b> — turn squarer and spring back when pressed; “New chat” rounds off on hover.</li><li><b>Message bar</b> — the microphone flips into “Send” while the button changes shape; the voice recording strip and the attachment strip slide up; the recording dot is a blob that keeps changing shape.</li><li><b>Conversation</b> — new messages glide in from their side with a slight overshoot and the sender’s avatar pops in; date labels fade in; “typing…” is shown as three bouncing dots.</li><li><b>Reactions</b> — pop in when they appear and grow on hover; in the reaction picker the emoji grow under the cursor.</li><li><b>Voice and video</b> — the ▶ button becomes a rounded square while playing; the video play button grows on hover; downloads show a wavy ring with the percentage.</li><li><b>Chat list</b> — the open chat turns into a pill and its avatar into a rounded square; unread counters and the online dot pop in; the active folder becomes a pill too.</li><li><b>Windows and menus</b> — open with a springy motion; notifications slide in from the top.</li><li><b>Loading</b> — a morphing shape while the app, a chat, an invite, comments, the device list or a photo loads; a wavy bar while a file is sent and in the photo viewer.</li><li><b>Settings and polls</b> — toggle thumbs slide with a spring; poll result bars grow smoothly and the chosen option changes shape.</li><li><b>On phones</b> — switching between the chat list and a conversation moves on a spring.</li></ul>",
		"ch.s0924.i2.t": "Animated loading indicators",
		"ch.s0924.i2.d": "Instead of \u201cLoading\u2026\u201d captions you now see a shape that morphs from one form to another. File uploads and video or voice downloads show a wavy bar or ring with the percentage.",
		"ch.s0924.i3.t": "The microphone flips into \u201cSend\u201d",
		"ch.s0924.i3.d": "As soon as you start typing, the microphone button flips over like a card and becomes the send button; clear the text and it flips back. The voice message play button also changes shape while playing.",
		"ch.s0924.i4.t": "Animation setting",
		"ch.s0924.i4.d": "Settings \u2192 Appearance now has an \u201cAnimations\u201d option: Expressive or Minimal. If reduced motion is turned on in your system, the app respects it.",
		"ch.s0924.i5.t": "Click outside to close",
		"ch.s0924.i5.d": "Every window, including settings and poll creation, now closes when you click the empty space around it. Selecting text in a field and releasing the mouse outside no longer closes the window, so nothing you typed is lost.",
		"ch.s0923.date": "23 September 2026",
		"ch.s0923.i1.t": "Invite links can expire",
		"ch.s0923.i1.d": "When you create an invite link to a group or channel you can now choose how long it works: an hour, a day, a week, 30 days or with no limit. The link shows when it stops working, and after that nobody can join with it. Links made earlier keep working with no expiry.",
		"ch.d0.date": "21 September 2026",
		"ch.d0.i1.t": "Photos open full screen",
		"ch.d0.i1.d": "Tapping a photo opens it full screen: arrows or a swipe move through every photo and video in the chat, a click zooms in and lets you drag the image around, Escape closes it. The bar on top shows the author, the time and a save button.",
		"ch.d0.i2.t": "Chat gallery",
		"ch.d0.i2.d": "The chat menu now has a \u201cPhotos and videos\u201d section \u2014 a grid of every attachment in the conversation. Clips show their own still frame and length, so the gallery can be browsed without downloading anything.",
		"ch.d0.i3.t": "List of pinned messages",
		"ch.d0.i3.d": "The header used to show only the latest pin. Next to it there is now a counter that opens the full list: a tap scrolls to the message and highlights it, and a moderator can unpin from there.",
		"ch.d0.i4.t": "Several files at once",
		"ch.d0.i4.d": "You can pick several files in one go \u2014 they line up as thumbnails, extras are removed with a cross, and the caption goes to the first one. Files can also simply be dragged into the conversation.",
		"ch.d0.i5.t": "Text formatting",
		"ch.d0.i5.d": "*bold*, _italic_, ~strikethrough~, `monospace`, a code block in triple backticks and a quote after a greater-than sign all work now. Ctrl+B, Ctrl+I and Ctrl+E wrap the selection. The message itself stays plain text \u2014 the markers are read only when a bubble is drawn.",
		"ch.d0.i6.t": "@ mentions",
		"ch.d0.i6.d": "In a group, @ opens a searchable list of members: arrows pick, Enter inserts the name. A mention is highlighted in the conversation, and a chat where someone named you is marked with an @ badge in the list until you open it.",
		"ch.d0.i7.t": "Disappearing messages",
		"ch.d0.i7.d": "A chat can be given a message lifetime: an hour, a day, a week or 30 days. When it runs out the server deletes the messages themselves along with their reactions, read marks and the attachments from that window, and open apps drop them straight away. Off by default; in a direct chat either side can set it, in a group the owner or an admin.",
		"ch.d0.i8.t": "Messages survive a lost connection",
		"ch.d0.i8.d": "Anything typed while the internet is gone stays in the conversation marked \u201cWaiting for network\u201d and is kept on the device, surviving a reload. The queue is sent in order the moment the line is back.",
		"ch.d0.i9.t": "Link previews",
		"ch.d0.i9.d": "A link in a message now gets a card with the title, description and picture. The sender builds it and it travels inside the encrypted message \u2014 recipients never reach out to the linked site, and the server sees the address once, as it is composed.",
		"ch.d0.i10.t": "Chat export",
		"ch.d0.i10.d": "A whole chat can be exported into a single HTML file with authors, dates and text; attachments and polls are noted by name. The decryption happens on your device, so the file itself is in the clear \u2014 keep it the way you would keep any copy of a conversation.",
		"ch.d0.i11.t": "Dates in the conversation",
		"ch.d0.i11.d": "An island with the date appears before the first message of each day: \u201cToday\u201d, \u201cYesterday\u201d, then the day and month. It stays at the top while its day scrolls by and gives way to the next one.",
		"ch.d0.i13.t": "Privacy settings",
		"ch.d0.i13.d": "Privacy moved into a window of its own: the settings keep a single entry that opens it. Inside are \u201cLast seen and online\u201d (who can tell whether you are around) and \u201cCalls\u201d (who may ring you), each with three choices: everyone, contacts, nobody. Everyone means anyone you share a chat with, group members included; contacts means only the people you have a one-to-one chat with. Next to them sits a list of exceptions: a contact marked \u201cAlways\u201d gets through even when the setting says nobody, and one marked \u201cNever\u201d is refused even when it is open to everyone. Group invitations and ghost mode moved into the same window. You can always join a call from the chat yourself \u2014 the setting decides who may ring you.",
		"ch.d0.i12.t": "Voice meter in calls",
		"ch.d0.i12.d": "The \u201cyou are being heard\u201d bar in a call never moved: it measured the level its own way, and any hiccup in that path left the bar silently empty. The call now uses the same meter as a voice recording and looks the same \u2014 a row of bars that drops and turns red when the microphone is off.",
		"ch.d1.date": "20 September 2026",
		"ch.d1.i1.t": "Voice messages",
		"ch.d1.i1.d": "The composer now has a microphone button. While you record, a timer and a live input meter are visible and the recording can be discarded with one tap. In the chat it arrives as a player: a waveform, tap-to-seek and 1x, 1.5x and 2x speed. The recording is encrypted on your device like any other file.",
		"ch.d1.i2.t": "Chat folders",
		"ch.d1.i2.d": "The chat list can be split into folders - \u201cWork\u201d and \u201cPersonal\u201d, for instance. A folder is created in one click, and chats are ticked into it or added from the chat's own menu. Tabs above the list show unread counts, and when there are more folders than fit, the tab strip scrolls. Folders live in your account, so they are the same on every device.",
		"ch.d1.i3.t": "Resizable chat list",
		"ch.d1.i3.d": "The edge between the chat list and the conversation can now be dragged with a mouse, a finger or the arrow keys; a double click restores the original width. The width you pick is remembered on the device.",
		"ch.d1.i4.t": "Video and audio play in the chat",
		"ch.d1.i4.d": "A video now shows a still frame, its length and its size. It loads when you press play and runs inside the conversation with the usual controls, fullscreen and volume included. Audio files got a player too \u2014 no need to download them just to listen.",
		"ch.d1.i5.t": "You can see the file being sent",
		"ch.d1.i5.d": "While an attachment is encrypted and uploaded, a card with a thumbnail, a percentage and a progress bar sits in the conversation. Sending a large file used to look like a frozen chat.",
		"ch.d1.i6.t": "Large files reach their destination",
		"ch.d1.i6.d": "The server used to cut off any upload that took longer than five minutes, which on an ordinary home connection covered almost any video from a phone. That limit is gone. Files are also encrypted as a stream rather than whole in memory: sending a 163 MB video now costs the tab 11 MB instead of 660 MB.",
		"ch.d1.i7.t": "Only text can be edited",
		"ch.d1.i7.d": "The Edit action is gone from voice messages, photos, videos and files. The body of such a message is the link to its attachment, and editing left the file with no owner.",
		"ch.d2.date": "19 September 2026",
		"ch.d2.i1.t": "Eight colour themes",
		"ch.d2.i1.d": "Settings now offer a choice of theme: Dark, Light, Ocean, Forest, Sunset, Midnight, Telegram Blue and Nord. Next to them sits a custom accent colour that overrides the accent of the chosen theme. The choice is kept on the device.",
		"ch.foot": "This page covers the web version. The Windows, Linux and Android apps show their own updates on launch, and the latest builds live in the downloads section.",
		"nav.features": "Features",
		"nav.security": "Security",
		"nav.download": "Downloads",
		"nav.changes": "What's new",
		"nav.open": "Open in browser",
		"foot.home": "Home",
		"foot.open": "Web version",
		"foot.login": "Sign in",
		"foot.reg": "Create account",
		"foot.privacy": "Privacy",
		"foot.note": "FrontierX is a hosted service. Conversation content is encrypted with the participants' keys; the server keeps the ciphertext and the routing data needed for delivery.",
		"dl.eyebrow": "Downloads",
		"dl.title": "Download FrontierX",
		"dl.lede": "The versions below come from the update manifest on the server — the same one the installed app updates from.",
		"dl.badge": "Your system",
		"dl.get": "Download",
		"dl.copy": "Copy",
		"meta.version": "Version",
		"meta.size": "Size",
		"meta.date": "Published",
		"dl.win.sub": "Installer · Windows 10 and newer",
		"dl.win.1": "Download the installer and run it.",
		"dl.win.2": "If SmartScreen warns about an unknown publisher — choose \u201cMore info\u201d, then \u201cRun anyway\u201d.",
		"dl.win.3": "Sign in — later updates arrive on their own.",
		"dl.lin.sub": "AppImage · no install needed, x86-64",
		"dl.lin.1": "Make the file executable: <code>chmod +x FrontierX-linux.AppImage</code>",
		"dl.lin.2": "Launch it by double-click or from the terminal.",
		"dl.lin.3": "On Debian and Ubuntu you can install the package instead: <code>sudo apt install ./FrontierX-linux.deb</code>",
		"dl.and.sub": "APK · direct install, no store",
		"dl.and.1": "Download the APK to your phone.",
		"dl.and.2": "Allow the browser to install from this source — Android asks on its own.",
		"dl.and.3": "The app offers later versions by itself.",
		"dl.ios.t": "iPhone and iPad",
		"dl.ios.sub": "From Safari · iOS 16.4 and newer",
		"dl.ios.open": "Open in Safari",
		"dl.ios.1": "Open frontierx.zkito.fun in Safari.",
		"dl.ios.2": "Tap Share and choose <b>Add to Home Screen</b>.",
		"dl.ios.3": "Start FrontierX from the Home Screen, sign in and allow notifications — they arrive even with the app closed.",
		"dl.ios.note": "A separate iPhone app can only be built on a Mac with Xcode and is installed through TestFlight or the App Store — there is no file to download: an iPhone does not install apps from websites.",
		"dl.mac.sub": "dmg · Apple silicon and Intel",
		"dl.mac.1": "Open the .dmg and drag FrontierX to Applications.",
		"dl.mac.2": "First launch: right-click the app → Open (the build is not signed by Apple).",
		"dl.mac.3": "Without installing: open the web version in Safari → File → Add to Dock (macOS 14 and newer).",
		"dl.check.mac": "macOS: <code>shasum -a 256 FILE</code>",
		"dl.web.t": "Rather not install anything?",
		"dl.web.d": "The web version runs in the browser and supports the same chats, files and calls.",
		"dl.web.cta": "Open the web version",
		"dl.check.t": "Verify the file before installing",
		"dl.check.d": "Compare the checksum of the downloaded file with the SHA-256 shown in the card above.",
		"dl.check.1": "Windows: <code>certutil -hashfile FILE SHA256</code>",
		"dl.check.2": "Linux: <code>sha256sum FILE</code>",
		"dl.check.3": "The two strings must match character for character.",
		"foot.note": "FrontierX runs on the project server. It keeps ciphertext and delivery metadata only: the keys to your chats stay with the people in them.",
	}

	var STR = {
		openChat: { ru: "Открыть чат", en: "Open chat" },
		loading: { ru: "Загружаем актуальные версии…", en: "Loading current versions…" },
		failed: { ru: "Не удалось прочитать манифест обновлений. Файлы по-прежнему доступны по адресу /releases/.", en: "Could not read the update manifest. Files are still available under /releases/." },
		noBuild: { ru: "Сборка пока не опубликована", en: "No build published yet" },
		macPending: { ru: "Сборку для Mac можно сделать только на Mac — она пока не опубликована.", en: "The Mac build can only be made on a Mac — it is not published yet." },
		youAre: { ru: "Похоже, у вас ", en: "Looks like you are on " },
		youTail: { ru: " — эта карточка поднята наверх.", en: " — that card is moved to the top." },
		youNone: { ru: "Для вашей системы нативной сборки пока нет — откройте веб-версию.", en: "There is no native build for your system yet — use the web version." },
		portable: { ru: "Portable без установки", en: "Portable, no install" },
		deb: { ru: "Пакет .deb", en: ".deb package" },
		copied: { ru: "Скопировано", en: "Copied" },
		mb: { ru: "МБ", en: "MB" },
		gb: { ru: "ГБ", en: "GB" }
	}

	if (window.FX_EN_EXTRA) {
		for (var extraKey in window.FX_EN_EXTRA) {
			if (Object.prototype.hasOwnProperty.call(window.FX_EN_EXTRA, extraKey)) EN[extraKey] = window.FX_EN_EXTRA[extraKey]
		}
	}

	var lang = (function () {
		var saved = store(LANG_KEY)
		if (saved === "ru" || saved === "en") return saved
		return (navigator.language || "en").toLowerCase().indexOf("ru") === 0 ? "ru" : "en"
	})()

	function s(name) { return STR[name][lang] }

	var state = { manifest: null, error: false, extras: {} }

	function hideLoading() {
		var nodes = document.querySelectorAll("[data-loading]")
		for (var i = 0; i < nodes.length; i++) nodes[i].hidden = true
	}

	function setState(text, tone) {
		var nodes = document.querySelectorAll("[data-detect]")
		for (var i = 0; i < nodes.length; i++) {
			nodes[i].textContent = text
			nodes[i].setAttribute("data-tone", tone || "")
		}
	}

	function applyLang() {
		document.documentElement.lang = lang
		var nodes = document.querySelectorAll("[data-i18n], [data-i18n-html]")
		for (var i = 0; i < nodes.length; i++) {
			var el = nodes[i]
			var isHtml = el.hasAttribute("data-i18n-html")
			var key = isHtml ? el.getAttribute("data-i18n-html") : el.getAttribute("data-i18n")
			if (el.dataset.ruSource === undefined) el.dataset.ruSource = isHtml ? el.innerHTML : el.textContent
			var value = lang === "ru" ? el.dataset.ruSource : (EN[key] !== undefined ? EN[key] : el.dataset.ruSource)
			if (isHtml) el.innerHTML = value
			else el.textContent = value
		}
		var attrs = document.querySelectorAll("[data-i18n-attr]")
		for (var a = 0; a < attrs.length; a++) {
			var spec = attrs[a].getAttribute("data-i18n-attr").split(":")
			var attrName = spec[0]
			var ruAttr = "ru" + attrName.replace(/(^|-)([a-z])/g, function (m, d, c) { return c.toUpperCase() })
			if (attrs[a].dataset[ruAttr] === undefined) attrs[a].dataset[ruAttr] = attrs[a].getAttribute(attrName) || ""
			attrs[a].setAttribute(attrName, lang === "ru" ? attrs[a].dataset[ruAttr] : (EN[spec[1]] || attrs[a].dataset[ruAttr]))
		}
		var segs = document.querySelectorAll(".seg")
		for (var g = 0; g < segs.length; g++) segs[g].setAttribute("data-active", lang)
		var buttons = document.querySelectorAll("[data-lang]")
		for (var j = 0; j < buttons.length; j++) {
			buttons[j].setAttribute("aria-pressed", buttons[j].getAttribute("data-lang") === lang ? "true" : "false")
		}
		markSession()
		if (state.manifest) render(state.manifest)
		else setState(state.error ? s("failed") : s("loading"), state.error ? "err" : "")
	}

	function markSession() {
		if (!store(TOKEN_KEY)) return
		var ctas = document.querySelectorAll("[data-app-cta]")
		for (var i = 0; i < ctas.length; i++) {
			if (ctas[i].classList.contains("btn")) ctas[i].textContent = s("openChat")
		}
	}

	var LABEL = { windows: "Windows", linux: "Linux", android: "Android", ios: "iPhone / iPad", macos: "macOS" }

	function detectOs() {
		var ua = navigator.userAgent || ""
		if (/Android/i.test(ua)) return "android"
		if (/iPhone|iPad|iPod/i.test(ua)) return "ios"
		// iPadOS presents itself as a Mac; the touch screen gives it away.
		if (/Macintosh/i.test(ua)) return (navigator.maxTouchPoints || 0) > 1 ? "ios" : "macos"
		if (/Windows/i.test(ua)) return "windows"
		if (/Linux|X11|CrOS/i.test(ua)) return "linux"
		return null
	}
	var myOs = detectOs()

	function fmtBytes(bytes) {
		if (!bytes && bytes !== 0) return "—"
		var locale = lang === "ru" ? "ru-RU" : "en-US"
		var mb = bytes / 1048576
		if (mb >= 1024) return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(mb / 1024) + " " + s("gb")
		return new Intl.NumberFormat(locale, { maximumFractionDigits: mb < 10 ? 1 : 0 }).format(mb) + " " + s("mb")
	}

	function fmtDate(iso) {
		if (!iso) return "—"
		var date = new Date(iso)
		if (isNaN(date.getTime())) return "—"
		return new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-US", { day: "numeric", month: "long", year: "numeric" }).format(date)
	}

	function samePath(url, fallback) {
		if (!url) return fallback
		try { return new URL(url, location.origin).pathname } catch (e) { return fallback }
	}

	function set(card, selector, value) {
		var node = card.querySelector(selector)
		if (node) node.textContent = value
	}

	function render(manifest) {
		var order = ["windows", "linux", "android", "macos"]
		for (var i = 0; i < order.length; i++) {
			var os = order[i]
			var entry = manifest[os] || null
			var version = entry && entry.version ? entry.version : null

			var chips = document.querySelectorAll('[data-ver="' + os + '"]')
			for (var c = 0; c < chips.length; c++) chips[c].textContent = version ? version : "—"

			var card = document.querySelector('.dl-card[data-os="' + os + '"]')
			if (!card) continue

			var href = samePath(entry && entry.url, null)
			var primary = card.querySelector("[data-primary]")
			var meta = card.querySelector("[data-primary-meta]")
			// No published build: no button that leads nowhere.
			if (primary) primary.hidden = !href
			if (primary && href) {
				primary.download = String(), primary.setAttribute("href", href)
				if (meta) meta.textContent = version + " · " + fmtBytes(entry.size)
			}
			set(card, "[data-version]", version || s("noBuild"))
			set(card, "[data-size]", entry ? fmtBytes(entry.size) : "—")
			set(card, "[data-date]", entry ? fmtDate(entry.publishedAt) : "—")
			set(card, "[data-sha]", entry && entry.sha256 ? entry.sha256 : "—")
			var notes = card.querySelector("[data-notes]")
			if (notes) notes.textContent = entry && entry.notes ? entry.notes : (!entry && os === "macos" ? s("macPending") : "")
			renderExtras(card, os, version)
		}

		var list = document.querySelector("[data-list]")
		if (list && myOs) {
			var mine = list.querySelector('.dl-card[data-os="' + myOs + '"]')
			if (mine) {
				mine.classList.add("is-you")
				list.insertBefore(mine, list.firstChild)
			}
		}
		if (myOs) {
			var myChips = document.querySelectorAll('[data-chip="' + myOs + '"]')
			for (var k = 0; k < myChips.length; k++) myChips[k].classList.add("is-you")
		}
		setState(myOs ? s("youAre") + LABEL[myOs] + s("youTail") : s("youNone"), "")
	}

	function renderExtras(card, os, version) {
		var box = card.querySelector("[data-alt]")
		if (!box || !version) return
		box.innerHTML = ""
		var wanted = []
		if (os === "windows") wanted.push({ path: "/releases/FrontierX-windows-portable-" + version + ".exe", label: s("portable") })
		if (os === "linux") wanted.push({ path: "/releases/FrontierX-linux-" + version + ".deb", label: s("deb") })
		wanted.forEach(function (item) {
			var cached = state.extras[item.path]
			if (cached === false) return
			if (cached === undefined) {
				fetch(item.path, { method: "HEAD" }).then(function (response) {
					if (!response.ok) { state.extras[item.path] = false; return }
					state.extras[item.path] = Number(response.headers.get("content-length") || 0)
					addExtra(box, item, state.extras[item.path])
				}).catch(function () { state.extras[item.path] = false })
			} else {
				addExtra(box, item, cached)
			}
		})
	}

	function addExtra(box, item, size) {
		var link = document.createElement("a")
		link.href = item.path; link.download = String()
		link.textContent = item.label
		var sz = document.createElement("span")
		sz.className = "sz"
		sz.textContent = size ? fmtBytes(size) : ""
		link.appendChild(sz)
		box.appendChild(link)
	}

	document.addEventListener("click", function (event) {
		var target = event.target
		var langButton = target.closest ? target.closest("[data-lang]") : null
		if (langButton) {
			lang = langButton.getAttribute("data-lang")
			save(LANG_KEY, lang)
			applyLang()
			return
		}
		var copyButton = target.closest ? target.closest("[data-copy]") : null
		if (copyButton) {
			var code = copyButton.parentNode.querySelector("code")
			if (!code || !navigator.clipboard) return
			navigator.clipboard.writeText(code.textContent).then(function () {
				var before = copyButton.textContent
				copyButton.textContent = s("copied")
				setTimeout(function () { copyButton.textContent = before }, 1600)
			})
		}
	})

	applyLang()
	setState(s("loading"), "")

	fetch(MANIFEST_URL, { cache: "no-store" })
		.then(function (response) {
			if (!response.ok) throw new Error("manifest " + response.status)
			return response.json()
		})
		.then(function (manifest) {
			state.manifest = manifest
			state.error = false
			render(manifest)
			hideLoading()
		})
		.catch(function () {
			state.error = true
			setState(s("failed"), "err")
			hideLoading()
		})
})()

/* FrontierX site — interface: scroll reveal, sticky header, phone menu,
   section highlighting on the features page and the privacy table of contents. */
;(function () {
	"use strict"

	var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
	var hasIO = "IntersectionObserver" in window

	// Blocks rise in on a spring as they enter the viewport; siblings that
	// appear together are staggered.
	function reveal() {
		var items = document.querySelectorAll("[data-reveal]")
		var i
		if (reduce || !hasIO) {
			for (i = 0; i < items.length; i++) items[i].classList.add("is-in")
			return
		}
		var io = new IntersectionObserver(function (entries) {
			var shown = 0
			for (var k = 0; k < entries.length; k++) {
				if (!entries[k].isIntersecting) continue
				var el = entries[k].target
				el.style.setProperty("--d", Math.min(shown, 6) * 80 + "ms")
				el.classList.add("is-in")
				shown++
				io.unobserve(el)
			}
		}, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 })
		for (i = 0; i < items.length; i++) io.observe(items[i])
	}

	function stickyNav() {
		var nav = document.querySelector("[data-nav-bar]")
		if (!nav) return
		var apply = function () { nav.classList.toggle("is-stuck", window.pageYOffset > 8) }
		apply()
		window.addEventListener("scroll", apply, { passive: true })
	}

	function phoneMenu() {
		var button = document.querySelector("[data-menu]")
		var sheet = document.getElementById("nav-sheet")
		if (!button || !sheet) return
		function set(open) {
			button.setAttribute("aria-expanded", open ? "true" : "false")
			sheet.hidden = !open
		}
		button.addEventListener("click", function () { set(sheet.hidden) })
		document.addEventListener("keydown", function (event) { if (event.key === "Escape" && !sheet.hidden) { set(false); button.focus() } })
		document.addEventListener("click", function (event) {
			if (!sheet.hidden && !sheet.contains(event.target) && !button.contains(event.target)) set(false)
		})
		window.addEventListener("resize", function () { if (window.innerWidth > 900) set(false) })
	}

	// Highlights the link of the section currently on screen.
	function spy(links, onChange) {
		if (!hasIO || !links.length) return
		var byId = {}
		var targets = []
		for (var i = 0; i < links.length; i++) {
			var id = decodeURIComponent((links[i].getAttribute("href") || "").slice(1))
			var target = id && document.getElementById(id)
			if (target) { byId[id] = links[i]; targets.push(target) }
		}
		var visible = {}
		var io = new IntersectionObserver(function (entries) {
			for (var k = 0; k < entries.length; k++) visible[entries[k].target.id] = entries[k].isIntersecting
			for (var t = 0; t < targets.length; t++) {
				if (visible[targets[t].id]) {
					for (var key in byId) byId[key].classList.toggle("is-on", key === targets[t].id)
					if (onChange) onChange(byId[targets[t].id])
					return
				}
			}
		}, { rootMargin: "-35% 0px -55% 0px" })
		for (var j = 0; j < targets.length; j++) io.observe(targets[j])
	}

	function featureJump() {
		var bar = document.querySelector("[data-jump]")
		if (!bar) return
		spy(bar.querySelectorAll("a"), function (link) {
			var row = link.parentNode
			var left = link.offsetLeft - row.clientWidth / 2 + link.clientWidth / 2
			row.scrollTo({ left: left, behavior: reduce ? "auto" : "smooth" })
		})
	}

	// Builds the privacy policy's table of contents from its section headings.
	function toc() {
		var box = document.querySelector("[data-toc]")
		if (!box) return
		var sections = document.querySelectorAll(".pp-sec")
		for (var i = 0; i < sections.length; i++) {
			var heading = sections[i].querySelector("h2")
			if (!heading) continue
			sections[i].id = sections[i].id || "sec-" + (i + 1)
			var link = document.createElement("a")
			link.href = "#" + sections[i].id
			link.textContent = heading.textContent
			link.setAttribute("data-toc-for", heading.getAttribute("data-i18n-html") || "")
			box.appendChild(link)
		}
		spy(box.querySelectorAll("a"), function (link) {
			var top = link.offsetTop - box.clientHeight / 2
			box.scrollTo({ top: top, behavior: reduce ? "auto" : "smooth" })
		})
		// Keep the entries in the chosen language.
		document.addEventListener("click", function (event) {
			if (!event.target.closest || !event.target.closest("[data-lang]")) return
			setTimeout(function () {
				var links = box.querySelectorAll("a")
				for (var k = 0; k < links.length; k++) {
					var id = links[k].getAttribute("href").slice(1)
					var h = document.getElementById(id).querySelector("h2")
					links[k].textContent = h.textContent
				}
			}, 0)
		})
	}

	function start() {
		reveal()
		stickyNav()
		phoneMenu()
		featureJump()
		toc()
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start)
	else start()
})()
