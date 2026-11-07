import { splitSelector } from "./ModelPicker"
import { catalogModelForSelector } from "./modelPassportMetadata"
import type { OmpModelInfo } from "./types"

// Catalog identity for the controls, not proof of the runtime's effective model.
export function sessionModelSelection(models: OmpModelInfo[], selector: string) {
  const configured = splitSelector(selector)
  const model = catalogModelForSelector(models, selector, configured.base)
  const normalized = selector.toLowerCase()
  // Even an unresolved literal must survive: stripping its suffix could make
  // another model appear unambiguous when App stores and renders the result.
  const literal = models.some(
    (candidate) =>
      candidate.selector.toLowerCase() === normalized ||
      `${candidate.provider}/${candidate.id}`.toLowerCase() === normalized ||
      candidate.id.toLowerCase() === normalized,
  )
  return {
    model,
    base: model?.selector ?? (literal ? selector : configured.base),
    thinking: literal ? null : configured.thinking,
  }
}
