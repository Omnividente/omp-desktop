# OMP Desktop

[![Latest release](https://img.shields.io/github/v/release/Omnividente/omp-desktop?display_name=tag&sort=semver)](https://github.com/Omnividente/omp-desktop/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-78c850)
![Tauri](https://img.shields.io/badge/Tauri-2-24c8db)

Independent desktop workspace for [Oh My Pi](https://github.com/can1357/oh-my-pi) — projects, sessions, and OMP terminals on Windows and Linux.

**[Русский](#русский) · [English](#english)**

## Русский

**OMP Desktop** — независимый open-source графический клиент для [Oh My Pi](https://github.com/can1357/oh-my-pi). Он объединяет управление проектами и сессиями, историю переписки и живые OMP-терминалы в одном нативном приложении для Windows и Linux.

Для тех, кому нужен графический доступ к проектам и настройкам с сохранением привычного OMP: живая беседа идёт через встроенный терминальный интерфейс OMP (TUI), а не отдельный графический чат. Это локальное настольное приложение, не веб-клиент или размещённый в облаке сервис; OMP устанавливается отдельно.

**[Установка](#установка) · [Последний стабильный релиз](https://github.com/Omnividente/omp-desktop/releases/latest)**

![OMP Desktop: project sidebar, session history, and workspace overview](docs/omp-desktop.png)

> **Независимый клиент:** проект не входит в официальную поставку OMP. Поддержка Desktop ведётся в этом репозитории; публикация в upstream не означает одобрения со стороны OMP. [Обсуждение интеграции →](https://github.com/can1357/oh-my-pi/issues/12456)

### Основные возможности

- **Проекты и сессии:** рабочие папки, поиск, возобновление и цепочки handoff.
- **Нативные PTY-терминалы:** параллельные вкладки, изменение размера, прерывание и завершение процессов.
- **Конфигурация и провайдеры:** настройки OMP, модели, аккаунты, лимиты и фиксация провайдера для сессии.
- **История и диагностика:** импорт OMP/Codex JSONL, просмотр и поиск переписки, предупреждения и монитор ресурсов.
- **Windows и Linux:** единая кодовая база, установочные пакеты и обновления с подтверждением при работающих терминалах.

> Подробное поведение ниже описывает ветку `main`, которая может опережать стабильную сборку. Для установленной версии используйте [описание соответствующего релиза](https://github.com/Omnividente/omp-desktop/releases). Изменения, принятые после **v0.9.4**, войдут в будущий релиз.

<details>
<summary>Подробные возможности, ограничения и поведение</summary>

- Проекты и недавние рабочие папки в боковой панели.
- Последний выбранный проект восстанавливается после перезапуска Desktop; явный `--project` имеет приоритет. Удалённые или скрытые папки не возвращаются автоматически, терминалы без запроса не запускаются.
- Автоматическое обнаружение стандартных JSONL-сессий OMP. Нечитаемые файлы и нераспознаваемые заголовки показываются отдельным предупреждением с путями и повторным чтением; остальные сессии остаются доступны.
- Поиск, открытие и возобновление существующих сессий.
- Новая терминальная сессия сразу получает JSONL, созданный самим OMP через `--session`: модель можно переключать до первого сообщения, без перезапуска процесса и потери набранного черновика. Desktop подтверждает выбор по записи runtime, не отправляя служебный запрос модели. Пустая сессия остаётся в истории; её можно удалить обычной командой после закрытия вкладки.
- Handoff-переходы отслеживаются без перезапуска: текущая сессия остаётся в корне раскрываемой группы, архивные предшественники вложены под ней, а поиск сохраняет полную цепочку.
- Фиксация основного провайдера хранится для конкретной сессии: переключение в состоянии idle перезапускает её через точный `--resume` с локальным overlay без model/usage fallback и переносится на активное продолжение после handoff.
- Desktop Proxy Mode включается отдельно для каждого провайдера в настройках: новые и перезапущенные сессии получают локальный overlay, который удерживает fallback внутри выбранного провайдера и отключает OpenAI WebSocket transport. Уже работающие сессии не изменяются до перезапуска.
- Экран «Провайдеры» показывает отдельные аккаунты из `omp usage`, лимиты по семействам моделей, окна и время сброса, отключённые credentials и оценку доступности маршрутов. Здесь же можно временно отключать любые провайдеры через `disabledProviders`, удалять custom providers и добавлять OpenAI- или Anthropic-совместимые API с автоматическим `/models` discovery. Форматы Chat Completions, Responses API и Anthropic Messages снабжены пояснениями; новые Provider IDs нормализуются в нижний регистр. Идентификаторы аккаунтов маскируются в backend; API keys используют защищённое хранилище Desktop, не записываются в `models.yml` и не возвращаются в снимках настроек.
- Идемпотентный импорт OMP и Codex JSONL с режимами «пропустить», «обновить» и «создать копию»: JSONL ограничен 256 MiB, связанные артефакты копируются транзакционно без ссылок и ограничены 512 MiB, 10 000 записей и глубиной 16 каталогов.
- Большие транскрипты читаются ограниченно: интерфейс показывает начало и последние записи и явно отмечает пропущенную середину. Повреждённые записи в прочитанной части и незавершённая последняя строка отмечаются отдельно; чтение не изменяет исходный файл.
- Кнопка «Читать» над текущим терминалом открывает последние сохранённые сообщения в режиме «Только диалог», не останавливая OMP и не меняя набранный черновик. Это снимок JSONL: новые записи появляются после «Перечитать файл», без отправки запроса модели.
- Переписка отображает Markdown: заголовки, списки, цитаты, таблицы и отдельные блоки кода. «Копировать блок» сохраняет его текст, отступы и пустые строки без ограждений; у сообщения есть копирование видимого текста и исходного Markdown. Доступны исходный вид и переход к последнему сообщению. HTML остаётся текстом, внешние изображения не загружаются автоматически, ссылки используют защищённые действия Desktop.
- Поиск в просмотре переписки проходит по всему загруженному видимому тексту выбранного режима, а не только по строкам на экране: `Ctrl+F`, счётчик отдельных совпадений, переходы вперёд/назад и подсветка, включая текст через Markdown-разметку и подписи ссылок. Пропущенная при ограниченном чтении середина файла в поиск не входит.
- Просмотр переписки из боковой панели запоминает сообщение и смещение при повторном открытии в текущем запуске Desktop; позиции разных сессий независимы и не записываются в JSONL. Перечитывание файла сохраняет место, а переключение исходного и форматированного вида удерживает текущее сообщение. `Tab` переводит фокус на область переписки, где работают стрелки, `PageUp` / `PageDown`, `Home` и `End`.
- Несколько одновременно работающих терминальных вкладок.
- Настоящий нативный PTY с изменением размера, прерыванием и корректным завершением процессов.
- Настраиваемые путь к OMP, корень сессий, модели, язык и шрифты. «Настройки → Основное → Масштаб текста интерфейса» увеличивает текст приложения от 100% до 200%, сохраняется между запусками и не меняет независимый размер шрифта терминала.
- «Настройки», просмотр переписки и окна импорта OMP/Codex удерживают клавиатурный фокус: `Tab` / `Shift+Tab` обходят доступные элементы внутри окна, `Escape` учитывает вложенные элементы управления, а закрытие возвращает фокус к доступной кнопке открытия. Пока фокус на нативном выпадающем списке, `Escape` не закрывает окно, даже если список уже свёрнут: сначала перейдите `Tab` к другому типу элемента или используйте кнопку закрытия. Выполняющийся импорт нельзя закрыть до получения результата.
- Сбой начальной загрузки конфигурации OMP виден в основном окне с кнопкой повторного чтения. Сохранение настроек делает прежние ответы загрузки неактуальными и в основном окне, и в «Настройках»; если сохранение не вернуло снимок OMP, оба экрана запрашивают свежий. Экран восстановления настроек Desktop открывает их папку, даже когда сам `settings.json` недоступен.
- Раздел «Работа OMP» показывает поддержанные установленным runtime числовые, логические и перечислимые настройки: поиск, категории, только изменённые поля и возврат к значению схемы OMP. Сохранение проверяет конфликты; проектные настройки сохраняют приоритет, работающие процессы не перезапускаются.
- Монитор системных ресурсов показывает доступную RAM, swap pressure, свободное место для сессий, проекта и временных файлов, а также RSS Desktop и прямых процессов OMP. Он ничего не завершает и не удаляет автоматически.
- Боковая панель имеет сохраняемые режимы «развёрнута», «компактная» и «автоскрытие» (`Ctrl+B`). Автоскрытие и глобальные сочетания не мешают импорту и просмотру переписки; после удаления проекта потерянный фокус возвращается на «Открыть папку», не перехватывая уже выбранный пользователем элемент.
- Полные Unicode-названия сессий доступны по наведению и keyboard focus. Название новой сессии синхронно обновляется во вкладке и списке; если OMP ещё не сгенерировал его, используется первая пользовательская реплика. Выделенный текст терминала можно добавить в текущий ввод как явную цитату кнопкой «Ответить» или правой кнопкой мыши; отправка остаётся под контролем пользователя. `Ctrl+A` явно выбирает текущий ввод OMP для очистки, а перемещение мышью ограничено безопасно распознанными wrapped-строками.
- Ссылки в терминале и просмотре переписки открываются через системные приложения: веб-адреса — в браузере, поддержанные документы проекта и `file://` / `local://` / `artifact://` — в соответствующем приложении. Контекстное меню позволяет отдельно показать файл в папке; программы, скрипты и неизвестные типы только показываются, но не запускаются. Поддержаны селекторы чтения, пробелы, кириллица и заголовок сессии после title-slot. Выделенный текст копируется через меню «Копировать», рядом с «Ответить» в терминале.
- Открытие ссылки или папки из терминала завершает жест мыши при отпускании кнопки: движение курсора после клика не продолжает выделять текст. Намеренное выделение текста ссылки не открывает её.
- В текущем вводе OMP `Ctrl+Z` отменяет редактирование, `Ctrl+Backspace` / `Ctrl+Delete` удаляют слово, `Shift+Enter` добавляет строку, а `Ctrl+Enter` отправляет follow-up. `Ctrl+C` копирует выделенный текст или прерывает работу без выделения; `Ctrl+V` использует штатную вставку OMP, включая изображения, а `Ctrl+Shift+V` вставляет текст без сворачивания. `Ctrl+Y` сохраняет значение OMP yank, а не redo; обычные поля интерфейса используют стандартные сочетания WebView.
- Межпроцессное владение session JSONL защищено OS lease: активные resume/discovered/delete операции удерживают lock, а stale metadata требует явного reclaim. После сбоя старые данные сохраняются в bounded quarantine; автоматического silent takeover нет.
- Второй запуск с `--project <path>`, `-p <path>` или позиционным путём передаёт workspace в уже открытое окно.
- Нажатие версии Desktop запускает ручную проверку обновления. Уведомления OMP и Desktop используют общий стек без взаимного перекрытия; фоновые предложения обновиться не закрывают кнопки модальных окон. Установка при работающих терминалах требует подтверждения до загрузки; отмена сохраняет их работу. На время подтверждения и установки заблокированы новые запуски терминалов и перезапуск для смены фиксации провайдера. Установка не начинается при незавершённом запуске или перезапуске терминала; отмена и ошибка установки освобождают блокировку.
- Единая кодовая база и установщики для Windows и Linux.

</details>

### Установка

1. [Установите и настройте Oh My Pi](https://github.com/can1357/oh-my-pi#install) для текущего пользователя. Desktop не включает OMP runtime или подписку на API-провайдера.
2. Откройте [последний GitHub Release](https://github.com/Omnividente/omp-desktop/releases/latest).
3. Выберите пакет для **x86-64**:
   - Windows: `OMP.Desktop_*_x64-setup.exe` или `.msi`.
   - Linux: AppImage, DEB или RPM.

Для AppImage:

```bash
chmod +x OMP.Desktop_*.AppImage
./OMP.Desktop_*.AppImage
```

Для Debian/Ubuntu (`.deb`):

```bash
sudo apt install ./OMP.Desktop_*_amd64.deb
```

Для Fedora/RHEL/OpenSUSE (`.rpm`):

```bash
sudo dnf install ./OMP.Desktop-*.x86_64.rpm
# или на OpenSUSE:
sudo zypper install ./OMP.Desktop-*.x86_64.rpm
```

### Поддержка и обратная связь

- [Ошибки и предложения Desktop](https://github.com/Omnividente/omp-desktop/issues) — укажите версии Desktop/OMP, ОС и шаги воспроизведения.
- [Вопросы и обсуждения](https://github.com/Omnividente/omp-desktop/discussions) · [Как внести вклад](CONTRIBUTING.md).
- [Уязвимости сообщайте приватно](SECURITY.md). Перед публикацией логов и снимков удаляйте ключи, личные пути и содержимое приватных сессий.

## English

**OMP Desktop** is an independent open-source graphical client for [Oh My Pi](https://github.com/can1357/oh-my-pi). It brings project and session management, transcript history, and live OMP terminals into one native application for Windows and Linux.

For users who want graphical project and settings controls while retaining the OMP workflow: live conversations still use OMP's embedded terminal interface (TUI), not a separate graphical chat. This is a local desktop application, not a browser client or hosted service; OMP is installed separately.

**[Installation](#installation) · [Latest stable release](https://github.com/Omnividente/omp-desktop/releases/latest)**

> **Independent client:** not part of the official OMP distribution. Desktop support belongs in this repository; the upstream post does not imply endorsement by OMP. [Integration discussion →](https://github.com/can1357/oh-my-pi/issues/12456)

### Core features

- **Projects and sessions:** workspaces, search, resume, and handoff lineage.
- **Native PTY terminals:** concurrent tabs, resizing, interruption, and process cleanup.
- **Configuration and providers:** OMP settings, models, accounts, limits, and per-session provider pinning.
- **History and diagnostics:** OMP/Codex JSONL import, transcript viewing and search, warnings, and resource monitoring.
- **Windows and Linux:** one codebase, installable packages, and updates that require confirmation when terminals are running.

> The detailed behavior below describes `main`, which may be ahead of the stable build. For an installed version, see its [release notes](https://github.com/Omnividente/omp-desktop/releases). Changes merged after **v0.9.4** will be included in a future release.

<details>
<summary>Detailed features, limitations, and behavior</summary>

- Project sidebar with persisted recent workspaces.
- The last selected project is restored after a Desktop restart; an explicit `--project` takes precedence. Missing or hidden workspaces are not revived automatically, and no terminal starts without a user action.
- Automatic discovery of standard OMP JSONL sessions. Unreadable files and unrecognized headers appear in a separate warning with paths and a retry action; other sessions remain available.
- Search, open, and resume existing sessions.
- A new terminal session immediately gets a JSONL created by OMP itself through `--session`: switch models before the first message without restarting the process or losing the input draft. Desktop confirms the choice from the runtime record without sending a synthetic model request. Empty sessions remain in history and can be deleted normally after closing their tabs.
- Handoff transitions are tracked without restarting: the current session stays at the root of an expandable group, archived predecessors are nested below it, and search preserves the full lineage.
- Primary-provider pinning is stored per session: toggling it while idle restarts the exact `--resume` target with a local no-model/usage-fallback overlay and transfers the pin to the active continuation after handoff.
- Desktop Proxy Mode is enabled per provider in Settings: new and restarted sessions receive a local overlay that keeps fallback within the selected provider and disables the OpenAI WebSocket transport. Already-running sessions are unchanged until restart.
- The Providers screen shows individual accounts from `omp usage`, per-model-family limits, reset windows, disabled credentials, and estimated route availability. The same screen can temporarily disable any provider through `disabledProviders`, delete custom providers, and add OpenAI- or Anthropic-compatible APIs with automatic `/models` discovery. Chat Completions, Responses API, and Anthropic Messages include protocol explanations; new provider IDs are normalized to lowercase. Account identifiers are masked in the backend; API keys use Desktop's protected credential storage, are not written to `models.yml`, and are not returned in settings snapshots.
- Idempotent OMP and Codex JSONL import with skip, update, and copy modes: JSONL is capped at 256 MiB; related artifacts are copied transactionally without links and capped at 512 MiB, 10,000 entries, and 16 directory levels.
- Large transcripts use bounded reads: the UI shows the beginning and latest entries and explicitly marks the omitted middle. Malformed records in the read portion and an incomplete final line are reported separately; reading never changes the source file.
- Read above the current terminal opens the latest saved messages in Dialogue only mode without stopping OMP or changing the input draft. This is a JSONL snapshot: new records appear after Reread file, without sending a model request.
- Transcripts render Markdown headings, lists, quotes, tables and separate code blocks. Copy block preserves its text, indentation and blank lines without fences; messages offer visible-text and original-Markdown copy actions. Source view and latest-message navigation are available. HTML stays literal, remote images are not loaded automatically, and links use Desktop's guarded actions.
- Transcript search scans all loaded visible text in the selected mode, not just onscreen rows: `Ctrl+F`, an occurrence counter, next/previous navigation and highlights across Markdown formatting and link labels. The middle omitted by bounded file reads is not searched.
- Opening a transcript from the sidebar remembers the message and offset during the current Desktop run; sessions keep independent positions and nothing is written to JSONL. Rereading preserves the position, and switching source/formatted views keeps the current message. `Tab` focuses the transcript viewport for arrows, `PageUp` / `PageDown`, `Home`, and `End`.
- Multiple concurrent terminal tabs.
- A real native PTY with resize, interrupt, and reliable process cleanup.
- Configurable OMP executable, session root, models, language, and fonts. Settings → General → Interface text scale enlarges application text from 100% to 200%, persists across restarts, and does not change the independent terminal font size.
- Settings, transcripts and OMP/Codex import dialogs contain keyboard focus: `Tab` / `Shift+Tab` cycle through available controls, `Escape` respects nested controls, and closing restores focus to the available opener. While a native select has focus, `Escape` does not close the dialog, even when its popup is already closed: first `Tab` to a different control type or use the close button. An import cannot be dismissed while it is running.
- Initial OMP configuration failures appear in the main window with a retry action. Saving settings invalidates older configuration responses in both the main window and Settings; if the save returns no OMP snapshot, both views request a fresh one. Desktop settings recovery can open the settings folder even when `settings.json` itself is inaccessible.
- OMP operation exposes numeric, boolean and enum settings supported by the installed runtime: search, categories, changed-only filtering and reset to the OMP schema default. Saving checks conflicts; project settings retain precedence and running processes are not restarted.
- The resource monitor reports available RAM, swap pressure, free space for sessions, the workspace and temporary files, plus RSS for Desktop and direct OMP processes. It never terminates processes or deletes data automatically.
- The project sidebar has persisted expanded, compact and auto-hide modes (`Ctrl+B`). Auto-hide and global shortcuts do not interfere with import or transcript dialogs; after removing a workspace, lost focus returns to Open folder without stealing focus from another control the user selected.
- Full Unicode session titles are available on hover and keyboard focus. A new session title updates in the tab and session list together; until OMP generates one, the first user message provides the fallback. Selected terminal text can be added to the current input as an explicit quote via Reply or the right mouse button, while sending remains under user control. `Ctrl+A` visibly arms the current OMP input for clearing; mouse movement is limited to safely recognized wrapped lines.
- Links in the terminal and transcript use system applications: web URLs open in the browser, while supported project documents and `file://` / `local://` / `artifact://` targets open in their associated application. The context menu can separately reveal a file in its folder; programs, scripts and unknown types are revealed but never launched. Read selectors, spaces, Cyrillic paths and session headers after a title slot are supported. Selected text has a Copy menu action, alongside Reply in terminals.
- Opening a terminal link or folder ends the mouse gesture on button release: moving the pointer after a click does not continue selecting text. Deliberately selecting link text does not follow the link.
- In the current OMP input, `Ctrl+Z` undoes an edit, `Ctrl+Backspace` / `Ctrl+Delete` delete a word, `Shift+Enter` adds a line, and `Ctrl+Enter` submits a follow-up. `Ctrl+C` copies selected text or interrupts when nothing is selected; `Ctrl+V` uses OMP's native clipboard handling, including images, while `Ctrl+Shift+V` pastes uncollapsed text. `Ctrl+Y` retains OMP yank semantics rather than redo; ordinary interface fields keep standard WebView shortcuts.
- Cross-process ownership of session JSONL uses an OS lease: active resume/discovered/delete operations hold the lock, and stale metadata requires explicit reclaim. Crash remnants are retained in bounded quarantine; silent automatic takeover is not performed.
- A second launch with `--project <path>`, `-p <path>`, or a positional path forwards the workspace to the existing window.
- Clicking the Desktop version starts a manual update check. OMP and Desktop update notices share a non-overlapping stack; background update offers do not cover modal controls. Installation with running terminals requires confirmation before downloading; cancellation leaves them running. New terminal launches and provider-pin restarts are blocked during confirmation and installation. Installation cannot start while a terminal launch or restart is pending; cancellation and installation failure release the gate.
- One codebase and installable packages for Windows and Linux.

</details>

### Installation

1. [Install and configure Oh My Pi](https://github.com/can1357/oh-my-pi#install) for the current OS user. Desktop does not bundle the OMP runtime or a model-provider subscription.
2. Open the [latest GitHub Release](https://github.com/Omnividente/omp-desktop/releases/latest).
3. Choose an **x86-64** package:
   - Windows: `OMP.Desktop_*_x64-setup.exe` or `.msi`.
   - Linux: AppImage (`.AppImage`), Debian/Ubuntu (`.deb`), or Fedora/RHEL/OpenSUSE (`.rpm`).

AppImage:

```bash
chmod +x OMP.Desktop_*.AppImage
./OMP.Desktop_*.AppImage
```

Debian/Ubuntu (`.deb`):

```bash
sudo apt install ./OMP.Desktop_*_amd64.deb
```

Fedora/RHEL/OpenSUSE (`.rpm`):

```bash
sudo dnf install ./OMP.Desktop-*.x86_64.rpm
# or on OpenSUSE:
sudo zypper install ./OMP.Desktop-*.x86_64.rpm
```

### Support and feedback

- [Desktop bugs and feature requests](https://github.com/Omnividente/omp-desktop/issues): include Desktop/OMP versions, OS, and reproduction steps.
- [Questions and discussions](https://github.com/Omnividente/omp-desktop/discussions) · [Contributing](CONTRIBUTING.md).
- [Report vulnerabilities privately](SECURITY.md). Redact credentials, personal paths, and private session content before posting logs or screenshots.

## Development

Requirements: Node.js 22+, Rust 1.84+, OMP, and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm ci
npm run tauri dev
```

Verification:

```bash
npm run build
npm run test:release-assets
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The manually dispatchable `Quality Gate` runs the same Windows and Linux checks used by a tagged release. Tagged release runs are serialized per tag, every release job checks out the triggering SHA, and one uniquely identified draft is prepared before the platform matrix starts. Before that exact draft becomes public, the workflow rechecks draft and live-tag state, verifies platform installers, updater signatures, `latest.json`, and checksum contents, and confirms that the uploaded checksum files round-trip byte-for-byte.

The tagged workflow publishes only a candidate prerelease. Its completion automatically triggers `Verify Updater Upgrade E2E`, which rebuilds the latest stable version and the candidate with isolated test keys, exercises signed update and restart on Linux and Windows, and records the `Updater Upgrade E2E` commit status. `Promote Release to Stable` refuses promotion without that successful status and re-verifies the signed tag and candidate assets immediately before publication.

`Release Tag Health` reports immutable semantic tags without published releases and candidate prereleases left unpromoted for more than 24 hours. Historical orphan tags and failed candidates superseded by a newer stable release require typed, reasoned entries in `.github/release-tag-exceptions.json`; a mismatched or stale exception fails the check. CodeQL scans JavaScript/TypeScript and Rust changes, while Dependabot groups weekly npm, Cargo, and GitHub Actions updates; each ecosystem is limited to five open version-update PRs, and unsupported TypeScript major upgrades are ignored.

Repository maintainers must not manually publish the draft, promote the candidate, or edit its assets while the tagged and updater E2E workflows are running; GitHub does not provide an atomic workflow lock against an out-of-band actor who already has release-write permission.

### External pre-release audit

Use one `release/vX.Y.Z` branch and one draft pull request for the complete release scope. Keep independent changes as reviewable commits on that branch instead of creating a branch per finding. The `updater-e2e` environment admits only `main` and `release/*`; manually dispatch the signed updater workflow on the release branch from the latest stable tag before requesting review. Push every intended commit and record the exact head SHA in the pull request. Any code change after approval invalidates that approval: push the follow-up commit, update the recorded SHA, and request re-review. Create the version tag only from the reviewed head after required checks pass.

Create native packages:

```bash
npm run tauri build
```

## Architecture

- `src/` — React UI and xterm terminal views.
- `src-tauri/src/sessions.rs` — OMP session discovery and metadata parsing.
- `src-tauri/src/terminal.rs` — portable PTY lifecycle and event streaming.
- `src-tauri/src/settings.rs` — runtime detection and persisted local settings.
- `src-tauri/src/resource_health.rs` — low-frequency RAM, swap, disk and direct-process sampling.
- `src-tauri/src/lib.rs` — Tauri command surface and application lifecycle.
- `.github/scripts/verify-release-assets.mjs` — final signed-asset and checksum publication gate.

## Privacy and security

- **Local data:** Desktop preferences and provider-key names are stored in `settings.json`. Import copies selected JSONL sessions and bounded regular-file artifact trees into the local OMP session root; links and special files are rejected.
- **Provider credentials added through Desktop:** values use the OS credential store when available. If it is unavailable, Desktop shows a warning and uses a per-user JSON fallback file with restricted filesystem permissions. That fallback is not an encrypted credential store. Secret values are not returned in settings snapshots.
- **Network boundary:** Desktop invokes the installed OMP process for models, usage, and live agent sessions. OMP may send prompts, context, and credentials to configured remote providers and use networked tools; a local Desktop window does not mean offline inference. Desktop has no hosted session service. Its updater contacts GitHub for update metadata and packages.
- **Publishing:** do not include credentials, private transcripts, local state, or personal paths in issues and screenshots. See the [security reporting policy](SECURITY.md).

## License

OMP Desktop is open-source software licensed under the [MIT License](LICENSE).
