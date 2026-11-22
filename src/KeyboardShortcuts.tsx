import { t, type Lang } from "./i18n"
import { formatShortcut } from "./uiUtils"

/** Read-only reference for existing Desktop commands, not the terminal's OMP bindings. */
export function KeyboardShortcuts({ language, platform }: { language: Lang; platform: string }) {
  const shortcuts = [
    ["Ctrl + Shift + O", t(language, "btnOpenFolder"), t(language, "shortcutDesktopScope")],
    ["Ctrl + B", t(language, "shortcutSidebar"), t(language, "shortcutDesktopScope")],
    ["Ctrl + N", t(language, "btnNewSession"), t(language, "shortcutDesktopScope")],
    ["Ctrl + W", t(language, "shortcutCloseTab"), t(language, "shortcutDesktopScope")],
    ["Alt + Shift + ← / →", t(language, "shortcutReorder"), t(language, "shortcutTabScope")],
    ["Ctrl + F", t(language, "transcriptSearch"), t(language, "shortcutHistoryScope")],
    ["↑ / ↓ / Home / End", t(language, "settingsCategories"), t(language, "shortcutCategoryScope")],
  ]

  return (
    <details className="keyboard-shortcuts">
      <summary>{t(language, "keyboardShortcutsTitle")}</summary>
      <p className="field-help">{t(language, "keyboardShortcutsHelp")}</p>
      <dl className="keyboard-shortcuts-list">
        {shortcuts.map(([keys, action, scope]) => (
          <div key={keys}>
            <dt>
              <kbd>{formatShortcut(keys, platform)}</kbd>
            </dt>
            <dd>
              <strong>{action}</strong>
              <small>{scope}</small>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
