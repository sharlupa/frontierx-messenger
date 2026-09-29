# FrontierX - Android

Тонкая нативная оболочка (WebView) вокруг веб-приложения FrontierX - по той же
схеме, что и десктоп-версия на Electron.

## Что внутри

- MainActivity - WebView, который грузит адрес сервера FrontierX.
- SetupActivity - экран ввода адреса сервера (при первом запуске или по долгому
  нажатию кнопки Назад).
- Разрешения микрофона и камеры прокидываются в веб-приложение для звонков.
- Разрешён http (cleartext), чтобы можно было подключаться к серверу без HTTPS.

## Архитектура

Собирается только под arm64-v8a (современные 64-битные ARM телефоны).

## Сборка

    cd apps/android
    gradle assembleDebug

APK будет здесь:

    app/build/outputs/apk/debug/app-debug.apk

Установка на телефон (при включённой отладке по USB):

    adb install -r app/build/outputs/apk/debug/app-debug.apk

## Иконка

Генерируется из apps/web/public/favicon.svg в mipmap-*/ic_launcher.png.
