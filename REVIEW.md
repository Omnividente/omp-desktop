# OMP Desktop performance RC review

## Объект ревью

- Ветка: `review/performance-rc.1`
- Baseline: установленная ALT-сборка, UI `v0.1.13`
- RC: `v0.1.14`
- Scope: только исходники приложения и локальная RC-ветка. Installers, GitHub, release assets и публикация не входят в эту работу.

Проблема: при частом PTY-выводе каждый 8 KiB read немедленно проходил через Rust state/router, Tauri event и отдельный `xterm.write`. На Linux WebKitGTK это создавало длительную нагрузку CPU и лишний render churn.

## Patch

Полный patch для ревью:

```bash
git show --format=fuller --stat --patch HEAD -- \
  src-tauri/src/terminal.rs \
  src/TerminalView.tsx \
  src/App.css \
  src/terminalOutputBatcher.ts \
  src/terminalOutputBatcher.test.ts
```

### `src-tauri/src/terminal.rs`

- PTY reader оставлен блокирующим и коротким: читает по 8 KiB и пишет в bounded `sync_channel`.
- Новый `pty-output-*` thread объединяет chunks до 5 ms или примерно 64 KiB и только затем вызывает `route_output`.
- Очередь ограничена 64 chunks, то есть примерно 512 KiB; при перегрузке reader получает backpressure вместо неограниченного роста памяти.
- Waiter ждёт drain output-потока до 250 ms перед `pty-exit`, уменьшая риск, что exit обгонит финальный вывод.
- Добавлены Rust-тесты порядка bytes и size-limit flush.

### `src/terminalOutputBatcher.ts`

- Frontend coalescer объединяет Tauri output events до 16 ms или 256 KiB.
- Один chunk передаётся в xterm без копирования.
- Несколько chunks копируются один раз в итоговый `Uint8Array`.
- `dispose()` отменяет timer и освобождает pending chunks.

### `src/TerminalView.tsx`

- Все live events проходят через frontend batcher.
- До завершения `attachTerminal` events откладываются; порядок остаётся: attachment snapshot → deferred live output → exit.
- Перед exit batch принудительно flush-ится.
- На Linux отключены `cursorBlink` и smooth scrolling; на Windows поведение не меняется.

### `src/App.css`

- Удалены бесконечные pulse-анимации индикаторов thinking/loading.
- Цвет, подпись и статическое состояние индикаторов сохранены.

### `src/terminalOutputBatcher.test.ts`

Проверены три наблюдаемых контракта:

1. byte order при coalescing;
2. немедленный flush на byte limit;
3. отсутствие отложенной записи после dispose.

## Инварианты

1. Порядок PTY bytes не меняется.
2. Память Rust-очереди ограничена.
3. Backpressure применяется до PTY reader, а не после неограниченного накопления.
4. Attachment snapshot всегда записывается раньше live events, полученных во время attach.
5. Финальный накопленный frontend batch записывается раньше exit line.
6. Публичный Tauri API и event payload не изменены.
7. Windows render settings не изменены.

## ALT A/B smoke

Одинаковый synthetic burst выполнен на одной ALT-машине и одном display:

- 500 000 строк формата `perf-rc-NNNNNN\r\n`;
- bytes записывались напрямую в stdout активного PTY, без model/API request;
- `top` снимал процессы desktop и WebKit каждые 250 ms;
- после теста обе отдельные сборки и их OMP children остановлены; все тестовые PID исчезли.

| Метрика                                        | Baseline `v0.1.13` | RC `v0.1.14` | Изменение |
| ---------------------------------------------- | -----------------: | -----------: | --------: |
| End-to-end writer wall time, включая SSH setup |             5.57 s |       4.17 s |    −25.1% |
| Peak desktop CPU                               |             191.4% |       111.7% |    −41.6% |
| Peak WebKit CPU                                |             163.2% |       147.3% |     −9.7% |
| Desktop CPU time за burst                      |             4.83 s |       1.42 s |    −70.6% |
| WebKit CPU time за burst                       |             8.08 s |       1.61 s |    −80.1% |

Интерпретация: главный выигрыш — не только peak, а резко меньшая длительность высокой нагрузки. RC после burst вернулся к idle без зависания. Wall time включает SSH establishment и поэтому является вспомогательной, а не основной метрикой.

Ограничения: это синтетический output stress, а не model response. Память OMP child между запусками различалась, поэтому RSS не используется для вывода. CPU-цифры зависят от фоновой нагрузки ALT; сравнивать следует направление и длительность, не абсолютные значения.

## Стартовые направления ревью

Эти вопросы задают точку входа, но не ограничивают область анализа. Каждый участник вправе проверить весь patch, обнаружить проблему вне своей стартовой темы, оспорить исходные предположения и предложить любое число вариантов решения.

### Kimi — Rust batching и системные риски

Стартовый вопрос: достаточно ли безопасна комбинация `5 ms / 64 KiB / 64 chunks / 250 ms drain`, особенно для порядка финального output относительно exit и для backpressure на Windows ConPTY?

Дополнительно приветствуются любые находки по потокам, блокировкам, памяти, Tauri events, portability и архитектуре backend.

### Fable — frontend, xterm и пользовательская отзывчивость

Стартовый вопрос: корректен ли `16 ms / 256 KiB` coalescer с явным flush на attach/exit, и оправдано ли отключение blink/smooth scroll только на Linux?

Дополнительно приветствуются любые находки по React lifecycle, порядку событий, xterm API, render churn, latency, UX и тестируемости.

### Main — интеграция и итоговое решение

Стартовый вопрос: стоит ли удалять pulse-анимации глобально, если thinking/loading остаются различимы по цвету и тексту?

Исходная позиция Main: для RC — да, поскольку анимация не несёт уникального состояния, а постоянная repaint-нагрузка противоречит цели исправления. Возможный вариант — вернуть pulse только вне Linux и при отсутствии `prefers-reduced-motion`. Эта позиция не окончательная и может измениться после новых доказательств Kimi или Fable.

## Формат беседы с Kimi и Fable

1. Все участники получают один и тот же commit, `REVIEW.md`, patch и результаты A/B smoke.
2. Kimi, Fable и Main независимо ревьюят весь patch. Стартовые направления определяют фокус, но не границы.
3. Разрешены дополнительные находки, перекрёстные замечания, несогласие с постановкой задачи, альтернативная архитектура и любое обоснованное число вариантов.
4. Каждая подтверждённая находка должна ссылаться на файл/символ, тест либо измерение. Непроверенную идею нужно явно пометить как гипотезу и указать способ проверки.
5. Альтернативы следует ранжировать по ожидаемому эффекту, риску, сложности и обратимости, а не перечислять без рекомендации.
6. Main после каждого раунда объединяет результаты без потери уникальных замечаний в таблицу `находка / доказательство / варианты / решение / проверка`.
7. В следующем раунде участники могут критиковать выводы друг друга, но отвечают на конкретную находку или вариант из общей таблицы.
8. Повторять уже зафиксированное замечание не нужно; новый ответ должен добавлять доказательство, контраргумент, вариант или результат проверки.
9. Раунды продолжаются до закрытия блокирующих рисков и явного решения по существенным альтернативам.

Рекомендуемый, но не обязательный шаблон ответа:

```text
Раунд N — участник
Главный вывод: <что следует сделать и почему>
Находки:
- [severity] <файл/символ или метрика> — <проблема и доказательство>
Гипотезы:
- <непроверенная идея> — <как проверить>
Варианты:
1. <вариант> — <эффект, риск, сложность, обратимость>
2. <вариант> — <эффект, риск, сложность, обратимость>
Рекомендация: <предпочтительный вариант или запрос дополнительного эксперимента>
```

## Критерий принятия RC

RC можно считать готовым к merge только если:

- нет нерешённых блокирующих находок независимо от того, кто и вне какой стартовой темы их обнаружил;
- byte/exit ordering, backpressure и ограничение памяти получили явный verdict;
- исключены потеря, дублирование или неправильный порядок frontend output;
- UX статических indicators и Linux-specific render settings признан приемлемым;
- по существенным альтернативам зафиксировано решение с аргументами, включая причины отказа от остальных вариантов;
- все требуемые дополнительные эксперименты выполнены либо явно признаны необязательными для RC;
- локальные Rust/TypeScript проверки и ALT smoke остаются зелёными.

## Раунд 1 — таблица решений Main

Источники: `REVIEW-KIMI.md` и `REVIEW-FABO.md`. Severity ниже отражает итоговую оценку Main после сверки с текущим кодом и выполненными проверками.

| Находка                                                                          | Доказательство                                                                                                                                                                                            | Варианты                                                                                             | Решение                                                                                                                                                                                                                                             | Проверка                                                                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **H-1 · Blocker:** финальный output может прийти после `pty-exit`                | `spawn_waiter` ждёт `output_drained` только 250 ms, затем эмитит exit; `forward_output_batches` может продолжить `route_output`; `TerminalView.queueOutput` принимает поздние chunks и после `handleExit` | Увеличить timeout; join/drain reader; передать ownership exit output-потоку; ввести sequence numbers | **Изменить в RC:** output и exit должны упорядочиваться протоколом, а не удачным таймингом. Output-поток должен завершить доступный хвост до exit; bounded watchdog допустим только как аварийный путь с явной ошибкой, без молчаливой перестановки | Rust-тест с искусственно медленным routing и хвостом >250 ms; frontend-тест «exit line последняя»; ALT и Windows burst+exit smoke |
| **H-2 · Medium:** Rust добавляет до 5 ms к одиночному chunk                      | После первого `recv()` выполняется `recv_timeout` до конца полного окна, даже если burst не сформировался                                                                                                 | Оставить; сократить окно; adaptive/leading-edge batching                                             | **Изменить в RC:** первый chunk после idle отправлять без полного ожидания, последующие chunks burst объединять                                                                                                                                     | Тест первого isolated chunk и burst coalescing; latency smoke интерактивного echo                                                 |
| **H-3 · Medium:** frontend добавляет 16 ms к каждому isolated chunk              | `enqueue()` всегда создаёт timer; до timer или byte-limit вызова `write()` нет                                                                                                                            | Debounce; `requestAnimationFrame`; leading-edge throttle с trailing batch                            | **Изменить в RC:** leading edge после idle, затем bounded trailing batches. Это сохраняет burst-coalescing и убирает постоянные +16 ms                                                                                                              | Vitest: первый isolated enqueue пишет сразу; последующие chunks объединяются; dispose не пишет                                    |
| **T-1 · Rejected as defect:** `toHaveLength` используется с `Map`                | Текущий Vitest 4.1.10 фактически выполняет оба assertions: targeted suite прошёл 3/3                                                                                                                      | Оставить matcher; заменить на явную проверку `.size`                                                 | Ошибка теста **не подтверждена**. Разрешена механическая замена на `.size` только для ясности, но это не bugfix и не gate                                                                                                                           | `npm test -- src/terminalOutputBatcher.test.ts` — 3/3 passed на текущем commit                                                    |
| **H-4 · Low, pre-existing:** blocking PTY write под глобальным `processes` mutex | `write_bytes` держит mutex во время `write_all` и `flush`; возможна взаимная блокировка при одновременно заполненных stdin/stdout                                                                         | Отдельный lock writer; writer-thread; оставить                                                       | **Отложить в RC+1:** риск реальный, но существовал до патча; bounded output queue даёт больше запаса, чем baseline. Нужен отдельный стресс-сценарий                                                                                                 | stdout flood + большой stdin; убедиться, что resize/close и остальные terminals не зависают                                       |
| **H-5 · Low:** `deferredOutput` не ограничен во время attach                     | После backend `attached=true`, но до resolve `attachTerminal` live events складываются в JS array без byte cap                                                                                            | JS cap с потерей старого; backpressure-протокол; оставить короткое окно                              | **Отложить:** не вводить скрытую потерю output. Сначала измерить длительность attach и максимум backlog                                                                                                                                             | Инструментировать attach latency/backlog под burst                                                                                |
| **H-6 · Low:** Linux определяется по `navigator.userAgent`                       | Другого platform abstraction в frontend сейчас нет; выражение работает в проверенных WebView2/WebKitGTK, но является эвристикой                                                                           | `@tauri-apps/plugin-os`; backend platform payload; оставить                                          | **Оставить для RC**, вынести typed platform source в RC+1; новая зависимость не оправдана только этой настройкой                                                                                                                                    | ALT/Windows smoke значений и render settings                                                                                      |
| **H-7 · Low/UX:** pulse удалён глобально                                         | Kimi ожидает потерю заметности; Fabo и Main считают статические цвет+текст достаточными. CPU-эффект отдельно от batching не изолирован                                                                    | Глобально static; pulse вне Linux; `prefers-reduced-motion`; настройка                               | **Оставить static для RC:** состояние остаётся явным, а цель RC — исключить постоянный repaint. Вернуться к platform-scoped варианту только после отдельного профиля и UX-проверки                                                                  | Визуальный ALT/Windows checklist; feature-isolated CPU profile при необходимости                                                  |
| **H-8 · Info:** `cache_resume_path` находится в output hot path                  | До обнаружения session path функция клонирует snapshot и сканирует filesystem; после `resume_path.is_some()` сразу возвращает, поэтому постоянный steady-state расход не подтверждён                      | Throttle; только watcher; оставить                                                                   | **Отложить:** профиль сначала; не создавать второй lifecycle session discovery                                                                                                                                                                      | Профиль startup burst до и после обнаружения session path                                                                         |
| **H-9 · Info:** Rust batch может быть примерно 72 KiB при лимите 64 KiB          | Limit проверяется до добавления очередного read chunk размером до 8 KiB                                                                                                                                   | Разрезать chunk; считать лимит мягким; изменить условие                                              | **Оставить как мягкий лимит**, явно закрепить комментарием/тестом при изменении batching-кода                                                                                                                                                       | Unit-тест upper bound `limit + reader_chunk`                                                                                      |
| **H-10 · Low, pre-existing:** `attached` не сбрасывается при remount             | `attach_terminal` устанавливает флаг; отдельной detach-команды нет. Текущий UI держит `TerminalView` до закрытия tab                                                                                      | Добавить detach command; менять lifecycle tabs; оставить                                             | **Отложить в RC+1:** не регрессия performance patch                                                                                                                                                                                                 | Remount/StrictMode smoke с output между unmount и attach                                                                          |

### Scope следующего изменения RC

1. Исправить H-1 так, чтобы exit не мог обогнать уже читаемый или queued output.
2. Убрать постоянную isolated-chunk latency по H-2 и H-3, сохранив bounded burst batching.
3. Добавить regression-тесты ordering и leading edge.
4. Не расширять текущий patch исправлениями H-4–H-10 без отдельного доказательства необходимости.
5. После реализации отправить Kimi и Fabo только новый diff и результаты тестов для второго раунда.

## Раунд 2 — implementation verdicts

### H-1 — закрыт в коде

- Удалены `PTY_OUTPUT_DRAIN_TIMEOUT`, `output_drained` и эвристика 250 ms.
- `spawn_waiter` после завершения child переводит terminal в `exit_pending`, извлекает и закрывает writer/master/killer вне глобального mutex и передаёт `PtyExitEvent` в отдельный канал.
- Для `portable-pty 0.9` это существенно на Windows: `ConPtyMasterPty` владеет `PsuedoCon` и output handle через `Arc<Mutex<Inner>>`; drop master вызывает `ClosePseudoConsole`, после чего reader может дочитать pipe и завершиться.
- `pty-output-*` thread теперь сначала полностью закрывает output channel через `run_output_pipeline`, и только затем вызывает `finalize_terminal_exit` и эмитит `pty-exit`.
- Attach во время drain видит `exit_pending`, но не преждевременный `exited`; окончательный exit приходит тем же упорядоченным путём после output.

Verdict: **fixed** — output → exit задаётся ownership/lifecycle протоколом, а не timeout.

### H-2 — закрыт в коде

- Первый готовый Rust batch после idle собирает только уже queued chunks через `try_recv` и немедленно передаётся дальше.
- Только продолжение подтверждённого burst использует 5 ms timed window.

Verdict: **fixed** — постоянного ожидания 5 ms для isolated chunk больше нет.

### H-3 — закрыт в коде

- Первый frontend chunk после idle немедленно передаётся в `xterm.write` и открывает 16 ms batching window.
- Следующие chunks объединяются в trailing batch; byte-limit, explicit flush и dispose остаются bounded.
- Это соответствует внутреннему поведению xterm.js 6: write calls FIFO-очередны, а первый write после пользовательского ввода сам обрабатывается немедленно для минимизации latency.

Verdict: **fixed** — isolated chunk больше не ждёт frontend timer.

### T-1 — уточнён

Исходный matcher работал в текущем Vitest, поэтому дефект не воспроизведён. Assertions всё же заменены на явные `callbacks.size`, чтобы контракт `Map` не зависел от расширенного matcher behavior.

Verdict: **clarified, not a production bug**.

### Проверки раунда 2

- `cargo test --manifest-path src-tauri/Cargo.toml`: **68 passed** в 4 suites.
- `npm test`: **23 passed**.
- `npm run build`: **passed**.
- ESLint, Prettier, `cargo fmt --check`, TypeScript LSP diagnostics: **passed**.
- Новый Rust regression: даже если exit уже queued, `run_output_pipeline` выдаёт весь output раньше exit.
- Новые Vitest contracts: leading chunk пишется сразу; trailing chunks coalesce; byte-limit и dispose сохраняются.
- ALT real PTY smoke: fake OMP вывел 500 000 строк и немедленно завершился; в xterm последовательно видны `exit-order-499999`, затем строка `Процесс OMP завершён · код 0`; output после exit-строки отсутствует, child завершён.
- Новый Windows-only `conpty_smoke`: реальный `cmd.exe` печатает 1 000 строк и marker, тест эмулирует обязательный cursor-position handshake `ESC[6n` → `ESC[1;1R`, ждёт child, закрывает writer/master и подтверждает reader EOF, полный count и marker после последней строки; **passed за 0.15 s**.

### Scope второго ревью Kimi и Fabo

1. Проверить lifecycle `exit_pending` и закрытие PTY handles на Unix/ConPTY.
2. Проверить, что output-thread ownership действительно исключает поздний output после exit во всех attach/close races.
3. Проверить leading-edge state machines Rust и frontend на потерю batching либо лишние timers.
4. Проверить достаточность unit-тестов, ALT real-PTY smoke и Windows `conpty_smoke`, включая корректность эмуляции cursor-position handshake.
5. Не повторять H-4–H-10 без нового доказательства, что один из них блокирует текущий RC.
