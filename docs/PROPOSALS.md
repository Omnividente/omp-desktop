# Текущий реестр предложений OMP Desktop

Срез исходников: 14 ноября 2026 года, подготовка prerelease 0.9.13. Основа — stable [v0.9.12](../.github/release-notes/v0.9.12.md), `dba7f41a77c4b957b45527a591cdfdb0be5f252f`; композиция 94 исходных PR уже опубликована через [#333](https://github.com/Omnividente/omp-desktop/pull/333) в `main` `6276be9b207a6773d59175266c879a14c4a5c19f`. Последующие дополнения перечислены отдельно ниже. Это индекс **этой ревизии кода**, а не перечень возможностей установленного выпуска. Source CI, merge, release, точная native-приёмка пакетов и установка — разные этапы; фактическая доставка фиксируется отдельно в интеграционном PR и [#177](https://github.com/Omnividente/omp-desktop/issues/177).

Вместо повторения старых статусов «Draft / не принято» используется один текущий индекс. Оригинальные карточки, результаты неудачных проверок и авторство остаются в исходных PR и истории #177. Проектная интеграция Jules выведена из разработки; историческое авторство Jules не переатрибутируется Dot. Статус «в коде» относится только к принятому узкому контракту.

## Текущий индекс

92 номерные позиции: 80 реализованных в этой ревизии узких контрактов (DOT-009 только guard), 11 исследований без принятой полной реализации, один резерв DOT-066. DOT-081/#237 уже включён в базу v0.9.12 через принятую композицию #244/#252; это не новый ID и не новый merge исходного PR. После базы добавлены 12 ID DOT-080 и DOT-082–DOT-092. Дополнения к существующим DOT не создают новых ID. Подсчёт кода не подтверждает новый стабильный выпуск или установку.

| DOT | Предложение | Текущий статус | Источник |
|---|---|---|---|
| DOT-001 | Контроль очереди терминального вывода | Исследование, не принято как готовое исправление | — |
| DOT-002 | Расход ресурсов по деревьям процессов | Исследование, не принято как готовое исправление | — |
| DOT-003 | Паспорт модели и сравнение вариантов | В коде; сравнение метаданных дополнено в этой ревизии | [#180](https://github.com/Omnividente/omp-desktop/pull/180), [#270](https://github.com/Omnividente/omp-desktop/pull/270) |
| DOT-004 | Паспорт определения агента | В коде | [#182](https://github.com/Omnividente/omp-desktop/pull/182) |
| DOT-005 | Подтверждаемое завершение терминала | Исследование, не принято как готовое исправление | — |
| DOT-006 | Явный итог сохранения настроек | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-007 | Сохранение найденной сессии в поле зрения | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-008 | Логический Ctrl Z в терминале агента | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-009 | Безопасные единицы удаления выделения | В коде только fail-closed guard | [#184](https://github.com/Omnividente/omp-desktop/pull/184) |
| DOT-010 | Явный проект при холодном запуске | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-011 | Копия сессии в выбранном проекте | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-012 | Сохранность поздних правок настроек | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-013 | Видимые ошибки действий восстановления | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-014 | Повтор сохранения выбранного проекта | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-015 | Повтор замера ресурсов после занятого запроса | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-016 | Дата сессии после смены часового пояса | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178); дополнение [#224](https://github.com/Omnividente/omp-desktop/pull/224) |
| DOT-017 | Причины неудачного импорта Codex | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-018 | Сохранение настройки агента без переноса настроек проекта | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-019 | Видимость активной вкладки терминала | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-020 | Отметка непросмотренного ответа фоновой сессии | Исследование, не принято как готовое исправление | — |
| DOT-021 | Предупреждение перед закрытием приложения с работающими сессиями | Исследование, не принято как готовое исправление | — |
| DOT-022 | Стабильность выбора модели с клавиатуры | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-023 | Защита несохранённых настроек от случайного закрытия | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-024 | Не пересчитывать весь список сессий при обычной прокрутке | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-025 | Объяснять недоступность OMP при проверке запуска | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-026 | Маскирование секретных присваиваний с пробелами перед разделителем | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-027 | Точная папка проекта при пробелах в имени | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-028 | Раздельная идентичность POSIX путей с обратной косой чертой | Исследование, не принято как готовое исправление | — |
| DOT-029 | Понятные причины отказа импорта на выбранном языке | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-030 | Стабильность выделенного вывода при изменении ширины терминала | Исследование, не принято как готовое исправление | — |
| DOT-031 | Возвращать фокус после Enter при переименовании проекта | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-032 | Светлая тёмная и системная тема интерфейса Desktop | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-033 | Язык документа и черновика настроек | В коде | [#178](https://github.com/Omnividente/omp-desktop/pull/178) |
| DOT-034 | Сохранение итогов импорта при ошибке обновления | В коде | [#181](https://github.com/Omnividente/omp-desktop/pull/181) |
| DOT-035 | Границы и приватность терминального capture | В коде | [#183](https://github.com/Omnividente/omp-desktop/pull/183) |
| DOT-036 | Учёт предпочтения уменьшенного движения в терминале | В коде | [#185](https://github.com/Omnividente/omp-desktop/pull/185) |
| DOT-037 | Сообщение об ошибке подтверждения удаления проекта | В коде | [#186](https://github.com/Omnividente/omp-desktop/pull/186) |
| DOT-038 | Полный диапазон размера шрифта терминала | В коде | [#187](https://github.com/Omnividente/omp-desktop/pull/187) |
| DOT-039 | Канонически эквивалентные названия в поиске | В коде | [#191](https://github.com/Omnividente/omp-desktop/pull/191) |
| DOT-040 | Точная диагностика ожидания вывода PTY | В коде | [#192](https://github.com/Omnividente/omp-desktop/pull/192) |
| DOT-041 | Сохранение настроек при перекрытии переменными окружения | Исследование, не принято как готовое исправление | — |
| DOT-042 | Предупреждение о неполном обнаружении расширений runtime | В коде | [#193](https://github.com/Omnividente/omp-desktop/pull/193) |
| DOT-043 | Отказ импорта файлов с недопустимой кодировкой UTF 8 | В коде | [#194](https://github.com/Omnividente/omp-desktop/pull/194) |
| DOT-044 | Группировка моделей провайдера с именем constructor | В коде | [#195](https://github.com/Omnividente/omp-desktop/pull/195) |
| DOT-045 | Актуальность предложения обновить OMP после внешнего обновления | Исследование, не принято как готовое исправление | — |
| DOT-046 | Фильтр истории по записанной модели | В коде | [#196](https://github.com/Omnividente/omp-desktop/pull/196) |
| DOT-047 | Локальный поиск проектов по имени и пути | В коде | [#197](https://github.com/Omnividente/omp-desktop/pull/197) |
| DOT-048 | Безопасная сводка ShellTrace только для чтения | Исследование, не принято как готовое исправление | — |
| DOT-049 | Переход к сообщению пользователя в истории | В коде | [#198](https://github.com/Omnividente/omp-desktop/pull/198) |
| DOT-050 | Каталог skills только для чтения | Исследование, не принято как готовое исправление | — |
| DOT-051 | Перестановка вкладок терминала с клавиатуры | В коде | [#199](https://github.com/Omnividente/omp-desktop/pull/199) |
| DOT-052 | Просмотр истории недавней сессии с главной | В коде | [#200](https://github.com/Omnividente/omp-desktop/pull/200) |
| DOT-053 | Клавиатурная навигация разделов Settings | В коде | [#201](https://github.com/Omnividente/omp-desktop/pull/201) |
| DOT-054 | Поиск модели в управлении сессией | В коде | [#202](https://github.com/Omnividente/omp-desktop/pull/202) |
| DOT-055 | Копирование загруженного диалога в Markdown | В коде | [#203](https://github.com/Omnividente/omp-desktop/pull/203) |
| DOT-056 | Раскрытие и сворачивание всех групп сессий | В коде | [#204](https://github.com/Omnividente/omp-desktop/pull/204) |
| DOT-057 | Поиск открытых терминальных вкладок | В коде | [#205](https://github.com/Omnividente/omp-desktop/pull/205); дополнение [#225](https://github.com/Omnividente/omp-desktop/pull/225) |
| DOT-058 | Сортировка известных проектов по имени | В коде | [#206](https://github.com/Omnividente/omp-desktop/pull/206) |
| DOT-059 | Выбор известного проекта для копии сессии | В коде | [#207](https://github.com/Omnividente/omp-desktop/pull/207) |
| DOT-060 | Название вкладки рядом с RSS | В коде | [#208](https://github.com/Omnividente/omp-desktop/pull/208) |
| DOT-061 | Учёт регистра при поиске в диалоге | В коде | [#209](https://github.com/Omnividente/omp-desktop/pull/209) |
| DOT-062 | Обзор проекта при открытых терминалах | В коде | [#210](https://github.com/Omnividente/omp-desktop/pull/210) |
| DOT-063 | Сведения о загруженной сессии | В коде | [#211](https://github.com/Omnividente/omp-desktop/pull/211) |
| DOT-064 | Фильтр инцидентов по терминалу | В коде | [#212](https://github.com/Omnividente/omp-desktop/pull/212) |
| DOT-065 | Закрытие успешно завершённых вкладок | В коде | [#213](https://github.com/Omnividente/omp-desktop/pull/213) |
| DOT-066 | Зарезервировано | Резерв, карточки нет | — |
| DOT-067 | Копирование пути проекта | В коде | [#214](https://github.com/Omnividente/omp-desktop/pull/214) |
| DOT-068 | Переход клавиатурой к рабочей области | В коде | [#215](https://github.com/Omnividente/omp-desktop/pull/215) |
| DOT-069 | Повтор перезапуска после установки | В коде | [#216](https://github.com/Omnividente/omp-desktop/pull/216) |
| DOT-070 | Переименование сессии при IME-вводе | В коде | [#218](https://github.com/Omnividente/omp-desktop/pull/218) |
| DOT-071 | К последнему загруженному ответу | В коде | [#219](https://github.com/Omnividente/omp-desktop/pull/219) |
| DOT-072 | Фильтр Resolved в Incident Center | В коде | [#220](https://github.com/Omnividente/omp-desktop/pull/220) |
| DOT-073 | Модели с заявленным вводом изображений | В коде | [#221](https://github.com/Omnividente/omp-desktop/pull/221) |
| DOT-074 | Блокировка выбора файлов во время импорта | В коде | [#222](https://github.com/Omnividente/omp-desktop/pull/222) |
| DOT-075 | Точное название выбранного продолжения на Home | В коде | [#223](https://github.com/Omnividente/omp-desktop/pull/223) |
| DOT-076 | IME при переименовании проекта | В коде | [#226](https://github.com/Omnividente/omp-desktop/pull/226) |
| DOT-077 | Недоступное возобновление на Home | В коде | [#227](https://github.com/Omnividente/omp-desktop/pull/227) |
| DOT-078 | Markdown после fence с табуляцией | В коде | [#228](https://github.com/Omnividente/omp-desktop/pull/228) |
| DOT-079 | Каноническая идентичность выбранной модели сессии | В коде базы v0.9.12 | [#229](https://github.com/Omnividente/omp-desktop/pull/229) |
| DOT-080 | Фокус после закрытия фоновой вкладки | В коде этой ревизии | [#234](https://github.com/Omnividente/omp-desktop/pull/234) |
| DOT-081 | Метаданные владельца при прерванном reclaim | В коде базы v0.9.12 | [#237](https://github.com/Omnividente/omp-desktop/pull/237), [#244](https://github.com/Omnividente/omp-desktop/pull/244) |
| DOT-082 | Отмена устаревших hover-таймеров панели | В коде этой ревизии | [#240](https://github.com/Omnividente/omp-desktop/pull/240) |
| DOT-083 | Клавиши меню во время IME-композиции | В коде этой ревизии | [#241](https://github.com/Omnividente/omp-desktop/pull/241) |
| DOT-084 | Фильтр инцидентов по типу | В коде этой ревизии | [#272](https://github.com/Omnividente/omp-desktop/pull/272) |
| DOT-085 | Поиск определений агентов | В коде этой ревизии | [#273](https://github.com/Omnividente/omp-desktop/pull/273) |
| DOT-086 | Поиск сохранённого диагностического текста | В коде этой ревизии | [#285](https://github.com/Omnividente/omp-desktop/pull/285) |
| DOT-087 | Поиск обнаруженных сессий Codex | В коде этой ревизии | [#286](https://github.com/Omnividente/omp-desktop/pull/286) |
| DOT-088 | Escape закрывает раскрытый заголовок сессии | В коде этой ревизии | [#287](https://github.com/Omnividente/omp-desktop/pull/287) |
| DOT-089 | CODEX_HOME при обнаружении сессий | В коде этой ревизии | [#296](https://github.com/Omnividente/omp-desktop/pull/296) |
| DOT-090 | Исходный текст после сбоя Markdown | В коде этой ревизии | [#297](https://github.com/Omnividente/omp-desktop/pull/297) |
| DOT-091 | Справка по сочетаниям и областям действия | В коде этой ревизии | [#299](https://github.com/Omnividente/omp-desktop/pull/299) |
| DOT-092 | Целевой проект перед подтверждением импорта | В коде этой ревизии | [#304](https://github.com/Omnividente/omp-desktop/pull/304) |

## Дополнения к кандидату 0.9.13

Без новых DOT-номеров и без повторного объявления уже доставленной композиции:

- [#335](https://github.com/Omnividente/omp-desktop/pull/335), Dot/Yuri Kotov, original `5f55eb4fa8064194fc3e73399fa51d43283b2d53`: одна декларация `.shortcut-hint`, существующий secondary-text token вместо низкоконтрастного тёмного fallback. Светлая тема, геометрия и шрифт не меняются. Исходная fragment-проверка не переименовывается в native или общую accessibility-сертификацию.
- [#251](https://github.com/Omnividente/omp-desktop/pull/251), `mfkeeq199458`, original `d8d453bb2ba90768636eb581405e7a2134789984`: адаптирован только default collapse новых и восстановленных completed answers. Живая консоль остаётся видимой, существующее скрытие панели при busy сохраняется. Не приняты fullscreen/display:none, пустой busy-toolbar, новые Escape/focus hooks или скрытие PTY.

Native GUI/PTY и проверки точных release assets относятся только к реально выполненным сценариям, перечисленным в интеграционном отчёте. Готовность исходников сама по себе их не подтверждает.

## Исследования: следующий проверяемый результат

Оставлены намеренно, не обещаются как готовые исправления. Сначала стоит разбирать DOT-041 и DOT-045. Нет разрешения автоматически переписывать scanner, terminal protocol или мигрировать пользовательские ключи.

| DOT | Следующий результат до реализации |
|---|---|
| DOT-001 | Сначала полный native output/backpressure stress: byte preservation, mount/replay/exit, 1/4/12 вкладок. Не ограничивать пакет вместо in-flight bytes. |
| DOT-002 | Ограниченный полный process-tree снимок, discovery/стоимость и PID-start identity с явными unknown; direct-RSS UI не заменяет это. |
| DOT-005 | Native stop acknowledgement, late exit/failed kill/unknown outcome и generation guard; не считать IPC Ok завершением. |
| DOT-020 | Настоящие source/generation/read-ack semantics для фонового ответа; новая навигация к загруженному ответу это не закрывает. |
| DOT-021 | Native close lifecycle с живыми/запускаемыми сессиями и безопасным подтверждением; success-only cleanup не замена. |
| DOT-028 | Совместимость legacy persisted path keys и platform provenance до любой миграции; ничего не переносить эвристически. |
| DOT-030 | Native reflow UX и согласованные copy/selection states до выбора preservation/invalidation. |
| DOT-041 | Разделить saved/effective/provenance; защищённый global readback и no-op/reset/stale/rollback, не ослаблять проверку. |
| DOT-045 | Verified no-update/unknown classifier, runtime identity и request generation; не очищать PTY notice по одному false. |
| DOT-048 | Проверить реальный saved-file → bounded Rust projection → IPC/UI; не выдавать argv/env/output/script и не доверять offsets после truncation. |
| DOT-050 | Доказать isolated filesystem no-delta у чтения skills, bounded JSON/cwd/snapshot/unsupported; не добавлять checkbox записи. |

Полный Unicode/IME/editor protocol DOT-009 остаётся за границей принятого guard. Аналогично, bounded capture не доказывает backpressure DOT-001, подпись прямого PID не закрывает process-tree identity DOT-002, переход к последнему загруженному ответу не является read ACK DOT-020.

## DOT-079: отдельное включение в candidate 0.9.11

Источник — Dot, [#229](https://github.com/Omnividente/omp-desktop/pull/229), original head `5ca9315c6401b0fb84d1973f09c3638d2cb95718`. Добавлен поверх доставленного через [#230](https://github.com/Omnividente/omp-desktop/pull/230) `main` `0b781416382b4584c16a7324635ce3fdd48934d6`; он не входил в зафиксированный набор 6 ноября ниже. Фактические integration PR, проверенный head и merge записывает Main в [#177](https://github.com/Omnividente/omp-desktop/issues/177), а не выводит из этого индекса.

Узкий контракт: SessionControls и начальная metadata App сохраняют одну catalog identity и согласованный thinking. Qualified selector имеет приоритет над совпавшим raw ID другой записи; неоднозначный bare ID не получает угаданного провайдера. Literal colon и ID с окончаниями `:high`/`:off`/`:auto` не обрезаются как модификаторы; refresh каталога сам по себе не переключает модель. Это не доказательство реального provider routing, inference или тарификации; такие пользовательские инциденты исходным исследованием не установлены.

Происхождение DOT-003/[#180](https://github.com/Omnividente/omp-desktop/pull/180) и identity-коррекций Main в [#217](https://github.com/Omnividente/omp-desktop/pull/217), DOT-054/[#202](https://github.com/Omnividente/omp-desktop/pull/202), исходных switching/off/auto-контрактов [#65](https://github.com/Omnividente/omp-desktop/pull/65)/[#71](https://github.com/Omnividente/omp-desktop/pull/71) сохранено. Паспорт и поиск не переиздаются под новым авторством. Прежние V1 failure/review и synthetic/jsdom evidence остаются в #229; они не переименовываются в native или binary proof. Native synthetic selection → Rust switch IPC/launch metadata — отдельный gate Main.

DOT-080/[#234](https://github.com/Omnividente/omp-desktop/pull/234) и обновления зависимостей [#231](https://github.com/Omnividente/omp-desktop/pull/231), [#232](https://github.com/Omnividente/omp-desktop/pull/232), [#233](https://github.com/Omnividente/omp-desktop/pull/233) остаются вне frozen-состава candidate. Их отдельные пороги из #177 не отменяются; резерв DOT-066 и 11 исследований не меняются.

## Набор приёмки 6 ноября: exact provenance

Состав зафиксирован до интеграции: 13 предложений Dot и три обновления зависимостей. Более поздние заявки требуют отдельного решения, а не молчаливого включения. История и исходные ветки не удаляются.

| Source PR | Exact original head | Изменение |
|---|---|---|
| [#179](https://github.com/Omnividente/omp-desktop/pull/179) | `5ab9a30f957c253984dc55990e0b7d2645b6e99f` | chore(deps): bump the cargo-minor-patch group across 1 directory with 7 updates |
| [#188](https://github.com/Omnividente/omp-desktop/pull/188) | `cf05001241e759fdf71b9941e6cfc799ffb2a002` | chore(deps): bump the npm-production group with 4 updates |
| [#189](https://github.com/Omnividente/omp-desktop/pull/189) | `928d0509bcf9ee4d5610a1965c63f635a8d05542` | chore(deps-dev): bump the npm-development group with 4 updates |
| [#215](https://github.com/Omnividente/omp-desktop/pull/215) | `734fdf7bbbaaa83510aed9eb0c4c6fd548e5f4ed` | feat(a11y): skip navigation to the workspace (DOT-068) |
| [#216](https://github.com/Omnividente/omp-desktop/pull/216) | `4cfe4c8284738694e898afad9edf8255eb7b6406` | fix(updater): retry relaunch without reinstalling (DOT-069) |
| [#218](https://github.com/Omnividente/omp-desktop/pull/218) | `c6d7ad511d2d905b183885f461f4d726a46083d8` | fix(sessions): keep IME keys inside the rename editor (DOT-070) |
| [#219](https://github.com/Omnividente/omp-desktop/pull/219) | `e5b0880a5421b8ebb52ef25e7123c216bc6f06d7` | feat(answers): jump to the latest loaded answer (DOT-071) |
| [#220](https://github.com/Omnividente/omp-desktop/pull/220) | `9b7ebf42c752acf753f7ebd433c40db514e0cbfc` | feat(incidents): view resolved records separately (DOT-072) |
| [#221](https://github.com/Omnividente/omp-desktop/pull/221) | `5cb8198181ab01d04d91fb5fcd70ef26e0a393cc` | feat(models): filter declared image input (DOT-073) |
| [#222](https://github.com/Omnividente/omp-desktop/pull/222) | `1224bf136b794cb26a9db3541a13baf971fb5248` | fix(import): lock file selection during pending batches (DOT-074) |
| [#223](https://github.com/Omnividente/omp-desktop/pull/223) | `3fe80f49ca13e72f24acbde0edadc49d27aa0a2a` | fix(home): label the selected resume target accurately (DOT-075) |
| [#224](https://github.com/Omnividente/omp-desktop/pull/224) | `0369b00f292adcebbfec1406229e89b8981b042f` | feat(dates): distinguish calendar years (DOT-016 follow-up) |
| [#225](https://github.com/Omnividente/omp-desktop/pull/225) | `4a922a1041c6219668f03fc02e28227da6d13907` | feat(tabs): filter by process state (DOT-057 follow-up) |
| [#226](https://github.com/Omnividente/omp-desktop/pull/226) | `922df6a34d6c7bc72320d1e9a3f8b291bedd4318` | fix(projects): keep IME keys inside the rename editor (DOT-076) |
| [#227](https://github.com/Omnividente/omp-desktop/pull/227) | `647089b0be7c5dcb327a2d6a565c6e03303af336` | fix(home): disable unavailable recent resumes (DOT-077) |
| [#228](https://github.com/Omnividente/omp-desktop/pull/228) | `26219c70a3c19942be6abef95b6fa9d394b40b5f` | fix(markdown): preserve tails after tab-suffixed fences (DOT-078) |

Содержимое оригинального head может быть адаптировано при композиции. Закрытие source PR как включённого в интеграцию не означает его отклонение или отдельный merge неизменённого head. Индивидуальные решения и фактический integration PR записываются в #177 после проверки доставки.

Обновления #179/#188/#189 объединены без несвязанных обновлений locked graph; версии приложения и Cargo.toml не менялись. [#190](https://github.com/Omnividente/omp-desktop/pull/190) закрыт: ESLint 10.13.0 конфликтует с peer dependency eslint-plugin-react 7.37.5; существующий [Quality Gate](https://github.com/Omnividente/omp-desktop/actions/runs/41404774135) падает при npm ci на обеих ОС. Не применять --force/--legacy-peer-deps. Major-ignore ESLint пересматривается после совместимого React lint plugin, проверки миграции конфигурации и успешных платформенных gates; minor/patch не заблокированы.

## Открытые issues — почему остаются

- [#133](https://github.com/Omnividente/omp-desktop/issues/133): измеримый research backlog обнаружения сессий, не принятая команда распараллеливания. Старый baseline сохранён с его ограничениями.
- [#146](https://github.com/Omnividente/omp-desktop/issues/146): контрольная запись полномочий/истории и handoff. Не закрывается ради уборки: исходный контракт придаёт закрытию эффект отзыва grant. Редакционная актуализация не меняет JSON grant, расписание или внешние процессы.
- [#177](https://github.com/Omnividente/omp-desktop/issues/177): постоянный реестр решений и exact delivery, не незавершённая задача.

## Границы проверки и выпуска

Индивидуальный зелёный CI не доказывает общую композицию. Результат общего Quality Gate/CodeQL и конкретные native smoke-сценарии публикуются в integration PR и #177. Нативный Windows/WebView2 smoke использует отдельную identity, synthetic JSONL и non-inference CLI; synthetic DOM composition events не являются физическим OS IME или AT. Реальные clipboard, system picker, provider inference и производственная установка обновления не подразумеваются.

В candidate 0.9.11 отдельно принята native identity-граница DOT-079: actual WebView2 invoke → Rust switch → PTY/JSONL acknowledgement сохраняет qualified selector при коллизии raw ID и литеральные `:high`/`:off`/`:auto`; атомарный `model_change` не разбирается как конфигурационный suffix. Fresh launch, неоднозначный bare ID и refresh проверены без provider inference. Production NSIS clean/upgrade/state и AppImage replacement/state остаются отдельными gates точных release assets; тестовый updater E2E не подменяет их. Поставленная 0.9.10 не обнаруживает отдельный non-latest prerelease через latest-only updater; этот путь не закрывается promotion или подменой trust/network.

Историческая доставка 32 предложений: [#217](https://github.com/Omnividente/omp-desktop/pull/217), `main` `7a1e2a0023bac5444454f8dc982cc329882117e9`; следующий набор доставлен через [#230](https://github.com/Omnividente/omp-desktop/pull/230), `main` `0b781416382b4584c16a7324635ce3fdd48934d6`. Текущий стабильный выпуск — [v0.9.12](https://github.com/Omnividente/omp-desktop/releases/tag/v0.9.12). Проверки локальных исходников после него не доказывают подписи, production-бинарники или обновление установленного приложения.

## Композиция после v0.9.12

Из 94 исходных PR 53 приняты, 30 использованы после доработки или в явно ограниченном контракте, 8 отложены, 3 не приняты как готовое исправление. Это решения по предложениям, не 83 отдельных remote merge. Exact original heads, авторы, provenance-коммиты, сценарии и ограничения сохраняются в истории и интеграционном отчёте; фактическая доставка в `main` и закрытие исходных PR требуют отдельной проверки GitHub. Неизвестные результаты прежних записей не повторяются.

- Навигация согласует ранний discovery, фоновые breadcrumb и явный выбор вкладки; импортированные сессии различаются по пути, а не только по `id`.
- Удаление истории, артефактов и привязок настроек переработано в восстанавливаемую транзакцию. Реальный OS denial и прерывания процесса проверены отдельно от тестов с fake killer. Исследования #324/#325 не объявлены готовыми исправлениями; #328 заменён настоящими native boundary fixtures. Найденная Win32 BOOL-ошибка исправлена в vendored зависимости приложения, обход `OS error 0 == success` удалён; исходники OMP runtime не менялись.
- #326 принят после шести release AB/BA-пар для 100, 1 000 и 10 000 сессий на Windows/Linux с проверкой полных результатов и неизменности файлов вне тайминга. Это ускорение empty-pin helper на прогретой FS, не измерение всего запуска или bootstrap.
- #330 отложен: выигрыш короткого ASCII-запроса сопровождался регрессией валидного 256-символьного miss-запроса примерно в 6,4 раза. Готовый fast-path удалён; единый Unicode RegExp-контракт и защита #275 сохранены, новые эвристические пороги не вводились.
- В композиции #333 native folder drop #250, #251 и Remote #300 не переносились. В кандидате 0.9.13 отдельно адаптирован только default collapse #251, как описано выше. #250 остаётся отдельной native OS-drop/DPI/path-identity приёмкой; #239/#300 — отдельным Remote milestone. Зелёный индивидуальный CI и частичный scaffold не считаются end-to-end доказательством.
- #329 (`985d2f39dc15a612ea155ff411b3fbfec6ee0bb7`, автор `favoritewky`) адаптирован сквозным образом: упрощённый китайский, ошибки Rust/bridge, locale-форматирование, preview, Save и cold restart. Авторство сохранено, а не переатрибутировано интегратору.
- #232 включён после свежей проверки exact head: два full-SHA pin для CodeQL обновлены с 4.39.1 до 4.39.3. Матрица Rust/JS-TS, `security-extended`, permissions и enforcement не меняются; исполнение новой action подтверждается только штатным GitHub CI интеграционного PR, не локальным билдом.
- #324 остаётся отдельной test-only характеристикой ошибки после публикации defaults. Его consumer `start_with_defaults_at_with` отличается от post-commit cleanup настроек в #323; замещение этим изменением не доказано. Инъекция ошибки после успешного writer/sync не воспроизводит отказ ОС и не проверяет native reset/committed cache.
- #325 не считается прозрачной оптимизацией: actual scanner и helpers дали контрпример при удалении файла между двумя lookup. Общий ключ требует явного решения о snapshot identity; #326 решает только empty-pin путь и не замещает это исследование.

Native UI проверялся в собственной Tauri/WebView2 identity с synthetic JSONL и CLI/PTY-программой без inference. Rust-команды, события, persistence и PTY настоящие; это не доказательство provider inference или работы production OMP в этом сценарии. Для DOT-080 дополнительно выполнены native first/middle/last background close при трёх вкладках и Cancel: активная сессия сохранена, фокус возвращён соседнему заголовку, surviving xterm backend DOM nodes не изменились. Native OK/Cancel отправлялись адресно реальному TaskDialog, не подменой результата API. Для 20 000 файлов Codex проверены discovery Rust, 200 результатов поиска, ограниченный DOM, NFC и сохранность скрытого выбора. Физический OS IME/AT, clipboard, production updater и Linux WebKit GUI этой проверкой не подразумеваются.

Версия manifests этой ревизии — 0.9.13 для предварительного канала. Stable/latest остаётся v0.9.12 до отдельного решения владельца; выпуск prerelease не разрешает автоматическую promotion или установку поверх рабочей среды пользователя. Source CI не подменяет подписи, checksums, native installer/state и updater-проверки новых production-байтов.
