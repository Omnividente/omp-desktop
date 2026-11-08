// Backport jerch's xtermjs/xterm.js#6004 (596634ac4189852a15d0178e49201fc7d52c968d).
// The pinned 6.0.0 ESM bundle tests the masked continuation byte for presence:
// 0x80 then looks absent, losing a valid code point across terminal writes.
// Keep xterm's decoder and validation; move only the mask to accumulation.
const ORIGINAL = "for(;(f=this.interim[++m]&63)&&m<4;)p<<=6,p|=f;"
const CORRECTED = "for(;(f=this.interim[++m])&&m<4;)p<<=6,p|=f&63;"

/** Build-time only. Dependency changes must review this pinned decoder site. */
export function patchXtermUtf8(code: string, id: string): string | null {
  if (!/[/\\]@xterm[/\\]xterm[/\\]lib[/\\]xterm\.mjs(?:\?.*)?$/.test(id)) return null
  const first = code.indexOf(ORIGINAL)
  if (
    first < 0 ||
    code.indexOf(ORIGINAL, first + ORIGINAL.length) !== -1 ||
    code.includes(CORRECTED)
  ) {
    throw new Error("Unsupported xterm UTF-8 decoder: review the pinned 6.0.0 backport")
  }
  return code.slice(0, first) + CORRECTED + code.slice(first + ORIGINAL.length)
}
