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

# OMP Desktop 0.1.6

## Русский

Патч с уточнением фильтрации сессий без диалога.

### Что изменилось

- Уточнён отбор сессий: признак активности выставляется исключительно при наличии сообщений пользователей (`user`) или ответов ИИ (`assistant`).
- Служебные сообщения без роли или только с системными инструкциями больше не предотвращают дедупликацию пустых сессий.
- Добавлены юнит-тесты на исключение служебных `custom_message` и `system` записей из дедупликатора.
- Версия обновлена до 0.1.6.

Рекомендуется `OMP-Desktop_0.1.6_x64-setup.exe` (Windows) и `OMP-Desktop_0.1.6_amd64.AppImage` (Linux).

## English

Patch refining session filtering logic for empty and service-only sessions.

### Changes

- Refined session activity detection: sessions are marked as active strictly when containing `user` prompts or `assistant` responses.
- Service-only messages without roles or with system-only instructions no longer prevent deduplication of empty sessions.
- Added unit test coverage for system-only and roleless `custom_message` records in session scanner.
- Version bumped to 0.1.6.

Recommended: `OMP-Desktop_0.1.6_x64-setup.exe` (Windows), `OMP-Desktop_0.1.6_amd64.AppImage` (Linux).

## SHA-256 (0.1.6)

```text
ef2034e0c9d79f20fac2aca1b9bc476417544bac5804509f68e67bab9efc11e3  windows/OMP-Desktop_0.1.6_x64_en-US.msi
f81159888ea207bce7c217449687ea88727908b83f400df92cd2f01f45d263bd  windows/OMP-Desktop_0.1.6_x64-setup.exe
ecdc8d5be2cad7a4d1d0dcba709811ae904472de4b9f04c88dbd05b8f4ac0fa1  linux/OMP-Desktop_0.1.6_amd64.AppImage
2fc79eef3d515da482049D56602597e6008648abb22e9120e90ec5ba1ab2965e  linux/OMP-Desktop_0.1.6_amd64.deb
e83ef5014183dfd6b825c3a818d590c62bc8f3346d76349ac72a7436374b915b  linux/OMP-Desktop-0.1.6-1.x86_64.rpm
```

# OMP Desktop 0.1.5

## Русский

Релиз с улучшением стабильности работы сессий, оптимизацией производительности и исправлениями интерфейса.

### Что изменилось

- Умный отбор сессий: автоматическая дедупликация незавершённых пустых сессий («Новая сессия») с сохранением всех нетитулованных содержательных диалогов.
- Корректная обработка обновлений OMP CLI: исключены ложные уведомления при совпадении установленной и текущей версий.
- Оптимизация производительности Linux (ALT Linux): снижена нагрузка на CPU за счет усовершенствованных таймеров опроса PTY и файлов сессий.
- Индикация активности: исправлено отображение состояния размышления (thinking) во вкладках терминала и списке сессий.
- Уведомления о завершении: добавлена поддержка системных всплывающих уведомлений после ответа ИИ.
- Улучшенный просмотр истории: модальное окно просмотра полного транскрипта с функцией «Open & Reread».
- Версия обновлена до 0.1.5.

Рекомендуется `OMP-Desktop_0.1.5_x64-setup.exe` (Windows) и `OMP-Desktop_0.1.5_amd64.AppImage` (Linux).

## English

Release with session stability improvements, Linux CPU optimization, and interface fixes.

### Changes

- Smart session scanning: automatic deduplication of empty untitled sessions while retaining all untitled chats with messages.
- OMP CLI update check fix: eliminated false update banners when installed version matches latest.
- Linux CPU optimization (ALT Linux): reduced background CPU usage via improved polling timers for PTY and session state.
- Thinking state indicators: fixed pulse display in terminal tabs and session entries.
- Completion notifications: system desktop notifications when generation finishes.
- Full transcript viewer: modal transcript inspector with "Open & Reread" action.
- Version bumped to 0.1.5.

Recommended: `OMP-Desktop_0.1.5_x64-setup.exe` (Windows), `OMP-Desktop_0.1.5_amd64.AppImage` (Linux).

## SHA-256 (0.1.5)

f562c604e5f193240a84989aad2aeff27af5a4b4647b9b072e379592f1f8a787  windows/OMP-Desktop_0.1.5_x64_en-US.msi
b552b457db4fecfd871bb88cc89f0cde0ec4ed9f26f5b03195df045799ba3901  windows/OMP-Desktop_0.1.5_x64-setup.exe
bbb1b7caaeb15958b2a095623ebef7d857b043799a928ade4722fbd6e3169ec0  linux/OMP-Desktop_0.1.5_amd64.AppImage
ae5994ac543e53273b59fee8cca831506c164fddf1f25c86b6c2068ac8051456  linux/OMP-Desktop_0.1.5_amd64.deb
826ecd59d8f9d472c8bf29d1f09c3d6f58c4f1d42af54377766bf01200631453  linux/OMP-Desktop-0.1.5-1.x86_64.rpm
