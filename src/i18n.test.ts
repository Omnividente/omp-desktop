import { describe, expect, it } from "vitest"
import { resolveLang, t, UI_TEXT, type Lang } from "./i18n"

const locales = ["ru", "en", "zh"] as const

type UiText = typeof UI_TEXT.ru
type UiKeyOf = keyof UiText

const keys = Object.keys(UI_TEXT.ru) as UiKeyOf[]

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

describe("UI translation catalogs", () => {
  it("keeps every locale keyed identically", () => {
    const reference = Object.keys(UI_TEXT.ru).sort()
    for (const locale of locales) {
      expect(Object.keys(UI_TEXT[locale]).sort()).toEqual(reference)
    }
  })

  it("keeps placeholder tokens identical across locales", () => {
    for (const key of keys) {
      const expected = placeholders(UI_TEXT.ru[key])
      for (const locale of locales) {
        expect([key, locale, placeholders(UI_TEXT[locale][key])]).toEqual([key, locale, expected])
      }
    }
  })

  it("translates the zh catalog instead of copying the source strings", () => {
    const translated = keys.filter((key) => UI_TEXT.zh[key] !== UI_TEXT.en[key])
    expect(translated.length).toBeGreaterThan(600)
  })
})

describe("language resolution", () => {
  it.each(locales)("resolves the stored %s setting", (lang: Lang) => {
    expect(resolveLang(lang)).toBe(lang)
    expect(t(lang, "settingsTitle")).toBe(UI_TEXT[lang].settingsTitle)
  })

  it("falls back to Russian for unknown or missing values", () => {
    expect(resolveLang("de")).toBe("ru")
    expect(resolveLang(null)).toBe("ru")
    expect(t("de", "settingsTitle")).toBe(UI_TEXT.ru.settingsTitle)
  })
})
