# OMP Desktop interface tour

[← README](../../README.md) · [GIF](omp-desktop-demo.gif) · [Still image](omp-desktop-demo.png)

## Русский

Ролик показывает настоящее окно OMP Desktop: переключение проектов, поиск сессии,
чтение и поиск по сохранённому диалогу, смену темы интерфейса.

**Все данные созданы специально для демонстрации.** Atlas Notes, Orbit API и
Docs Studio — вымышленные проекты. Восемь сессий содержат подготовленные примеры
вопросов, ответов и кода; это не результаты обращения к модели. Существующие
пользовательские проекты, переписка, аккаунты и ключи в запись не включались.

Запись сделана 21 ноября 2026 года на Linux из исходников **0.9.16** —
[commit `88a950a`](https://github.com/Omnividente/omp-desktop/tree/88a950ab3394b763d835ec2c120c6109acca54f3).
Это демонстрация готовящихся изменений, а не заявление о публикации или успешной
приёмке установочных пакетов. Возможности своей установленной версии сверяйте с
[описанием выпуска](https://github.com/Omnividente/omp-desktop/releases).

В GIF добавлены подписи над окном приложения. Указатель мыши отключён при записи;
фрагменты смонтированы с ускорением примерно в 1,2 раза. Содержимое интерфейса
не подменялось. Для просмотра без анимации доступен [статичный кадр](omp-desktop-demo.png).

## English

This tour records the actual OMP Desktop window: switching projects, finding a
session, reading and searching saved history, and changing the interface theme.

**All data was created for the demonstration.** Atlas Notes, Orbit API, and
Docs Studio are fictional projects. The eight sessions contain authored examples
of questions, answers, and code, not model-generated results. No existing user
projects, conversations, accounts, or credentials were included.

Recorded on Linux on November 21, 2026, from **0.9.16 source** at
[commit `88a950a`](https://github.com/Omnividente/omp-desktop/tree/88a950ab3394b763d835ec2c120c6109acca54f3).
This previews the source changes; it does not establish publication or installer
acceptance. Check the [release notes](https://github.com/Omnividente/omp-desktop/releases)
for the version you install.

Captions sit above the application window. The cursor was hidden during capture,
and the edited clips play at approximately 1.2× speed. Application content was
not substituted. A [still image](omp-desktop-demo.png) is available without animation.

## Recording details

- Native Tauri application with embedded frontend; original product source at the commit above.
- Separate application identity and data directory, a private Xvfb/D-Bus desktop,
  and explicit isolated OMP and XDG paths. Software compositing was used for capture.
- OMP 19.0.1 was available in the isolated profile. No provider sign-in or inference was performed.
- Native controls were operated through AT-SPI/X11. The recording uses no injected page script or mocked application bridge.
- The application window was captured at 1360 × 850, 12 fps. An 80-pixel caption band was added; the GIF is 1360 × 930, 10 fps, 29 seconds, and loops continuously.
- The source conversations were checked against their initial hashes. The owned application and child processes were stopped after recording.

| Asset | Size | SHA-256 |
| --- | ---: | --- |
| `omp-desktop-demo.gif` | 1,008,474 bytes | `f3deb73185eefaa38adb53a002017d447bca664a6fbecd8d8a891636b40cf823` |
| `omp-desktop-demo.png` | 119,117 bytes | `b3cd756c999fc5c964090d6b15bb4fc0fa12a68e7bab9fb61d8209d164ccb717` |

When updating the tour, start with a new isolated profile and fictional data,
pin the application source, inspect every scene, and update the source reference,
asset dimensions, and hashes together.
