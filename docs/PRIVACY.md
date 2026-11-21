# Privacy, local data and provider access

[← README](../README.md) · [Русский](#русский) · [English](#english) · [Security reporting](../SECURITY.md)

## Русский

### Локальные данные и сетевые запросы

- **Настройки и история.** Настройки Desktop и имена переменных с ключами провайдеров хранятся в `settings.json`. Импорт копирует выбранные JSONL и ограниченные деревья обычных файлов в локальный корень сессий OMP; ссылки и специальные файлы отклоняются.
- **Ключи, добавленные через Desktop.** Значения хранятся в системном хранилище учётных данных, когда оно доступно. При его недоступности Desktop показывает предупреждение и использует отдельный JSON-файл с ограниченными правами доступа. Этот резервный файл не является зашифрованным хранилищем. Значения секретов не возвращаются в снимках настроек интерфейсу.
- **Сеть.** Desktop запускает установленный OMP для получения моделей, лимитов и живых агентских сессий. OMP может передавать запросы, контекст и учётные данные настроенным провайдерам, а также использовать сетевые инструменты. Локальное окно не означает работу модели офлайн. У Desktop нет размещённого сервиса сессий; проверка и загрузка обновлений обращается к GitHub.
- **Публикация.** Удаляйте ключи, личные пути и приватное содержимое из материалов для issues. Об уязвимостях сообщайте по [security policy](../SECURITY.md).

### Приватность истории

Читаемый transcript — не полный аудит файла сессии. При включённой `display.shellVisualization` OMP может сохранять в shell traces раскрытые значения переменных и аргументов, даже если команда их не печатает. Desktop Read не показывает все такие поля; импорт и копирование OMP JSONL не являются очисткой чувствительных данных.

Проверяйте предназначенные для передачи копии файлов и вывода и удаляйте из них чувствительные данные. Отсутствие секрета в Read не доказывает его отсутствие в JSONL. Отключение визуализации для будущих запусков не очищает старые записи и не скрывает явно напечатанные секреты. См. [сообщение upstream и актуальный статус](https://github.com/can1357/oh-my-pi/issues/19355).

### Провайдеры и условия доступа

Совместимость API не означает, что провайдер разрешает использовать потребительскую подписку или OAuth-вход в стороннем приложении. Перед подключением проверьте официальные условия выбранного провайдера; подписка и доступ по API могут оплачиваться отдельно.

По состоянию на 15 ноября 2026 года [условия Google Antigravity](https://antigravity.google/terms) и [официальный FAQ](https://antigravity.google/docs/faq/) предупреждают, что сторонний доступ к Antigravity может привести к приостановке или прекращению доступа к Antigravity и/или Gemini CLI. FAQ также уточняет: headless-режим `agy` предназначен для скриптов и CI, но обёртки вокруг него внутри сторонних агентов или приложений не поддерживаются потребительскими планами. Для сторонних агентов Google указывает API-ключи Google AI Studio или Gemini Enterprise; отдельно проверьте доступность, условия и стоимость выбранного маршрута.

OMP Desktop не предоставляет исключений из правил провайдера. Не публикуйте токены и ключи в issues или диагностических материалах.

> Раздел об Antigravity сохраняет датированное пояснение из прежнего README. Это не новая проверка условий: перед подключением открывайте актуальные документы провайдера по ссылкам выше.

## English

### Local data, network and session privacy

- **Session metadata and shell traces:** the readable transcript is not an audit of the complete session file. With `display.shellVisualization` enabled, OMP can retain expanded variable and argument values in shell traces even when the command does not print them. Desktop Read does not display every such field; importing or copying OMP JSONL is not a sanitization step. Inspect copies of files and output intended for sharing and remove sensitive data from those copies. Absence from Read does not establish absence from JSONL. Disabling visualization for future runs does not clean existing records or hide explicitly printed secrets. See the [upstream report and current status](https://github.com/can1357/oh-my-pi/issues/19355).
- **Local data:** Desktop preferences and provider-key names are stored in `settings.json`. Import copies selected JSONL sessions and bounded regular-file artifact trees into the local OMP session root; links and special files are rejected.
- **Provider credentials added through Desktop:** values use the OS credential store when available. If it is unavailable, Desktop shows a warning and uses a per-user JSON fallback file with restricted filesystem permissions. That fallback is not an encrypted credential store. Secret values are not returned in settings snapshots.
- **Network boundary:** Desktop invokes the installed OMP process for models, usage, and live agent sessions. OMP may send prompts, context, and credentials to configured remote providers and use networked tools; a local Desktop window does not mean offline inference. Desktop has no hosted session service. Its updater contacts GitHub for update metadata and packages.
- **Publishing:** do not include credentials, private transcripts, local state, or personal paths in issues and screenshots. See the [security reporting policy](../SECURITY.md).

### Providers and access terms

API compatibility does not mean a provider permits using a consumer subscription or OAuth login in a third-party application. Before connecting, check the provider's official terms; a subscription and API access may be billed separately.

As checked on November 15, 2026, the [Google Antigravity terms](https://antigravity.google/terms) and [official FAQ](https://antigravity.google/docs/faq/) warn that third-party access to Antigravity can result in suspension or termination of access to Antigravity and/or Gemini CLI. The FAQ also clarifies that `agy` headless mode is intended for scripting and CI, but wrapping it inside third-party agents or applications is not supported under consumer plans. For third-party agents, Google points to API keys from Google AI Studio or Gemini Enterprise; check the availability, terms and pricing of the chosen route separately.

OMP Desktop does not provide exceptions to provider policies. Never publish tokens or keys in issues or diagnostic material.

> The Antigravity section preserves the dated advisory from the previous README. It is not a fresh review of provider terms; check the linked official documents before connecting.
