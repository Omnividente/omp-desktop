# OMP Desktop behavior reference

[← README](../README.md#english) · [Русский](FEATURES.ru.md)

This reference describes the current source tree. Check an installed version against its [release notes](https://github.com/Omnividente/omp-desktop/releases). It does not certify installer or production-package acceptance.

Start with [installation](../README.md#installation). See also [privacy and providers](PRIVACY.md#english), [release preparation](RELEASES.md), and the [proposal register](PROPOSALS.md).


## Projects and session selection

- Project sidebar with persisted recent workspaces.

- To add projects, drop folders from the file manager onto the project sidebar. Drops outside the sidebar are ignored. **Open folder** remains available without drag and drop.

- On Home, the separate Read button beside each recent session opens its saved history without launching OMP. Resuming a session remains a separate action.

- Home distinguishes the latest session from an explicitly selected resume target. Recent-session launch actions are disabled when OMP is unavailable or another launch is pending; the independent Read action remains available.

- The last selected project is restored after a Desktop restart; an explicit `--project` takes precedence. If the launch folder is unavailable, Desktop retains the intent and offers Retry, another folder, or explicit continuation in the previous project. A background selection-save failure remains visible with its own retry action. Missing or hidden workspaces are not revived automatically, and no terminal starts without a user action.

- Overlapping project renames, additions and removals preserve every successful change; completing a background operation or import does not undo a newer project selection.

- Project paths retain their exact spelling, including valid leading or trailing whitespace; display-name normalization does not change directory identity. Empty or whitespace-only paths are rejected.


## Discovery and metadata

- Automatic discovery of standard OMP JSONL sessions. Unreadable files and unrecognized headers appear in a separate warning with paths and a retry action; other sessions remain available.

- A scan warning does not dismiss an open reader whose history is absent from the result. Removal is reconciled on the next warning-free scan, even when the warning concerns another file; loaded text is not reread automatically.

- Sidebar summaries use bounded JSONL prefix and tail regions rather than the entire history. Once dialogue presence and a fallback title are known, subsequent message and tool-result payloads are not materialized as JSON trees; title, model, and thinking events in the read regions still update the summary. Nested JSONL files in same-stem artifact directories are not listed as separate sessions.

- On resume, the runtime watcher reads at most a 2 MiB JSONL prefix and a 2 MiB tail, plus boundary and anchor bytes, without emitting historical events. New appends are read in full; an incomplete row stays buffered until completion and is emitted once. A current title at the beginning takes precedence over an older tail title.

- The full scan needed for replay protection is deferred until file replacement: a retained original-file handle is validated and read only up to its captured initial EOF. If that snapshot is no longer available, recovery uses a unique known tail boundary; without one, ambiguous history becomes a new baseline while subsequent appends continue arriving. Desktop does not rewrite or delete history for this optimization.

- Session selection and rename drafts use the JSONL path, not only `id`, so imported sessions with the same ID in different projects do not replace each other. Late background history discovery and a superseded terminal launch do not override the user's tab choice.

- Search, open, and resume existing sessions. Clearing search keeps the input focused. Selecting a search result reveals its row in the full long list and retains focus belonging to that selection without overriding a newer user action.

- Session search matches canonically equivalent Unicode (NFC) without rewriting persisted IDs, paths or titles. Recorded model intersects text search and uses the saved summary model, not every model in a dialogue. Expand all / Collapse all manage session chains; search and model filters disable these actions to preserve manual expansion.

- A new terminal starts a normal OMP session in the project session directory configured by Desktop; OMP creates the JSONL file with its first assistant response. Switch models and thinking levels before that response through OMP's live controls without restarting the process or losing the input draft. Desktop picks up the runtime record when the file appears, without sending a synthetic model request. A late refresh from an older terminal does not reset a newer user-selected session or a selection from another terminal's event.

- Handoff transitions are tracked without restarting: the current session stays at the root of an expandable group, archived predecessors are nested below it, and search preserves the full lineage. Deep chains use iterative processing rather than recursive traversals.


## Providers and models

- Primary-provider pinning is stored per session: toggling it while idle restarts the exact `--session` target with a local no-model/usage-fallback overlay and transfers the pin to the active continuation after handoff. Focus returns to the switch after restart unless the user chose another control; attaching the replacement terminal does not override that choice.

- Desktop Proxy Mode is enabled per provider in Settings: new and restarted sessions receive a local overlay that keeps fallback within the selected provider without overriding OpenAI Codex transport. OMP settings and model/provider capabilities determine WebSocket or SSE behavior. The old forced `openaiWebsockets: off` is removed from the generated overlay on the next terminal start or restart; already-running sessions are unchanged.

- The Providers screen shows individual accounts from `omp usage`, per-model-family limits, reset windows, disabled credentials, and estimated route availability. The same screen can temporarily disable any provider through `disabledProviders`, delete custom providers, and add OpenAI- or Anthropic-compatible APIs with automatic `/models` discovery. Chat Completions, Responses API, and Anthropic Messages include protocol explanations; new provider IDs are normalized to lowercase. Account identifiers are masked in the backend; API keys use Desktop's protected credential storage, are not written to `models.yml`, and are not returned in settings snapshots.

- Model discovery runs through `omp models refresh --json` when Desktop loads configuration: successful discovery repeats at most every 10 minutes, failed commands at most every 30 seconds. Refresh models and status explicitly refreshes discovery and usage with a separate 30-second cooldown; a readable cached catalog remains available after a refresh error. Refresh preserves unsaved settings and updates the session selector without Save. Thinking levels come only from OMP's catalog: Desktop does not invent capabilities or reconstruct provider errors omitted by a successful CLI response.

- Catalog stderr preserves a generic warning even with exit 0 and usable JSON, without reflecting raw diagnostics. A ModelPicker passport shows the selected catalog entry, context, output limit, declared input/reasoning and fixed/free/included/variable/unknown pricing. Missing fields remain unknown; zero rates alone do not mean free. This is metadata, not a bill or proof of the effective runtime route. ModelPicker name, status, thinking and passport share one conservative catalog identity; ambiguous bare IDs are not attributed to the first provider.

- Model search supports canonically equivalent Unicode. Comparing the selected model with the highlighted candidate shows only known catalog metadata; it neither changes the assignment nor probes provider capabilities.

- The declared-image-input checkbox intersects model search without resetting the current model or thinking. It filters the catalog's `input: image` declaration, not actual provider image compatibility.

- Settings reuses the loaded OMP snapshot for up to 10 minutes for the same runtime; simultaneous main-window and Settings loads share one request. Expiry, a runtime change, or a save without a returned snapshot triggers a new read; explicit refresh remains available. Saves submit only changed roles, while untouched assignments are preserved from the fresh OMP configuration rather than the window's older snapshot. An empty selector clears only the specified role assignment.

- Settings → Models separates primary roles (`default`, `smol`, `slow`, `plan`), fallback chains and auxiliary roles. All 15 current builtin OMP roles and custom names from `modelRoles`, `cycleOrder` and `modelTags` are shown, even if unassigned. Model kinds are preserved: sessions select chat models, while image/tts/stt and other kinds remain available for corresponding roles. The CLI does not expose web-search capability, so OMP determines final compatibility for `web`.


## Agent definitions

- The agents subsection shows actual `reviewer`, `security-reviewer` and other definitions, their source, definition selectors, delegation availability and model override. Agent types are distinct from `modelRoles`: changes use `task.disabledAgents` and `task.agentModelOverrides`. Clearing an override restores inheritance; ordinary Save preserves ordered selector arrays. Enabling an agent allows delegation rather than invoking a reviewer after every response. Only changed fields with expected baselines are saved; other-agent updates survive, while same-agent conflicts require rereading settings.

- An agent definition passport shows observed tools/spawns/thinkingLevel/output/blocking/structured, observation time and separately revealed discovery context. It distinguishes absent/null/empty/unsupported/truncated; output describes shape, not schema contents. A declaration is not effective session permissions, prompts are not forwarded, and opening help does not modify drafts.

- Agent writes read only the global layer through `config list --scope global --json`; project and temporary overrides are not copied into user configuration. A CLI with verifiable scope support is required (OMP 18.13.3+); older CLIs report an agent-write error without blocking unrelated settings. If a project shadows the saved edit, Desktop reports it and rolls back the transaction-owned write.

- Agent discovery covers the public bundled export, the OMP user agents directory, nearest `.omp/agents` for Desktop's last workspace and accessible absolute `extensions` roots. Relative extensions, installed/marketplace plugins and transient session definitions are not exhaustively enumerated; this limit is explained as help in the agents section rather than an OMP status warning. Actual catalog read failures remain warnings. A `configured` row represents saved settings without a known definition, and the runtime ultimately resolves inheritance in session cwd. Catalog refresh adds newly discovered rows without discarding drafts.

- Agent search filters the loaded catalog by name, description, and source without changing assignments or delegation flags.


## Import, copy and deletion

- Idempotent OMP and Codex JSONL import with skip, update, and copy modes: JSONL is capped at 256 MiB; related artifacts are copied transactionally without links and capped at 512 MiB, 10,000 entries, and 16 directory levels. After a partial Codex import, successful items are deselected so a retry includes only failed items. Failure reasons remain in the dialog with 20 files per page; an active-session refusal includes a localized explanation while preserving the original diagnostic. An interrupted JSONL/artifact update is recovered on the next session scan. Large Codex lists render only visible rows without limiting session selection.

- Codex discovery honors `CODEX_HOME`. Search over loaded titles, projects, models, and previews retains hidden selections and reports their count; the list is virtualized. The target project is visible before confirmation and captured for the submitted batch.

- Saved-session deletion coordinates JSONL, artifacts, and settings pins through a transaction journal. A pre-commit error preserves original data; recovery after process interruption completes a consistent rollback or commit rather than reporting partial history loss as success.

- Individual Codex file selection is locked while an import batch is pending, alongside the other controls. Selection becomes available after a failure; a late click cannot suggest that a file joined the already submitted batch.

- The copy action on a saved session row copies history and attachments into a chosen project through the existing importer. The original is retained and no session starts automatically. Only skip and new-copy modes are available, not history overwrite; the action is unavailable for a running session.

- Session copy accepts a known project or the system folder picker and writes only after explicit confirmation. Invalid UTF-8 is rejected before creating a result, without lossy conversion. A post-write list refresh failure preserves known per-item outcomes with a separate warning rather than inviting a blind repeat of a confirmed success.


## History and completed answers

- Selecting or creating a terminal tab reveals its header horizontally. A new explicit request for the same tab also reveals it; ordinary updates preserve manual strip scrolling and do not scroll ancestor panels.

- Large transcripts use bounded reads: the UI shows the beginning and latest entries and explicitly marks the omitted middle. Malformed records in the read portion and an incomplete final line are reported separately; reading never changes the source file.

- After an answer finishes, a collapsed panel appears above the terminal: Show answer reveals Markdown, tables and code blocks, with code-block copy, whole-message text/Markdown copy, previous-answer navigation and collapse controls. New and restored answers do not force expansion. Expanding focuses the answer body, Escape collapses the panel, and focus returns to the active terminal. When the fill-pane option is enabled in settings, an expanded answer fills the pane and hides the terminal below it until collapsed. The full terminal is shown while the next request runs; its process, input and draft stay intact. The panel reads persisted answers from the current session's JSONL rather than parsing terminal output, and excludes tool calls, reasoning and aborted answers. Saved answers are available again when the session is resumed after a Desktop restart.

- Latest loaded answer jumps to the end of the current completed-answer snapshot and expands the panel. It does not reread the file, acknowledge reading or promise the last answer of a live branch.

- Completed-answer reads validate JSON without materializing user messages, tool results or service records as JSON trees. Unrelated window updates do not rerender an unchanged answer's Markdown; switching tabs preserves the selected answer, collapse state and panel scroll position.

- Read above the current terminal opens the latest saved messages in Dialogue only mode without stopping OMP or changing the input draft. This is a JSONL snapshot: new records appear after Reread file, without sending a model request.

- Transcripts render Markdown headings, lists, quotes, tables and separate code blocks. Copy block preserves its text, indentation and blank lines without fences; messages offer visible-text and original-Markdown copy actions. Source view and latest-message navigation are available. HTML stays literal, remote images are not loaded automatically, and links use Desktop's guarded actions.

- Code-fence handling matches the installed Markdown lexer: a tab-suffixed fence remains in the body when the lexer does not recognize it as a close. The following text remains available for display, search and code-block copy.

- Transcript search scans all loaded visible text in the selected mode, not just onscreen rows: `Ctrl+F`, an occurrence counter, next/previous navigation and highlights across Markdown formatting and link labels. Queries are literal and Unicode case-insensitive; occurrence counts and navigation are not capped. A compact index stores UTF-16 offsets. Each mounted entry materializes at most 512 highlight ranges, centered around the current match in its entry; each entry renders at most 512 `mark` elements, including match fragments across Markdown nodes. The current match retains a highlight anchor; full text and copying are never truncated. `Escape` clears a nonempty query without closing the reader; with an empty query it closes the reader. The middle omitted by bounded file reads is not searched.

- Aa optionally makes transcript search case-sensitive; case-insensitive matching remains the default. Session details describe the loaded snapshot rather than live OMP. Jump to one of the first 100 loaded user messages, or copy the loaded dialogue as Markdown independently of search/display filters. Copy is bounded to 4 Mi UTF-16 code units, refuses overflow rather than silently truncating, and is not a complete session export; inspect private data before sharing.

- Opening a transcript from the sidebar remembers the message and offset during the current Desktop run; sessions keep independent positions and nothing is written to JSONL. Rereading preserves the position, and switching source/formatted views keeps the current message. `Tab` focuses the transcript viewport for arrows, `PageUp` / `PageDown`, `Home`, and `End`.

- Resizing the window preserves the visible message and its intra-message offset, clamping the offset if the message becomes shorter. Both explicit Clear search buttons return focus to the search field; latest-message navigation reaches the bottom even for an oversized message and does not steal focus.


## Terminals and rendering

- Multiple concurrent terminal tabs.

- Alt+Shift+Left/Right on a header reorders its tab. Open-tab search matches title/path and explicitly focuses the selected terminal. Close successfully exited tabs selects only exit-success tabs without a model switch or input recovery. Running/failed/unknown tabs remain. Closed terminal output is discarded, including utility output not stored in JSONL; saved session history is retained.

- Open-tab search can also filter observed process state: all, running or exited. The filter intersects title/path search without stopping, restarting or automatically selecting terminals.

- Closing the final terminal tab restores lost focus to Home's New session action, to Open folder when no workspace is selected, or to another enabled Home action when launching is unavailable. Restoration requires focus to have belonged to the removed interface; canceled closes and a newer focus choice outside it are respected. An initially empty workspace is not autofocused.

- The Selected project overview button to the left of the terminal tabs opens Home without closing terminals. Selecting a tab or resuming a session returns to the terminal; overview navigation is disabled during launch and Desktop update installation.

- A real native PTY with resize, interrupt, and reliable process cleanup. Refitting after a font or tab change keeps terminal and PTY dimensions synchronized and restores focus if fitting fails. Refitting the active terminal after layout or visibility changes redraws the full viewport even when the grid dimensions are unchanged; there is no periodic redraw, buffer reset, or process restart.

- The cursor remains visible but does not blink on Windows or Linux, avoiding continuous idle animation. A new display for the same PTY receives complete retained replay; redelivery of already displayed packets does not duplicate output.

- On Windows, Desktop maintains legacy VT input for ConPTY: an isolated helper disables Win32 input mode `9001` before each input write, including after the runtime re-enables it. Arrow keys, `Delete`, and mouse cursor movement are not split into a standalone `Escape` and literal ANSI tails. User input bytes are forwarded unchanged; OMP files are not patched. Closing the PTY stops its helper.

- On Linux, the active visible terminal attempts to use xterm's WebGL2 renderer; an unavailable or lost context falls back to the built-in DOM renderer on the same terminal, preserving the PTY, buffer, input, and selection. Inactive or hidden tabs release their WebGL context. Another attempt is allowed after a size, font, display-scale, or hide/show change, not on new output. Cursor blinking and smooth-scroll animation are disabled. Live output is coalesced into 50 ms windows without dropping bytes or reordering ANSI sequences; the first chunk after idle, a pending 256 KiB batch, and process exit flush immediately. This limits ordinary stream writes to approximately 20 per second without slowing OMP execution or input delivery. Layout changes do not recreate the terminal, clear its buffer, or restart its PTY. The application does not change drivers or CPU power limits. Windows rendering is unchanged.

- During fitting after a WebGL grid, font, or display-scale change, Linux recreates only the GPU surface at the final size. The terminal remains visible across completed-answer show/hide changes and the next request in the same tab; the terminal, PTY, buffer, and input are preserved. Ordinary output does not recreate the renderer.

- On Linux, simple WebGL ASCII rows are processed directly with a glyph cache for 64 `(bg, fg, ext)` tuples; Unicode, combined characters, extended attributes, cursor rows, selection, decorations, and character joiners retain their corresponding normal xterm paths. The fallback DOM renderer does not regenerate unchanged rows: it compares exact cell data and cursor/link state, and preserves equal DOM nodes in changed rows. Characters, colors, cursor, selection, theme, font, and link underlines continue to update. A frame-rate cap does not substitute for processing output. The build pins xterm 6.0.0 and addon-webgl 0.19.0 and checks update and cache-invalidation sites so a dependency change cannot silently disable the optimization.

- Reassigning the same WebGL atlas with identical canvas pages preserves uploaded textures. Changed pages or page versions still update textures; a new GPU renderer after context loss uploads them again.

- On Linux, Settings does not blur the terminal behind it; rotating indicators and refresh buttons, the moving progress bar, and shimmer placeholders are disabled. Loading status, warnings, data, and refresh controls remain available without continuous animation.


## Settings and recovery

- Configurable OMP executable, session root, models, language, and fonts. Settings → General → Interface text scale enlarges application text from 100% to 200%, persists across restarts, and does not change the independent terminal font size. Settings → General also offers the «Expand completed answers to fill the pane» option, which is off by default.

- Every integer terminal font size from 8–32 px is selectable. Settings categories support Up/Down, Home/End and one tab stop. Prefers-reduced-motion disables subsequent xterm smooth scrolling without recreating the terminal; Linux still uses zero duration.

- Desktop chrome has an independent theme preference: Dark by default, Light, or System. It applies only after a successful Save, persists across process restarts, and does not change ANSI, truecolor, or the OMP terminal theme.

- Save acknowledges the submitted snapshot; edits made while the request runs remain available for the next save. Escape, the close button and backdrop require confirmation for unsaved settings and cannot dismiss a pending Save. Cancel remains an intentional exit without cancelling an already submitted write; its late successful completion produces a separate notice.

- Settings, transcripts and OMP/Codex import dialogs contain keyboard focus: `Tab` / `Shift+Tab` cycle through available controls, `Escape` respects nested controls, and closing restores focus to the available opener. While a native select has focus, `Escape` does not close the dialog, even when its popup is already closed: first `Tab` to a different control type or use the close button. An import cannot be dismissed while it is running.

- Opening the model picker focuses search immediately. `Enter` in search selects the highlighted model; arrow keys enter the options. Background settings updates retain the active model by selector instead of resetting keyboard navigation. Model selection, `Escape`, and Done return focus to the trigger. Moving to another control is respected, and supported thinking modifiers are preserved.

- Settings → General includes a keyboard shortcut reference with each action's scope; it does not rebind OMP keys.

- Deleting a session from its focused action returns focus to the list, even when it becomes empty, without stealing focus from another control the user chose. Codex import disables Select all for empty lists, during loading and during an import.

- When renaming a session, `Enter` saves the title and `Escape` discards the draft; successful completion or cancellation restores focus to the row. If the row subsequently leaves the search results, focus moves to the accessible list. A failed write retains the draft for retry, and late completion does not dismiss a newer editor. Ordinary blur saves without stealing the user's chosen focus.

- `Enter` while renaming a workspace saves the name and `Escape` discards the draft; completion of an editor-owned action restores an available workspace action. Ordinary blur saves without stealing focus; failed writes retain the draft, and late completion does not dismiss a newer editor.

- While WebView marks an IME composition, Enter/Escape in a project or session rename editor do not commit or discard the draft. Ordinary keys after composition and blur retain their existing contract. This is not a complete terminal IME/editor protocol.

- Initial OMP configuration failures appear in the main window with a retry action. Saving settings invalidates older configuration responses in both the main window and Settings; if the save returns no OMP snapshot, both views request a fresh one. Ordinary Save errors remain visible in the main window, including late failures after Settings closes. Structured settings-unavailable failures use the single recovery screen without queuing a duplicate notification after a successful Retry. Desktop settings recovery can open the settings folder even when `settings.json` itself is inaccessible.

- Errors from Open folder, Retry, and starting with defaults appear inside the recovery card. The original reason remains visible and actions can be retried; a generic failure does not dismiss recovery.

- Partial recovery of malformed settings preserves the chosen language and a backup of the original file without extracting secret values from damaged JSON.

- Removing the last stored credential leaves an authoritative empty snapshot: an old fallback does not restore it after restart. Partial native-store failures retain the desired-state journal for reconciliation; CLI errors and snapshot warnings receive backend masking of known secrets. Recognized secret assignments are redacted with spaces or tabs before `:` / `=`; ordinary token counters remain visible.

- Saving only language, fonts, or the Desktop theme neither reloads the OMP catalog nor mutates credentials. An explicitly selected OMP executable is authoritative: an unavailable path reports an error instead of silently launching another installation.

- If OMP is unavailable, Settings shows up to five localized version-probe reasons: source category and failure type, without raw stderr, environment values, or internal paths from the error. This limit does not truncate installation search; successful discovery clears previous failures.

- The interface supports Russian, English, and Simplified Chinese. The document language follows the saved Desktop preference; Settings and its discard confirmation follow the local draft. Cancel and a failed Save do not relabel the main interface.

- OMP operation exposes numeric, boolean and enum settings supported by the installed runtime: search, categories, changed-only filtering and reset to the OMP schema default. Saving checks conflicts; project settings retain precedence and running processes are not restarted.


## Resources and diagnostics

- The resource monitor reports available RAM, swap pressure, free space for sessions, the workspace and temporary files, plus RSS for Desktop and direct OMP processes. A project change or visibility return during a sample queues one catch-up for the current state; periodic ticks do not accumulate a backlog. It never terminates processes or deletes data automatically.

- For a matching PID of a running tab, resource rows add its current title and cwd without changing RSS or sample time. This is UI context, not stronger process identity, PID-reuse protection or descendant-tree accounting.

- Resource monitoring offers explicit refresh and navigation to a running tab; navigation rechecks both terminalId and PID against the current tab.

- Incident-kind and Unicode text search intersect the other filters without changing stored records or global counts. Eviction preserves the final active fallback of each independent role while the bound can retain those roles.

- In the Runtime Incident Center, Save raw output writes the retained PTY window to a new private `logs/captures/<capture>/` directory containing `output.bin` and `metadata.json`. Concurrent saves do not overwrite previous captures; a failed write removes only its own incomplete result, displays the cause, and permits a retry.

- Incident filtering uses exact terminalId intersected with Active/Resolved/All; counters and Clear all resolved remain global. Capture boundaries and a secrets warning appear before saving; truncated captures show the number of dropped bytes.

- Raw capture is bounded to a 2 MiB window, not the entire session history. Metadata records the timestamp, byte count, sequence boundaries, and dropped bytes. Binary output is not stripped of ANSI or secrets: inspect and redact it before sharing. Directories and files follow Desktop's existing private-access policy: Unix `0700`/`0600` and protected Windows ACLs.

- An unavailable path does not abort other resource measurements: the panel shows a partial result with the path and reason. The next sample clears the warning after recovery; missing paths are never replaced by an ancestor disk. An error without a snapshot displays a warning rather than a successful check.


## Navigation, links and keyboard

- The project sidebar has persisted expanded, compact and auto-hide modes (`Ctrl+B`). Auto-hide and global shortcuts do not interfere with import or transcript dialogs; after removing a workspace, lost focus returns to Open folder without stealing focus from another control the user selected.

- The first keyboard navigation link, Skip to workspace, focuses the main landmark, including Home without terminals. It does not select a session or move focus outside a modal or startup-recovery guard.

- The expanded project rail supports name/path search and local Default/Name ordering with natural numeric comparison. Search does not select a project, and a nonempty query reveals full paths. Ordering is not persisted between launches. Home can explicitly copy the selected project path verbatim without normalization.

- Full Unicode session titles are available on hover and keyboard focus. A new session title updates in the tab and session list together; until OMP generates one, the first user message provides the fallback. Selected terminal text can be added to the current input as an explicit quote via Reply or the right mouse button, while sending remains under user control. `Ctrl+A` visibly arms the current OMP input for clearing; mouse movement is limited to safely recognized wrapped lines.

- Dates in lists and recent sessions use the current local timezone, including a timezone change while Desktop is running. Calendar dates include the year; relative-time thresholds are unchanged.

- Links in the terminal and transcript use system applications: web URLs open in the browser, while supported project documents and `file://` / `local://` / `artifact://` targets open in their associated application. The context menu can separately reveal a file in its folder; programs, scripts and unknown types are revealed but never launched. Read selectors, spaces, Cyrillic paths and session headers after a title slot are supported. Selected text has a Copy menu action, alongside Reply in terminals.

- `Tab` / `Shift+Tab` from a context-menu item restore the transcript or terminal focus without forwarding that Tab to the PTY. If focus remains outside the menu, its normal Tab handling is preserved.

- Opening a terminal link or folder ends the mouse gesture on button release: moving the pointer after a click does not continue selecting text. Deliberately selecting link text does not follow the link.

- In the current OMP input, `Ctrl+Z` uses the logical Latin key, including AZERTY/QWERTZ; non-Latin layouts retain the physical Z fallback and AltGr is left untouched. `Ctrl+Backspace` / `Ctrl+Delete` delete a word, `Shift+Enter` adds a line, and `Ctrl+Enter` submits a follow-up. `Ctrl+C` copies selected text or interrupts when nothing is selected; `Ctrl+V` uses OMP's native clipboard handling, including images, while `Ctrl+Shift+V` pastes uncollapsed text. `Ctrl+Y` retains OMP yank semantics rather than redo; ordinary interface fields keep standard WebView shortcuts.

- In agent tabs, non-composing Backspace/Delete keydown with an xterm screen selection is consumed instead of calculating deletion from screen cells. Selection remains available for Copy/Reply; ordinary typing and Ctrl+A then Backspace without a selection retain existing behavior. This is a narrow guard, not an OMP semantic editor or a general IME guarantee.


## Session ownership and launch

- Cross-process ownership of session JSONL uses an OS lease: active resume/discovered/delete/import operations hold the lock through Update-import atomic replacement and transaction recovery. An active session is not overwritten; first-path publication agrees with the lease and UI tab. Stale metadata requires explicit reclaim. Crash remnants are retained in bounded quarantine; silent automatic takeover is not performed.

- A second launch with `--project <path>`, `-p <path>`, or a positional path forwards the workspace to the existing window and restores its focus. Relative paths resolve against the second process's working directory, not the first window's. Ambiguous Windows paths relative to another drive (for example, `C:repo` when launched from `D:`) are explicitly rejected: supply an absolute path instead.

- The `--` delimiter ends project-flag parsing: the next argument is a literal path, even if it looks like `--project=repo`. Explicit flags before the delimiter retain their precedence.


## Update channels

- Desktop offers stable releases by default. Settings → General → Offer prerelease versions includes prereleases only after Save; Cancel discards the draft, and the saved choice survives restart. Turning it off neither downgrades an already installed newer version nor installs anything automatically.

- GitHub's `prerelease` flag determines the channel, not a SemVer suffix: plain `0.9.11` can be a prerelease. The native updater selects the highest strictly newer compatible release with a complete inventory, matching manifest and authenticated signature metadata. Prereleases are labeled in the notice and a separate pre-install confirmation.

- Changing channels immediately retires the old offer; late old-channel responses cannot restore it or block a fresh check. An unknown Save outcome blocks installation until the persisted channel is read back, without automatically repeating Save, downloading or installing.

- Clicking the Desktop version starts a manual update check. OMP and Desktop update notices share a non-overlapping stack; background update offers do not cover modal controls. Installation with running terminals requires confirmation before downloading; cancellation leaves them running. New terminal launches and provider-pin restarts are blocked during confirmation and installation. Installation cannot start while a terminal launch or restart is pending; cancellation and installation failure release the gate.

- If the SDK confirmed installation but a relaunch call returning to the app failed, the next explicit retry performs relaunch only, without downloading or installing again; active-terminal confirmation is checked again. State lives in the current native process, not a durable installation journal. On Windows the SDK exits after launching the external installer; that transition alone is not proof of successful installation.

- One codebase and installable packages for Windows and Linux.
