# OMP Desktop 0.1.11

## Русский

Исправляющий релиз для истории сессий и уведомления об обновлении OMP.

### Что изменилось

- **Единая история обсуждения**: внутренние task/subagent JSONL больше не отображаются как отдельные пользовательские сессии. Старые связанные файлы автоматически сворачиваются под родительское обсуждение без переноса или удаления данных.
- **Новые сессии без дубликатов**: дочерние процессы текущего обсуждения сохраняют свою техническую историю, но больше не размножают строки в списке сессий.
- **Завершение обновления OMP**: после успешного обновления устаревшее уведомление и кнопка перезапуска сразу исчезают без перезапуска OMP Desktop.
- Версия обновлена до 0.1.11.

Пользователи OMP Desktop 0.1.10 могут установить обновление встроенным updater.

Рекомендуется `OMP.Desktop_0.1.11_x64-setup.exe` (Windows) и `OMP.Desktop_0.1.11_amd64.AppImage` (Linux).

## English

A corrective release for session history and the OMP update notification.

### Changes

- **Unified discussion history**: internal task/subagent JSONL files no longer appear as separate user sessions. Existing related files are collapsed under their parent discussion automatically, without moving or deleting data.
- **No duplicates from new sessions**: child processes retain their technical history without adding extra rows to the session list.
- **OMP update completion**: after a successful update, the stale notice and restart action disappear immediately without restarting OMP Desktop.
- Version bumped to 0.1.11.

OMP Desktop 0.1.10 users can install this release through the built-in updater.

Recommended: `OMP.Desktop_0.1.11_x64-setup.exe` (Windows), `OMP.Desktop_0.1.11_amd64.AppImage` (Linux).

## SHA-256 (0.1.11)

```text
036e4f238312fb4770f02582cade770a963a0aadbaf5b902588d2ca5dc49ba30  windows/OMP.Desktop_0.1.11_x64-setup.exe
06be05655af097e4e8c0288a36f1f3a89adada4d551e8ae48d2af3c6d11e35f3  windows/OMP.Desktop_0.1.11_x64_en-US.msi
a21dd4ebf2dd96aa14dbf11cfe7bd306cab9b4da53927fb26624ffd7e165ee01  linux/OMP.Desktop_0.1.11_amd64.AppImage
174667e74dea913eec2901f9a765adb4a6445556560bc90cc2937e0f6a14ec1f  linux/OMP.Desktop_0.1.11_amd64.deb
c53d4de0e8e3238558f49025ac0eedef48d0eaa616b35eeb79c6ad252b1613f8  linux/OMP.Desktop-0.1.11-1.x86_64.rpm
```

# OMP Desktop 0.1.10

## Русский

Первый стабильный релиз OMP Desktop со встроенным подписанным автообновлением приложения и полным набором исправлений надёжности после аудита.

### Что изменилось

- **Подписанное автообновление приложения**: добавлена проверка новых версий OMP Desktop, загрузка подписанного пакета и безопасный перезапуск. Последующие версии смогут устанавливаться автоматически.
- **Важно для пользователей 0.1.9**: эта версия ещё не содержала updater, поэтому переход на 0.1.10 требует однократной ручной установки нового installer или AppImage.
- **Надёжность интеграции OMP**: команды ограничены по времени и объёму вывода; частичные сбои каталога или usage показываются предупреждением, не блокируя остальные настройки.
- **Безопасность настроек**: усилены атомарное сохранение и восстановление повреждённого `settings.json`, работа системного хранилища ключей и безопасный файловый fallback.
- **Безопасность сессий**: активную сессию нельзя переименовать до остановки её процесса; улучшена очистка runtime-состояния терминалов.
- **Терминал и Thinking**: добавлены настройки семейства и размера шрифта, а Thinking теперь заметен у фоновой вкладки, в списке сессий и заголовке окна.
- **Совместимость Linux**: добавлено обнаружение системного CA bundle на ALT/RHEL-подобных системах для HTTPS-проверки обновлений.
- **Целостность релиза**: Windows- и Linux-пакеты публикуются с updater-подписями, SHA-256 и машинно-читаемым манифестом assets.
- Версия обновлена до 0.1.10.

Рекомендуется `OMP.Desktop_0.1.10_x64-setup.exe` (Windows) и `OMP.Desktop_0.1.10_amd64.AppImage` (Linux).

## English

The first stable OMP Desktop release with built-in signed application updates and the complete post-audit reliability fixes.

### Changes

- **Signed application updates**: added OMP Desktop update checks, signed package installation, and safe application restart. Later releases can be installed automatically.
- **Important for 0.1.9 users**: that version did not include the updater, so moving to 0.1.10 requires one manual installer or AppImage update.
- **OMP integration reliability**: commands now have time and output bounds; partial model-catalog or usage failures produce warnings without blocking the remaining settings.
- **Settings safety**: strengthened atomic persistence and recovery of an invalid `settings.json`, operating-system credential storage, and the protected file fallback.
- **Session safety**: active sessions cannot be renamed until their process stops; terminal runtime state cleanup was improved.
- **Terminal and Thinking UX**: added terminal font family and size settings; background Thinking is visible in tabs, the session list, and the window title.
- **Linux compatibility**: added system CA bundle discovery on ALT/RHEL-like distributions for HTTPS update checks.
- **Release integrity**: Windows and Linux packages include updater signatures, SHA-256 files, and a machine-readable asset manifest.
- Version bumped to 0.1.10.

Recommended: `OMP.Desktop_0.1.10_x64-setup.exe` (Windows), `OMP.Desktop_0.1.10_amd64.AppImage` (Linux).

## SHA-256 (0.1.10)

```text
23bce6bd0b3d637c18e98c287fcd09101c99190e3ed108e1454058383dfc18ac  windows/OMP.Desktop_0.1.10_x64-setup.exe
d8efc2671e53bb9028699acbb659d83b8be6c99101c0cb794fb4262124310fc8  windows/OMP.Desktop_0.1.10_x64_en-US.msi
76c7e585acf50a8b9fd6666ef7faa7e8312507750f6ab8372d28d8ca801bc7a1  linux/OMP.Desktop_0.1.10_amd64.AppImage
e539ef186d6c5a58bcb9c941f175628d422af33dc00e38cdcbb205bd879f3924  linux/OMP.Desktop_0.1.10_amd64.deb
729051cbacafb144f9645709dcbd65fbf2da71be1e82bf8dcdb0c24d9f8a198b  linux/OMP.Desktop-0.1.10-1.x86_64.rpm
```

# OMP Desktop 0.1.9

## Русский

Крупный релиз надёжности, безопасности и производительности по итогам полного аудита приложения.

### Что изменилось

- **Безопасное хранение ключей**: API-ключи провайдеров перенесены из открытого JSON в системное хранилище учётных данных; существующие значения мигрируются автоматически.
- **Надёжность сессий и терминалов**: добавлены атомарная запись JSONL, устойчивое сканирование каталогов, ожидание готовности PTY перед отправкой начального ввода и буферизация ввода во время смены модели.
- **Быстродействие**: тяжёлые операции вынесены с UI-потока, добавлены кэши OMP и сессий, ограничено чтение больших историй Codex, изолирован вывод терминалов и виртуализированы длинные списки.
- **Диагностика и обновления OMP**: исправлены статусы провайдеров, обработка ошибок команд, события ошибок терминала и уведомления об обновлении из активной сессии.
- **UX**: добавлены клавиатурное управление выбором модели, очередь уведомлений, подтверждение закрытия работающего процесса, индикатор Thinking в заголовке окна и drag-and-drop вкладок.
- **Защита и качество**: включён строгий CSP, добавлены frontend-тесты, ESLint/Prettier и межплатформенные CI-проверки Rust/TypeScript.
- Версия обновлена до 0.1.9.

Рекомендуется `OMP-Desktop_0.1.9_x64-setup.exe` (Windows) и `OMP-Desktop_0.1.9_amd64.AppImage` (Linux).

## English

A major reliability, security, and performance release based on a complete application audit.

### Changes

- **Secure key storage**: provider API keys moved from plain JSON to the operating system credential store, with automatic migration of existing values.
- **Session and terminal reliability**: added atomic JSONL writes, resilient directory scanning, PTY readiness before initial input, and input buffering during model switches.
- **Performance**: moved heavy work off the UI thread, added OMP and session caches, bounded Codex history reads, isolated terminal output, and virtualized long lists.
- **Diagnostics and OMP updates**: fixed provider status reporting, command error handling, terminal error events, and live-session update notifications.
- **UX**: added keyboard model selection, queued notifications, confirmation before stopping active processes, a Thinking window-title indicator, and tab drag-and-drop.
- **Security and quality**: enabled a strict CSP and added frontend tests, ESLint/Prettier, and cross-platform Rust/TypeScript CI checks.
- Version bumped to 0.1.9.

Recommended: `OMP-Desktop_0.1.9_x64-setup.exe` (Windows), `OMP-Desktop_0.1.9_amd64.AppImage` (Linux).

## SHA-256 (0.1.9)

```text
e6f823fdeeea9c36cfa8f978e124d1fbcdfaf7225faeb71e53e412f6bdccdfdd  windows/OMP-Desktop_0.1.9_x64_en-US.msi
2c032e89a331ec157631960bf801d7b4432ac3b5cdb54122b83622f287e44da2  windows/OMP-Desktop_0.1.9_x64-setup.exe
cb46bd772fbca1330a6fbb7acad4cca147c84db8b6a49aa827eeba8e672fa4a9  linux/OMP-Desktop_0.1.9_amd64.AppImage
566dce8d93de93b81afe302b2247505155007f39619ce31c12cdaccadae6b715  linux/OMP-Desktop_0.1.9_amd64.deb
5e59bdf8a3853465fca3ccd1239f041333d6bbcf71e30aa4bc46a33a493d6a33  linux/OMP-Desktop-0.1.9-1.x86_64.rpm
```

# OMP Desktop 0.1.8

## Русский

Релиз с уведомлением о доступных обновлениях OMP, отображением статусов провайдеров и разделением настроек на удобные категории.

### Что изменилось

- **Автоматические уведомления и перезапуск обновления OMP**: добавлены интерактивные уведомления при выходе новой версии OMP CLI, а также автоматическое продолжение активной сессии после выполнения обновления.
- **Индикация провайдеров и ключей**: в настройки добавлен наглядный список подключённых провайдеров и статусов конфигурации API-ключей без передачи их содержимого.
- **Категории настроек**: параметры приложения распределены по удобным разделам («Основное», «Поведение», «Модели», «Провайдеры»).
- Версия обновлена до 0.1.8.

Рекомендуется `OMP-Desktop_0.1.8_x64-setup.exe` (Windows) и `OMP-Desktop_0.1.8_amd64.AppImage` (Linux).

## English

Release featuring live OMP update notifications with automatic session restart, provider status indicators, and categorized settings navigation.

### Changes

- **Live OMP update notifications and session resumption**: added live update toasts for OMP CLI releases with automatic session resumption after the update tab completes.
- **Provider status indicators**: settings now show a safe provider status list confirming API key and model catalog readiness without exposing secret keys.
- **Categorized settings navigation**: settings are organized into clear sections ("General", "Behavior", "Models", "Providers").
- Version bumped to 0.1.8.

Recommended: `OMP-Desktop_0.1.8_x64-setup.exe` (Windows), `OMP-Desktop_0.1.8_amd64.AppImage` (Linux).

## SHA-256 (0.1.8)

```text
ca6335b1b12bf96d936c0997074269a8cf9c1a612589a3cdf1fdec05804c6d91  windows/OMP-Desktop_0.1.8_x64_en-US.msi
03cce3d92284300152b17e1649af6dfd5eea7e0f52344255e9d2b12406dda96a  windows/OMP-Desktop_0.1.8_x64-setup.exe
a2c7a7f91b9beb53e56cd14880FA296F5E06ACCD44B570D426413D74F5976C30  linux/OMP-Desktop_0.1.8_amd64.AppImage
3c3cc7e4c281b0234556d814b4c861c8908cba15ecd195ea22d4ab9b7bcdc974  linux/OMP-Desktop_0.1.8_amd64.deb
5b888f1662436ef1f81c9abedbbee653ba89d10ca58208af82a63d6c3ac87ef5  linux/OMP-Desktop-0.1.8-1.x86_64.rpm
```

# OMP Desktop 0.1.7

## Русский

Релиз с быстрым поиском и управляемым составом истории сессии.

### Что изменилось

- Текущая версия OMP Desktop постоянно отображается в верхней панели приложения.
- В просмотр транскрипта добавлен поиск по тексту, роли, типу записи и модели с мгновенным счётчиком результатов.
- Добавлен переключатель «Только диалог» / «Диалог + служебные»: первый режим скрывает рассуждения, вызовы инструментов, выводы команд и системные события.
- Смешанные ответы корректно разделяются: обычный текст ассистента остаётся в диалоге, встроенные вызовы инструментов показываются только вместе со служебными сообщениями.
- Версия обновлена до 0.1.7.

Рекомендуется `OMP-Desktop_0.1.7_x64-setup.exe` (Windows) и `OMP-Desktop_0.1.7_amd64.AppImage` (Linux).

## English

Release adding fast search and controllable session-history content.

### Changes

- The current OMP Desktop version is now always visible in the application header.
- Transcript view now supports instant search across text, role, entry type, and model, with a live result count.
- Added a “Dialogue only” / “Dialogue + service” switch: dialogue-only mode hides reasoning, tool calls, command output, and system events.
- Mixed assistant responses are split correctly: conversational text remains visible while embedded tool calls are limited to the service-inclusive mode.
- Version bumped to 0.1.7.

Recommended: `OMP-Desktop_0.1.7_x64-setup.exe` (Windows), `OMP-Desktop_0.1.7_amd64.AppImage` (Linux).

## SHA-256 (0.1.7)

```text
4b092d2574bce7dabe02d53e3c3563caaf18eebbf9972673028b314f4a6ad808  windows/OMP-Desktop_0.1.7_x64_en-US.msi
50963f192d9822a1108805e8c790dbadba6cb19789108ab0c65211bf172a3a3a  windows/OMP-Desktop_0.1.7_x64-setup.exe
b4492c09932ce69ca17b3e3da87cfce1c79397e339b4d24fbadd4ae9a081a575  linux/OMP-Desktop_0.1.7_amd64.AppImage
3787bfdfa091952d7d59a6efa8ccbe3aed354bb3bdeba285ce0992a0e261fc9d  linux/OMP-Desktop_0.1.7_amd64.deb
49ee4da679f9c472e11a516f69d4e5fad46acb0a8919658bd33b925d50a24066  linux/OMP-Desktop-0.1.7-1.x86_64.rpm
```
