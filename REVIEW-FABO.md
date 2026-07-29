# Позиция Fabo — раунд 1 (review/performance-rc.1 @ f9e363f)

Дата: 2026-07-29. Объект: единственный коммит `f9e363f` «perf: batch PTY output and reduce Linux render churn» поверх `main` (v0.1.14). Прочитаны: `REVIEW.md`, полный diff (6 файлов, +460/−42), `src-tauri/src/terminal.rs` целиком, `src/TerminalView.tsx`, `src/terminalOutputBatcher.ts` + тесты, `src/main.tsx`, `package.json`.

**Главный вывод:** архитектура двухуровневого батчинга корректна, инварианты 1–7 подтверждаются кодом. Блокеров нет. До merge: исправить Т-1 (тривиально) и зафиксировать явное решение по Н-1 (граница exit vs хвост вывода).

## Подтверждённые инварианты

1. **Порядок байтов (инв. 1)** — VERIFIED. Один `pty-reader` → FIFO `sync_channel` → один поток `pty-output-*` → последовательные `route_output`; во фронте один listener → FIFO батчера. Покрыто `output_batch_preserves_chunk_order` и «coalesces chunks in byte order».
2. **Snapshot раньше live, без дублей (инв. 4)** — VERIFIED. `route_output` и `attach_terminal` сериализованы мьютексом `processes`: пока `attached == false`, батчи идут только в `pending_output`; после установки флага — только в событие. Пересечение исключено конструктивно. Фронт дополнительно откладывает live-события до возврата `attachTerminal` (`deferredOutput`).
3. **Финальный фронтовый батч раньше exit-строки (инв. 5)** — VERIFIED. `handleExit` → `outputBatcher.flush()` → `terminal.write(exitLine)` в одной очереди xterm.
4. **Память ограничена, backpressure до reader (инв. 2–3)** — VERIFIED. Очередь ≤ 64×8 KiB = 512 KiB, батч ≤ ~72 KiB, фронт ≤ 256 KiB, `pending_output` ≤ 2 MiB. При полной очереди reader блокируется в `send()` — давление доходит до child.
5. **API/payload не изменены, Windows-рендер не тронут (инв. 6–7)** — VERIFIED (`cursorBlink: true`, `smoothScrollDuration: 90` вне Linux).
6. **Бонус:** `exitHandled` закрывает старую возможность двойной exit-строки (`attachment.exited` + поздний `pty-exit`), которая была в baseline.

## Находки

### Н-1. [Medium] `terminal.rs` / `spawn_waiter` + `forward_output_batches` — drain завязан на EOF reader'а

- **Доказательство:** `drained.send(())` выполняется только после выхода из `forward_output_batches`, т.е. когда reader дропнет `output_sender` (EOF/ошибка). Waiter ждёт `recv_timeout(250 ms)`. На Linux EOF/EIO после смерти child приходит быстро. На Windows ConPTY EOF на master-reader может не прийти, пока жив master (хранится в `TerminalProcess` до `close_terminal`): тогда (а) каждый exit ждёт полные 250 мс; (б) при бэклоге хвост может быть отроутен после `pty-exit`. Фронт: после `handleExit` listener жив, поздние батчи запишутся после строки «Процесс OMP завершён» (`exitHandled` не блокирует `queueOutput`); при мгновенном unmount по exit `dispose()` молча выбросит хвост.
- **Риск:** перестановка вывода вокруг exit-строки; редкая потеря хвоста; стабильные +250 мс к exit-latency на Windows (гипотеза, требует замера).
- **Варианты (ранжировано):**
  1. Упорядочить по построению: waiter передаёт exit-статус в output-поток отдельным каналом, и `pty-exit` эмитит output-поток после дренажа очереди. Эффект: гарантия порядка без таймаута; сложность средняя; обратимо.
  2. Минимум для RC: оставить и замерить Windows-поведение, зафиксировать 250 мс в docs; во фронте либо отбрасывать `pty-output` после exit, либо дописывать его до exit-строки через sentinel в батчере.
- **Проверка:** Windows: задержка между завершением процесса и exit-строкой; лог «`pty-output` после `pty-exit`»; синтетический burst с немедленным exit на ALT и Windows.

### Т-1. [Medium] `terminalOutputBatcher.test.ts` — `toHaveLength` на `Map`

- **Доказательство:** `callbacks = new Map()`; `toHaveLength` проверяет `.length`, у Map его нет (есть `.size`). Vitest 4 (`^4.1.10`) такой assert роняет — затронуты 2 из 3 тестов.
- **Риск:** `npm test` красный либо контракт «один таймер на батч» реально не проверяется.
- **Решение:** `expect(callbacks.size).toBe(1)` / `toBe(0)`. **Проверка:** `npm test`.

### Н-2. [Low] `TerminalView.tsx` — платформа по `navigator.userAgent`

- `IS_LINUX_RUNTIME = /\bLinux\b/i.test(navigator.userAgent)` работает для WebKitGTK/WebView2, но хрупко. Надёжнее `platform()` из `@tauri-apps/plugin-os`. Риск — лишь неверный набор render-настроек. Проверка: вывести значение на ALT и Windows.

### Н-3. [Low, pre-existing] `terminal.rs` — `attached` не сбрасывается при unmount

- После unmount без закрытия терминала `route_output` эмитит события без слушателя; байты не попадают и в `pending_output`. Сейчас невоспроизводимо (нет StrictMode, вкладки живут постоянно, remount = закрытие). Не регрессия патча; долг — команда «detach» в cleanup.

### Н-4. [Low/UX] `App.css` — полное удаление pulse

- Согласен с позицией Main для RC. Остаточный риск: при долгом thinking статическая точка читается как «зависло». Компромисс после RC: opacity-only анимация со `steps(2)` под `@media (prefers-reduced-motion: no-preference)` и только вне Linux. Проверка: `grep -rn "pulse" src/` — осиротевших ссылок на удалённый keyframes быть не должно (впрочем, они безвредны).

### И-1..И-3. [Info]

- Латентность интерактивного echo +≤ ~21 мс (5 мс Rust + 16 мс фронт + IPC) — на грани незаметного; при жалобах — leading-edge flush (первый chunk после простоя сразу, коалесцировать последующие). Для RC не требуется.
- `receive_output_batch` может превысить лимит до ~72 KiB (проверка `<` до `extend`) — не баг, только размер payload.
- Аллокация на каждый read (`to_vec` + `extend_from_slice`) — несущественно; возможен пул буферов.

## Ответы на стартовые вопросы

- **Kimi (5 ms / 64 KiB / 64 / 250 ms):** параметры разумны; слабое звено — 250 мс drain, зависящий от EOF (Н-1). Backpressure на ConPTY корректен: блокируется reader, как де-факто и в baseline.
- **Fabo (16 ms / 256 KiB, blink/smooth-scroll):** coalescer корректен — порядок, byte-limit flush и dispose подтверждены кодом и тестами (с поправкой Т-1); отключение blink/smooth-scroll только на Linux оправдано и обратимо.
- **Main (pulse):** удалить для RC — да; follow-up — Н-4.

## Вердикт

- Потеря/дублирование/перестановка вывода в основном пути: **не обнаружены**; единственное окно — exit-граница (Н-1), и оно уже, чем в baseline (там drain-ожидания не было вовсе).
- **MERGE READY: да, после Т-1 и явного решения по Н-1** (для RC достаточно варианта 2 — замер на Windows + зафиксированное решение в журнале ревью).

— Fabo, раунд 1

---

# Позиция Fabo — раунд 2 (review/performance-rc.1 @ 22ca667)

Дата: 2026-07-29. Объект: diff `647aee4...22ca667` (fix-коммит `3cbf59b` «fix(perf): order PTY exit and preserve leading-edge latency», +339/−94; test-коммит `22ca667` «test(pty): cover Windows ConPTY drain ordering», добавляет `src-tauri/tests/conpty_smoke.rs`). Прочитаны: `REVIEW.md` (раздел «Раунд 2 — implementation verdicts»), полные патчи обоих коммитов, `terminal.rs` и `TerminalView.tsx` @ HEAD целиком. H-4–H-10 не переоткрываю — нового блокирующего доказательства нет.

## Confirmed fixes

- **Н-1/H-1 (exit ordering) — FIXED.** Ownership-протокол корректен: `pty-output` и `pty-exit` эмитит один и тот же поток `pty-output-*` (`run_output_pipeline`): дренаж очереди вывода до disconnect канала, затем `exit_receiver.recv()` → `finalize_terminal_exit`. Эвристика 250 мс (`PTY_OUTPUT_DRAIN_TIMEOUT`) удалена полностью — порядок гарантирован по построению, а не по таймауту. Это и есть вариант 1 из моего раунда 1.
- **H-2 (Rust leading-edge) — FIXED.** `drain_output_batches`: idle-состояние — блокирующий `recv()`; первый chunk после простоя уходит немедленно через `receive_ready_output_batch` (только `try_recv`, 0 мс); burst коалесцируется внутренним циклом `recv_timeout(5 ms)` (`receive_timed_output_batch`). Постоянной 5 мс задержки на одиночных chunk'ах больше нет.
- **H-3 (frontend leading/trailing) — FIXED.** `enqueue`: при `timer === null && pending.length === 0` — немедленный `write` (leading) + `scheduleWindow` (trailing window); byte-limit путь: `clearTimer` → `writePending` → `scheduleWindow`. Изолированный ввод пишется с 0 мс, burst коалесцируется окнами 16 мс.
- **Т-1 — закрыт.** Assertions переведены на `callbacks.size`; расхождение по `toHaveLength` признаю: targeted suite фактически проходил, замена сделана для ясности.
- **Бонус:** handles (master/writer/killer) освобождаются при exit, а не при закрытии вкладки — раньше и чище, чем в baseline.

## Ответы на вопросы 1–6

1. **Ownership output → exit вместо timeout — правильный выбор.** Порядок обеспечивается конструктивно единственным эмиттером; таймаут был бы эвристикой с теми же рисками, что в раунде 1.
2. **exit_pending: race-анализ чист.** `attach` vs `finalize` сериализованы мьютексом `processes` — exit не теряется ни в каком порядке. Close до exit: `Drop` убивает child; waiter при `get_mut == None` выходит ДО `send`; drop `exit_sender` → `recv` в pipeline ошибается → поток завершается: ни зависания, ни лишнего emit. Close при `exit_pending`: `Drop` не убивает повторно. `shutdown_all` эквивалентен. Handles дропаются вне мьютекса (`ClosePseudoConsole` безопасен). Утечек `TerminalProcess` не найдено: exited-записи живут в map до close — это baseline-поведение, не регрессия.
3. **Закрытие writer/master после `child.wait` — достаточно** для Unix PTY (reader получает EOF/EIO от смерти child; slave дропнут при spawn) и ConPTY (EOF требует drop master — доказано `conpty_smoke`). Оговорка — Р2-1 ниже.
4. **Оба батчера корректны:** FIFO, byte-limit, flush, dispose проверены по коду; хвост не теряется при `Disconnected` (накопленный батч отправляется до выхода). Постоянных 5/16 мс задержек на изолированном вводе нет (см. H-2/H-3). См. И2-1.
5. **Тесты защищают реальный контракт:** `output_pipeline_emits_exit_after_queued_output` — инвариант «exit после очереди»; тройка Vitest — leading/trailing/byte-limit/dispose; `conpty_smoke` — EOF после drop master + порядок 1000 строк и маркера. Оговорка — Н2-1.
6. **Более простая реализация — нет.** Одноканальный enum Data/Exit ломает сигнал «disconnect = EOF», шаринг sender'а и блокирует exit за полной очередью. Текущая схема (два канала + exit_pending) — минимальная корректная.

## Unresolved blockers

Нет.

## Новые находки / regressions

### Р2-1. [Medium, гипотеза] `terminal.rs` — ожидание exit теперь неограниченно по времени

- **Доказательство:** `run_output_pipeline` дренирует вывод до disconnect, т.е. до EOF у reader'а. На Unix, если после смерти OMP остаётся осиротевший внук, держащий slave pty открытым (например, `sh -c 'sleep 30 >/dev/tty & exit 0'`), EOF не приходит — `pty-exit` не эмитится неограниченно долго: вкладка выглядит живой, но ввод отвергается (`exit_pending`). Escape hatch — закрыть вкладку, поэтому не blocker.
- **Но:** решение Main в раунде 1 гласило «bounded watchdog допустим только как аварийный путь с явной ошибкой», а реализация убрала watchdog полностью — без зафиксированного решения в журнале.
- **Варианты:** 1) аварийный watchdog 30–60 с после `exit_pending` с явной ошибкой в exit-строке (предпочтительно); 2) проверить, что OMP не оставляет держателей tty, и явно задокументировать отказ от watchdog.
- **Проверка:** Unix-фикстура `sh -c 'sleep 30 >/dev/tty & exit 0'` — замерить время до exit-строки.

### Н2-1. [Low] `src-tauri/tests/conpty_smoke.rs` — хрупкий handshake-assert

- Тест делает `read_exact(4)` и строго требует, чтобы ПЕРВЫЕ байты были ровно `\x1b[6n`. Другие сборки Windows/ConPTY могут эмитить иные init-последовательности первыми → ложный красный CI. Fix: сканировать начальный вывод на подстроку `\x1b[6n`. Проверка: прогон на другой версии Windows.

### И2-1. [Info] Частота IPC при sustained burst

- Leading+trailing даёт до ~2 `write` на 16 мс цикл во фронте (было 1). Ограничено и приемлемо; учитывать при A/B-сравнениях CPU.

## Минимальные обязательные изменения

Блокирующих нет. Рекомендовано до merge: зафиксировать решение Main по Р2-1 (любой из двух вариантов); смягчить assert в `conpty_smoke` (Н2-1).

## Финальный verdict

**APPROVE RC** — при зафиксированном в `REVIEW.md` решении по Р2-1.

— Fabo, раунд 2
