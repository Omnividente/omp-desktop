# OMP Desktop 0.1.4

## Русский

Релиз с улучшениями UX и обновлённой маршрутизацией моделей.

### Что изменилось

- Thinking/activity состояние теперь отображается во вкладках терминалов и в списке сессий (пульсация, точки, метки).
- Объединённая левая панель: project rail + collapsible sessions list (ширина 250-320px, grid, chevron).
- Клик по строке сессии переключает на соответствующую вкладку (приоритет runningTab).
- Маршрутизация: A6 primary (качество), Grok Build 0.1 для задач/инструментов, Grok Reasoning для консультаций, advisor только read-only/transcript, XAI fallback на 403.
- Версия поднята до 0.1.4.
- Windows: MSI + NSIS installer.
- Linux: AppImage + DEB + RPM.

Рекомендуется `OMP-Desktop_0.1.4_x64-setup.exe` (Windows) и `OMP-Desktop_0.1.4_amd64.AppImage` (Linux).

## English

Release with UX improvements and updated model routing.

### Changes

- Thinking/activity state shown in terminal tabs and session list (pulse, dots, labels).
- Merged left panel: project rail + expandable sessions (250-320px width, grid layout, chevron).
- Clicking a session row switches to its running tab.
- Routing: A6 primary, Grok Build for tasks/tools, advisor read-only, XAI fallback on 403.
- Version bumped to 0.1.4.
- Windows MSI/NSIS, Linux AppImage/DEB/RPM.

Recommended: `OMP-Desktop_0.1.4_x64-setup.exe` (Windows), `OMP-Desktop_0.1.4_amd64.AppImage` (Linux).

## SHA-256 (0.1.4)

```text
74da288e29e757a6bc488fc8ec05f1c3fd0e9bdb9a1ea0c72ad3cc43c93d19af  windows/OMP-Desktop_0.1.4_x64_en-US.msi
5c1971c8a873cc6bd91bbab456a4a2f182c47924e7705b103cd0b3268bf76119  windows/OMP-Desktop_0.1.4_x64-setup.exe
62ae39d164ef3c2f4ee4138eb51f3c978e59ca0ac4295baf36198101faed16e6  linux/OMP-Desktop_0.1.4_amd64.AppImage
33cfdef3f79b966d2b76f8a361351f3f777475d44bb174a71565c90ad8c0144a  linux/OMP-Desktop_0.1.4_amd64.deb
7d79f5dba635a7c2968d52d5929b39a6e6404c1aef11de841a44294fe2263911  linux/OMP-Desktop-0.1.4-1.x86_64.rpm
```

# OMP Desktop 0.1.3 — Windows и Linux

## Русский

Релиз с безопасным удалением OMP-сессий и исправлениями импорта и списка Codex на Windows.

### Что изменилось

- OMP-сессию можно удалить из списка после подтверждения;
- вместе с JSONL удаляется одноимённый каталог артефактов, а файлы вне корня сессий защищены;
- работающую сессию удалить нельзя, а завершённая вкладка автоматически закрывается после удаления;
- Windows-копии одного Codex rollout объединяются по стабильному ID, остаётся самый новый файл;
- импорт Codex нормализует assistant-сообщения в полную схему OMP и сохраняет `provider/model` без повторного префикса.

Для Windows рекомендуется `OMP-Desktop_0.1.3_x64-setup.exe`; рядом находятся portable EXE и MSI.
Для Linux доступны `OMP-Desktop_0.1.3_amd64.AppImage` и `OMP-Desktop_0.1.3_amd64.deb`.

## English

This release adds safe OMP session deletion and fixes Codex import and Windows session-list behavior.

### Changes

- OMP sessions can be deleted from the session list after confirmation;
- deletion removes both the JSONL and its same-stem artifact directory while protecting files outside the session root;
- running sessions cannot be deleted, and matching exited tabs close automatically after deletion;
- Windows copies of the same Codex rollout are deduplicated by stable session ID, keeping the newest file;
- Codex import normalizes assistant messages to the complete OMP schema and preserves `provider/model` without duplicate prefixes.

On Windows, `OMP-Desktop_0.1.3_x64-setup.exe` is recommended; a portable EXE and MSI are available alongside it.
On Linux, use `OMP-Desktop_0.1.3_amd64.AppImage` or `OMP-Desktop_0.1.3_amd64.deb`.

## SHA-256

```text
bd0d70b96a1104c2f42eb1388715d9c596cdf9bc06162f749e8a02b91f0f3c10  OMP-Desktop_0.1.3_x64-portable.exe
a4b06ee7839bb724b3d48b1f4f5a7d284533c8db4c7261e4abf732ff71129551  OMP-Desktop_0.1.3_x64-setup.exe
5bdc859d0aadd4dc6c42a0560a53ede7ba31d9c90df37c44f9483e4614ab7c93  OMP-Desktop_0.1.3_x64_en-US.msi
55fb57ffdb9c9e0a41aa02a3c355f0a930e8af8b8b428b29ee858808b1401d16  OMP-Desktop_0.1.3_amd64.AppImage
13afb6c786eb5a789a4107856907d795612ae2e6078ba26e28867b571fdea607  OMP-Desktop_0.1.3_amd64.deb
```
