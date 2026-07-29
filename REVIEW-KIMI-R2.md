# REVIEW-KIMI-R2 — позиция KIMI, раунд 2 (adversarial)

Объект: diff `647aee4...22ca667` (коммиты `3cbf59b` fix + `22ca667` test). Изучены: обновлённый раздел «Раунд 2 — implementation verdicts» в REVIEW.md, полные patch обоих коммитов, актуальные `src-tauri/src/terminal.rs`, `src-tauri/tests/conpty_smoke.rs`, `src/terminalOutputBatcher.ts` + тест, `Cargo.toml` (portable-pty 0.9.0) на `22ca667`.

## Таблица вердиктов

| Пункт | Вердикт | Основание |
| --- | --- | --- |
| **H-1** (exit ordering) | **unresolved** — протокол исправлен, но введён новый блокер Б-1 | ordering output→exit теперь задан ownership-цепочкой и доказан тестом, однако появился неограниченный wait EOF: `pty-exit` может не показаться никогда |
| **H-2** (Rust +5 ms) | **fixed** | `receive_ready_output_batch` (try_recv) для первого batch после idle; timed-окно только в подтверждённом burst |
| **H-3** (frontend +16 ms) | **fixed** | leading edge пишет немедленно; trailing coalesce; ровно один bounded timer, утечки нет |
| **T-1** (matcher Map) | **fixed (clarified)** | assertions заменены на `callbacks.size`; дефекта продукта не было |

## 1. H-1 — исключает ли новый lifecycle любой `pty-output` после `pty-exit`

**На пути эмиссии — да, доказуемо.** Цепочка: reader видит EOF/ошибку → `output_sender` dropped → `drain_output_batches` возвращается только когда канал пуст **и** disconnected → только затем `exit_receiver.recv()` → `finalize_terminal_exit` → emit (`terminal.rs`: `run_output_pipeline` ≈1724–1739, `forward_output_batches` ≈1760–1773, `spawn_waiter` ≈1823–1878 на 22ca667). И `pty-output`, и `pty-exit` эмитит один и тот же `pty-output-*` thread — порядок эмиссии равен программному порядку, гонки двух эмиттеров нет. Fallback при упавшем output-потоке (`exit_sender.send` → `finalize_terminal_exit(error.0)`) тоже эмитит exit только после разрыва output-канала. Регрессионный тест `output_pipeline_emits_exit_after_queued_output` это фиксирует.

**Но** гарантия достигнута ценой нового дефекта — блокер **Б-1**: сам `pty-exit` может быть отложен бесконечно (см. ниже).

## 2. Races

- **attach во время `exit_pending` — безопасно.** `attach_terminal` (≈1521–1538) не проверяет `exit_pending` — и это корректно: `pending_output` растёт только при `attached=false`, а мьютекс сериализует attach и `route_output`. Batch либо попадает в snapshot (до `attached=true`), либо эмитится live после attach — обе ветки упорядочены. `exited=false` до finalize, поэтому frontend ждёт финальный exit тем же каналом; `should_emit=attached=true` — exit будет показан. Replay pending после exit невозможен: finalize выполняется после полного drain.
- **close/shutdown одновременно с child exit — безопасно.** `close_terminal` удаляет процесс из map; `Drop` не делает kill при `exit_pending` (kill бессмысленен — child уже мёртв). Waiter получает `None` → выходит; его `exit_sender` dropped → output-thread выходит по ошибке `recv()` без finalize. Дедлока нет; поздний вывод после закрытия вкладки silently дропается — приемлемо.
- **Ошибка/преждевременное завершение reader/output thread — покрыто.** Reader error → runtime error + disconnect → drain завершается → output-thread ждёт exit от waiter. Паника output-thread → fallback finalize в waiter. `sync_channel(1)` гарантирует, что первый `exit_sender.send` не блокируется. Единственный «долгий» случай — живой child + мёртвый reader: exit не финализируется до смерти child; чистится через close. Не блокер.
- **Drop writer/master на Unix и ConPTY — корректно.** Выполняется после `wait()`, вне глобального мьютекса, до отправки exit. Для ConPTY (portable-pty 0.9.0 подтверждён в Cargo.toml) drop master → `ClosePseudoConsole` → reader дочитывает pipe → EOF; верифицировано `conpty_smoke` (passed 0.15 s). Побочный эффект: `resize_terminal`/`write_bytes` после take возвращают «Процесс OMP уже завершён»; frontend гасит resize (`catch(() => undefined)`) или показывает toast при вводе — приемлемо, но усугубляется Б-1.

## 3. `conpty_smoke.rs`

- **Эмуляция `ESC[6n` → `ESC[1;1R` корректна.** Это настоящий DSR/CPR-handshake ConPTY: запрос читается с output-pipe master (4 байта, точный assert `b"\x1b[6n"`), ответ пишется во входной pipe — ровно то, что делает xterm.js в проде.
- **EOF после drop master и ordering проверяются по-настоящему.** `read_to_end` в отдельном потоке завершается только на EOF; `recv_timeout(30s)` ловит зависание; asserts: ровно 1000 строк `exit-order-*`, границы 0/999, один маркер `===EXIT===` и его позиция после последнего output (`rfind`). Потерю bytes и перестановку тест бы поймал.
- **Существенный пропущенный сценарий — ровно Б-1:** grandchild, удерживающий консоль/pipe после exit child (fixture ниже), плюс burst больше pipe buffer при backpressured reader. Текущий fixture — ~20 КиБ и мгновенный exit, самый простой путь. Дополнительно: тест проверяет семантику portable-pty (drop→EOF), а **не** композицию продакшн-пайплайна (waiter→drop→drain→`pty-exit` последним) — на Windows эта композиция end-to-end не прогнана; ALT smoke закрывает только Linux.
- **Минор (не блокер):** первый `read_exact` handshake не имеет таймаута — при изменении поведения ConPTY тест повиснет навсегда, а не упадёт. Стоит добавить bounded read.

## 4. H-2/H-3 — leading-edge state machines

- **Потеря bytes:** нет. `receive_ready`/`receive_timed` выходят только по Disconnect (mpsc гарантирует выдачу всех queued items до ошибки) или по Timeout при пустой очереди; `try_recv Empty` просто завершает текущий batch — оставшиеся chunks обработает следующая итерация.
- **FIFO:** один consumer, `forward(&batch)` синхронно; `run_output_pipeline` эмитит exit строго после последнего batch. Нарушений нет.
- **Starvation trailing batch:** нет. Batch принудительно завершается по `PTY_OUTPUT_BATCH_LIMIT`; окно 5 ms верхне ограничено.
- **Лишние timers (frontend):** нет. Инвариант «ровно один live timer»: leading путь — `scheduleWindow()` после immediate write; byte-limit путь — `clearTimer → writePending → scheduleWindow`; `flush`/`dispose` чистят timer. После byte-limit flush следующий chunk идёт в pending (timer активен) — coalesce сохраняется, interleave с immediate-write невозможен (immediate только при `timer===null && length===0`).
- **Совместимость с `TerminalView.handleExit`:** `flush()` = `clearTimer + writePending` — trailing batch по-прежнему пишется перед exit line, инвариант 5 REVIEW.md сохранён.
- **Минор:** для H-2 нет прямого latency-теста (fake-time: первый batch уходит без 5 ms) — путь покрыт косвенно; рекомендую, не блокирую. Утверждение REVIEW.md о внутреннем FIFO/immediate-write xterm.js 6 независимо не проверено; собственный ordering batcher от него не зависит — рекомендую пометить как предположение или дать ссылку на источник xterm.

## 5. Достаточность regression tests и smoke

- Покрыто: Rust 68/4 suites (включая ordering-regression `output_pipeline_emits_exit_after_queued_output`), npm 23 (leading/trailing/limit/dispose), build/lint/fmt/typecheck зелёные (по REVIEW.md), ALT real-PTY E2E (500k строк + немедленный exit → exit-line последняя), Windows `conpty_smoke` (drop→EOF→ordering).
- Пробелы: (а) тест на Б-1 watchdog — обязателен вместе с фиксом; (б) Windows-композиция продакшн-пайплайна end-to-end (waiter→drop→drain→`pty-exit` последним); (в) fake-time latency-тест для H-2 — желателен; (г) первый bounded read в `conpty_smoke`.

## Новые блокеры

### Б-1 [Блокирующий] Неограниченный wait EOF: `pty-exit` может не быть показан никогда

- **Файл/символ:** `src-tauri/src/terminal.rs` — `drain_output_batches` ≈1702–1722 (выход только по disconnect), `run_output_pipeline` ≈1724–1739 (exit только после drain), `spawn_waiter` ≈1823–1878.
- **Доказательство:** drain завершается только когда reader-thread закрыл канал; reader завершается только по EOF/ошибке read. EOF на Unix наступает, только когда **все** fd slave закрыты; на ConPTY после `ClosePseudoConsole` — только когда все handles консоли/pipe закрыты. Если child OMP породил grandchild, унаследовавший console/stdout (ssh-agent, daemon, dev-server, compiler watcher), и grandchild жив — EOF не наступает никогда. Waiter уже выполнил drop writer/master и отправил exit в канал, но output-thread стоит в `drain_output_batches` вечно → `finalize_terminal_exit` не вызывается → вкладка вечно выглядит живой, `pty-exit` не эмитится, ввод пользователя встречает toast «Процесс OMP уже завершён». В прежнем коде (250 ms drain) exit показывался всегда — это **регрессия видимости exit**, введённая фиксом H-1. Критерий Main из раунда 1: «bounded watchdog допустим только как аварийный путь с явной ошибкой, без молчаливой перестановки» — bounded-пути теперь нет вовсе.
- **Воспроизводимый сценарий (Unix):** child `sh -c 'sleep 600 & printf done'` → child завершается мгновенно, grandchild `sleep` держит slave → EOF не наступает → `pty-exit` не показывается никогда. Windows-аналог: `cmd /C start /B notepad.exe & echo done` с консолью, унаследованной grandchild.
- **Решение (для RC):** bounded finalize-watchdog: после отправки exit-события ждать завершения pipeline ограниченное время (2–5 с); по таймауту финализировать принудительно с **явной ошибкой** (runtime error + пометка в exit-событии/строке в терминале «вывод обрезан: процесс-потомок удерживает консоль») — это соответствует критерию Main (аварийный путь с явной ошибкой, не молчаливая перестановка). Технически: отдельный watchdog-thread рядом с output-thread или перенос ожидания в waiter с `recv_timeout` и двумя исходами.
- **Проверка:** fixture-тест «grandchild держит консоль»: parent печатает burst и умирает, grandchild жив → `pty-exit` показан в bounded-время с явной пометкой обрезки; повторить на Unix и в `conpty_smoke`. Плюс обратный тест: без grandchild exit по-прежнему после полного drain (текущее поведение не ломается).

### Не блокирует, но зафиксировать

- М-1: первый `read_exact` handshake в `conpty_smoke.rs` без таймаута — добавить bounded read.
- М-2: нет fake-time теста, что первый Rust batch уходит без 5 ms (H-2 покрыт косвенно).
- М-3: утверждение о внутреннем поведении xterm.js 6 в REVIEW.md не проверено независимо — пометить как предположение.

## Итоговый verdict

**REJECT RC** — единственный блокер Б-1 (регрессия видимости exit при grandchild, удерживающем консоль). Всё остальное в scope раунда 2 одобряю: H-2, H-3, T-1 закрыты корректно; races attach/close/error/drop безопасны; `conpty_smoke` корректен по handshake, EOF и ordering. После добавления bounded finalize-watchdog с явной ошибкой и fixture-теста — ре-ревью только этого diff, ожидаемый verdict: APPROVE RC.
