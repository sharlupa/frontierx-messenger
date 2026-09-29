# FrontierX

Мессенджер со сквозным шифрованием: личные чаты, группы и каналы, звонки,
голосовые, файлы, геопозиция, спойлеры, отложенная отправка, поиск по всем
чатам, несколько аккаунтов и боты. Сервер хранит только шифротекст — ключи
от переписки есть только у её участников.

Работающий экземпляр: https://frontierx.zkito.fun

*An end-to-end encrypted messenger: direct chats, groups and channels, calls,
voice messages, files, location sharing, spoilers, scheduled messages,
search across all chats, multiple accounts and bots. The server keeps
ciphertext only. English summary at the end.*

## Что внутри

| Путь | Что это |
| --- | --- |
| `apps/api` | Сервер: Node.js (TypeScript через tsx), HTTP API, WebSocket, SQLite (`node:sqlite`), Web Push, Bot API |
| `apps/web` | Клиент: React + Vite, PWA (устанавливается на iPhone, Android, компьютер) |
| `apps/desktop` | Приложение для Windows, Linux и macOS (Electron) |
| `apps/android` | Приложение для Android (WebView + уведомления FCM / UnifiedPush) |
| `apps/ios` | Приложение для iPhone и iPad (Swift, WKWebView, XcodeGen) |
| `apps/site` | Сайт: главная, возможности, загрузки, что нового |
| `packages/bot-sdk` | SDK для ботов на Node.js — один файл без зависимостей |
| `packages/*` | Общий код: протокол, криптография файлов, модель данных |
| `docs` | Архитектура, шифрование, модель угроз, API, боты |

## Шифрование коротко

- У аккаунта один главный ключ. На сервере он лежит только в зашифрованном
  виде: его открывают пароль (PBKDF2-SHA256, 600 000 итераций), ключ
  восстановления или подтверждение с другого устройства.
- У каждого чата есть версии ключа (AES-256-GCM). Участникам они передаются
  через ECDH P-256; при выходе участника из группы создаётся новый ключ.
- Сообщения, файлы, их имена и типы, геопозиция, нажатия кнопок ботов —
  всё шифруется на устройстве. Сервер видит, кому доставить, но не что.

Подробнее: [docs/ENCRYPTION.md](docs/ENCRYPTION.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Запуск для разработки

Нужен Node.js 22 или новее.

```sh
npm install
npm run dev:api     # сервер на http://127.0.0.1:8080
npm run dev:web     # клиент на http://127.0.0.1:5173
```

Тесты:

```sh
cd apps/api && npx tsx --test test/*.test.ts
cd apps/web && npx tsx --test test/*.test.ts test/*.test.tsx
```

Сборка клиента: `npm -w @frontierx/web run build` — сервер отдаёт
`apps/web/dist` сам, отдельный веб-сервер не нужен. Шаблоны для своего
сервера (systemd, Caddy) — в `deploy/lite`.

## Приложения

- **Android**: `cd apps/android && gradle assembleRelease`. Для уведомлений
  через Firebase положите свой `app/google-services.json`, для подписи —
  `keystore.properties` (оба файла не входят в репозиторий).
- **Windows / Linux**: `cd apps/desktop && npm install && npm run dist` (или `dist:win`).
- **macOS и iPhone собираются только на Mac**: `npm run dist:mac` в
  `apps/desktop`; iOS — см. [apps/ios/README.md](apps/ios/README.md).

## Боты

Документация и SDK — [docs/BOTS.md](docs/BOTS.md). Бот — это аккаунт,
которым управляет ваша программа по токену: команды, кнопки под
сообщениями, файлы, фото и видео, вебхуки. Переписка с ботом тоже
зашифрована.

## Лицензия

GNU General Public License v3.0 или более поздней версии — см. [LICENSE](LICENSE).
Можно использовать, изучать, изменять и распространять код; изменённые
версии, которые вы распространяете, должны оставаться под GPL и с открытым
исходным кодом.

---

## English

FrontierX is an end-to-end encrypted messenger. Every account has one main key
that the server stores only sealed (unlocked by the password, a recovery key or
another device); conversation keys are versioned and shared over ECDH P-256;
messages, files, file names, locations and bot button presses are encrypted on
the device.

Development: Node.js 22+, `npm install`, `npm run dev:api`, `npm run dev:web`.
iPhone and macOS builds can only be made on a Mac. Bots: [docs/BOTS.md](docs/BOTS.md).

Licensed under the GNU GPL v3.0 or later.
