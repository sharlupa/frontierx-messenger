# FrontierX Desktop (Linux, Windows and macOS)

Native Linux desktop build of the FrontierX web client, using Electron. The app
opens a native window and connects to a FrontierX server that you choose (local,
LAN, or a public server). Voice/video calls work out of the box because the
desktop app is a secure context and is granted microphone access.

## Run (development)

From the repository root:

    npm install
    npm run desktop

On first launch you'll be asked for the server address. Examples:

- Local server on this PC:  http://localhost:8080
- Server on your LAN:       http://192.168.1.50:8080
- Your own server:          https://chat.example.com

You can change it later from the menu: File -> server settings.

## Build installable packages (AppImage + .deb)

    npm run desktop:dist

Output is written to apps/desktop/release/. Building packages should be run on a
Linux machine with a graphical session available.

## Notes

- The desktop app does not include a server. Point it at a FrontierX server
  (the same one the web app uses).
- Microphone: https and http://localhost are secure contexts automatically. For
  a plain-http LAN address, the app opts that origin into a secure context so
  getUserMedia keeps working; switching to a brand-new LAN address may need an
  app restart.
- If the app fails to start in a container/root environment with a sandbox
  error, launch with:  npm run desktop -- --no-sandbox
- Configuration is stored per-user in the Electron userData directory
  (config.json).

## Windows build

Run from the repo root:

    npm run desktop:dist:win

Artifacts appear in apps/desktop/release:

- FrontierX Setup 0.1.0.exe - NSIS installer, per-user, install folder can be changed
- FrontierX 0.1.0.exe - portable build, runs without installation
- win-unpacked - unpacked application folder

The build runs on Linux (electron-builder plus wine) and is not code signed,
so Windows SmartScreen may warn on first launch: More info, then Run anyway.
On first start the app asks for the server address, default https://frontierx.zkito.fun

## macOS build

Run on a Mac (Xcode command line tools installed):

    cd apps/desktop
    npm install
    npm run dist:mac

Artifacts appear in apps/desktop/release: `FrontierX-<version>-arm64.dmg`
(Apple silicon), `FrontierX-<version>-x64.dmg` (Intel) and zip archives of both.

- The app asks macOS for microphone and camera access on the first call and for
  location only when a place is shared; the texts are in `extendInfo` of
  package.json, the entitlements in `build/entitlements.mac.plist`.
- Without an Apple Developer ID the build is unsigned: open it with right
  click → Open the first time (or `xattr -dr com.apple.quarantine /Applications/FrontierX.app`).
  To sign and notarize, set `CSC_LINK`/`CSC_KEY_PASSWORD` and
  `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` before building.
- The menu bar icon is `renderer/trayTemplate.png` (a template image macOS tints
  for light and dark menu bars); closing the window keeps FrontierX in the menu
  bar, Cmd+Q quits.
- Updates: publish the dmg under /releases and add a `macos` entry to
  `/var/lib/frontierx/releases/manifest.json` (same fields as `linux`).

On iPhone, iPad and in Safari on the Mac, FrontierX also runs as an installed
web app: Safari → Share → Add to Home Screen (Add to Dock on macOS). Notifications
work there too (iOS/iPadOS 16.4 and newer).
