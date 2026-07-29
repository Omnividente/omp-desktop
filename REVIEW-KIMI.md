# REVIEW-KIMI — позиция KIMI, раунд 1

Объект: ветка `review/performance-rc.1`, commit `f9e363f` (+460/−42). Изучены `REVIEW.md`, весь diff и связанный код целиком: `terminal.rs`, `TerminalView.tsx`, `terminalOutputBatcher.ts` + тест, `App.css`, `api.ts`, `TerminalWorkspace.tsx`, `package.json`.

## Главный вывод

Архитектура верная: bounded `sync_channel` + выделенный `pty-output-*` thread + listen-first-then-attach снимают исходную CPU/render-проблему без смены публичного API. Merge блокирует Н-1: порядок «финальный output → pty-exit» гарантирован эвристикой 250 ms, а не протоколом. Средний приоритет — регрессия интерактивной latency (Н-2: +5 ms, Н-3: +16 ms на изолированный chunk).

## Находки

### Н-1 [Средний, блокирующий] drain 250 ms — не гарантия порядка финального output относительно exit
`terminal.rs` `spawn_waiter` / `forward_output_batches`. `drained.send` идёт только после disconnect канала; waiter по `recv_timeout(250ms)` эмитит `pty-exit` в любом случае, а output-thread продолжает `route_output`. На фронте `handleExit` пишет exit-line и ставит `exitHandled` — запоздалые chunks попадают ПОСЛЕ строки «Процесс OMP завершён». Перестановка без потери данных; нарушение инвариантов 1 и 5; A/B smoke порядок байт не проверял.
Решения: (1) join reader-thread после `wait()` + backstop 1–2 с с warn-логом → RC; (2) seq-нумерация output/exit → RC+1 (меняет payload).
Проверка: Rust-тест — child пишет ~8 МиБ и сразу exit → все байты до `pty-exit`; E2E — exit-line последняя в xterm buffer; смоделировать drain > 250 ms задержкой в `route_output`.

### Н-2 [Средний] `receive_output_batch`: полное 5 ms окно при пустой очереди
`recv_timeout(≈5ms)` выполняется даже когда chunks больше нет → +5 ms на каждый изолированный chunk (эхо клавиши, короткие ответы) против baseline.
Решение: adaptive — `try_recv` после первого chunk, timed-окно только при подтверждённом потоке; либо окно 1–2 ms.
Проверка: unit-тест «одиночный chunk без ожидания» + A/B замер latency эха.

### Н-3 [Средний] `terminalOutputBatcher`: debounce без leading edge
`enqueue` всегда ставит 16 ms timer → одиночный chunk ждёт 16 ms до `xterm.write` (baseline — немедленно). Суммарно с Н-2 ≈21 ms+ к эхо — «вязкость» терминала. Time-window flush тестом не покрыт.
Решение: throttle с leading edge (писать сразу, если с прошлого flush ≥16 ms, иначе trailing через остаток окна).
Проверка: vitest — одиночный enqueue после idle пишется синхронно; burst coalesce и dispose-контракты не ломаются.

### Н-4 [Низкий-средний, pre-existing] `write_bytes`: блокирующая запись в PTY под мьютексом `processes`
`write_all`+`flush` под `lock_processes`; при полном kernel buffer write блокируется, удерживая глобальный мьютекс, reader в это время может ждать место в sync_channel → взаимоблокировка концов PTY и всех UI-команд. Патч не создаёт, но делает backpressure штатным режимом.
Решение: writer под отдельный lock / writer-thread → RC+1.
Проверка: stdout flood + >128 КиБ stdin без зависания команд.

### Н-5 [Низкий] `TerminalView` `deferredOutput` неограничен до завершения `attachTerminal`
Backend cap 2 МиБ покрывает только `pending_output`; live-события во время attach копятся в JS без лимита. Вероятность мала. Решение: bound/drop-oldest опционально, для RC — задокументировать.

### Н-6 [Низкий] `IS_LINUX_RUNTIME` — UA-sniffing; `cursorBlink=false` навсегда и без настройки
Хрупко (кастомные UA), UX-риск (курсор менее заметен) — отключено безотносительно нагрузки.
Решение: платформа из Tauri (plugin-os/invoke) + опциональная настройка или `prefers-reduced-motion`.
Проверка: ручной тест ALT/Windows — различие только на Linux.

### Н-7 [Низкий] `App.css`: pulse удалён глобально — оспариваю позицию Main
`prefers-reduced-motion` уже существовал; выигрыш измерен только на ALT, а на Windows/macOS статичные индикаторы менее заметны при неподтверждённом выигрыше.
Решение: вернуть pulse под `@media (prefers-reduced-motion: no-preference)` на не-Linux (platform-class) или явно зафиксировать отказ.
Проверка: визуальный чеклист thinking-индикатора на обеих ОС.

### Н-8 [Низкий] `route_output` → `cache_resume_path` на каждый batch
Клон `breadcrumb_snapshot` + fs metadata/read_dir на горячем пути вывода; дублирует session-watcher 4 Гц.
Решение: throttle discovery или положиться на watcher.
Проверка: профиль burst — доля `route_output` в fs syscalls.

### Н-9 [Косметика] `PTY_OUTPUT_BATCH_LIMIT` проверяется до `extend` — batch может превысить 64 КиБ на один chunk (~8 КиБ). Мягкий лимит — задокументировать.

## Подтверждено корректным (verdict)

- Порядок snapshot → deferred live → exit при attach (`outputReady`/`deferredExit`/`exitHandled`); двойной exit подавлен.
- Потеря вывода исключена: bounded очередь + `pending_output` 2 МиБ; `dispose` чистит timer/listeners.
- Память ограничена (очередь ≤512 КиБ + batch ≤~72 КиБ + pending ≤2 МиБ на терминал); backpressure до reader (инвариант 3) — OK.
- Нет вложенных мьютексов; `route_output` не держит lock над `emit`; частичный fail spawn не оставляет потоков-сирот (remove → Drop → killer).
- Инвариант 6 (API/payload) и 7 (Windows render) соблюдены. Тесты byte order и size-limit flush есть (Rust и TS).

## Гипотезы

- Г-1: вклад batcher в A/B не изолирован от cursorBlink/smoothScroll/pulse removal → A/B-C burst с фичефлагом «только batcher».
- Г-2: свёрнутое окно WebKitGTK может throttle `setTimeout` (≥1 с) → задержка flush; спасает лимит 256 КиБ → burst при свёрнутом окне, замер backlog.
- Г-3: ConPTY EOF edge cases (зависшее pseudoconsole) — drain-timeout как backstop достаточен, но Windows smoke обязателен по критерию приёмки.

## Ответы на стартовые вопросы

- Kimi (Rust): `5ms/64KiB/64chunks` разумны; `250ms drain` — недостаточная гарантия порядка (Н-1); backpressure на Windows корректен по построению, нужен smoke (Г-3).
- Fable (frontend): `16ms/256KiB` корректен по памяти/порядку; нужен leading edge (Н-3); Linux-only blink/smooth оправдано, но через platform API, не UA (Н-6).
- Main (pulse): оспариваю глобальное удаление (Н-7).

## Варианты (ранжированные)

1. Join-based drain + backstop 1–2 с + warn-лог — эффект высокий, риск низкий, сложность низкая, обратимо → RC.
2. Leading-edge throttle (frontend) + adaptive окно (Rust) — эффект средне-высокий (интерактивная latency), риск низкий → RC.
3. Seq-нумерация output/exit — полная гарантия порядка, ломает инвариант 6 → RC+1.
4. Вынос blocking write из-под `processes`-мьютекса — надёжность, риск средний → RC+1.
5. Platform detection через plugin-os + UX-политика cursorBlink/pulse → RC+1 или документированное решение.
6. Оставить как есть + observability (лог drain timeout, счётчики backlog) — fallback; Н-1 не закрывает.

## Рекомендация и verdicts по критериям приёмки

Merge RC после (1)+(2), теста exit-ordering и Windows smoke; (3)–(5) — backlog RC+1; по pulse — явное решение (Н-7).
- byte/exit ordering: verdict НЕТ до (1).
- backpressure/память: OK.
- потеря/дублирование frontend output: потеря исключена; порядок относительно exit — до (1).
- UX indicators/Linux settings: условно OK до решения Н-6/Н-7.
- Пробелы тестов: exit-ordering, time-window flush, Windows smoke.
