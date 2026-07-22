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

# OMP Desktop 0.1.4

## Русский

Релиз с улучшениями интерфейса.

### Что изменилось

- Добавлены визуальные индикаторы состояния thinking во вкладках терминалов и в списке сессий.
- Объединена левая панель: project rail и раскрывающийся список сессий.
- Клик по строке сессии переключает на соответствующую вкладку.
- Версия обновлена до 0.1.4.
- Для Windows доступны MSI и NSIS, для Linux — AppImage, DEB и RPM.

Рекомендуется `OMP-Desktop_0.1.4_x64-setup.exe` (Windows) и `OMP-Desktop_0.1.4_amd64.AppImage` (Linux).

## English

Release with user-interface improvements.

### Changes

- Added visual thinking-state indicators in terminal tabs and the session list.
- Merged the project rail and expandable session list into one left panel.
- Clicking a session row switches to the corresponding running tab.
- Version bumped to 0.1.4.
- MSI and NSIS packages are available for Windows; AppImage, DEB, and RPM packages are available for Linux.

Recommended: `OMP-Desktop_0.1.4_x64-setup.exe` (Windows), `OMP-Desktop_0.1.4_amd64.AppImage` (Linux).

## SHA-256 (0.1.4)

```text
74da288e29e757a6bc488fc8ec05f1c3fd0e9bdb9a1ea0c72ad3cc43c93d19af  windows/OMP-Desktop_0.1.4_x64_en-US.msi
5c1971c8a873cc6bd91bbab456a4a2f182c47924e7705b103cd0b3268bf76119  windows/OMP-Desktop_0.1.4_x64-setup.exe
62ae39d164ef3c2f4ee4138eb51f3c978e59ca0ac4295baf36198101faed16e6  linux/OMP-Desktop_0.1.4_amd64.AppImage
33cfdef3f79b966d2b76f8a361351f3f777475d44bb174a71565c90ad8c0144a  linux/OMP-Desktop_0.1.4_amd64.deb
7d79f5dba635a7c2968d52d5929b39a6e6404c1aef11de841a44294fe2263911  linux/OMP-Desktop-0.1.4-1.x86_64.rpm
```
