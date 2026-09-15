import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefCallback,
  type RefObject,
} from "react"

export interface VirtualItem<T> {
  index: number
  item: T
  offset: number
  height: number
}

type VirtualKey = string | number

export interface UseVirtualOptions<T> {
  estimatedRowHeight: number
  overscan?: number
  itemGap?: number
  getItemKey?: (item: T, index: number) => VirtualKey
  measurementKey?: unknown
}

export interface UseVirtualResult<T> {
  virtualItems: VirtualItem<T>[]
  totalHeight: number
  measureElement: RefCallback<HTMLElement>
}

interface VirtualLayout {
  offsets: number[]
  heights: number[]
  totalHeight: number
}

const DEFAULT_VIEWPORT_HEIGHT = 480
const MEASUREMENT_EPSILON = 0.5

function virtualKeyFor<T>(
  items: T[],
  index: number,
  getItemKey: UseVirtualOptions<T>["getItemKey"],
): VirtualKey {
  return getItemKey ? getItemKey(items[index], index) : index
}

function firstVisibleIndex(offsets: number[], heights: number[], scrollTop: number): number {
  let low = 0
  let high = offsets.length - 1
  let result = high

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (offsets[middle] + heights[middle] > scrollTop) {
      result = middle
      high = middle - 1
    } else {
      low = middle + 1
    }
  }

  return result
}

function lastVisibleIndex(offsets: number[], viewportBottom: number): number {
  let low = 0
  let high = offsets.length - 1
  let result = 0

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (offsets[middle] < viewportBottom) {
      result = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return result
}

/**
 * Windowing for fixed or variable-height rows. Fixed rows only consume the
 * returned offsets. Variable rows attach measureElement and are re-laid out
 * from their observed border-box heights before paint.
 */
export function useVirtualList<T>(
  items: T[],
  containerRef: RefObject<HTMLElement | null>,
  {
    estimatedRowHeight,
    overscan = 6,
    itemGap = 0,
    getItemKey,
    measurementKey,
  }: UseVirtualOptions<T>,
): UseVirtualResult<T> {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT)
  const [measurementRevision, setMeasurementRevision] = useState(0)
  const measuredElementsRef = useRef(new Set<HTMLElement>())
  const measurementObserverRef = useRef<ResizeObserver | null>(null)
  const previousContainerWidthRef = useRef<number | null>(null)
  const measurementCachesRef = useRef(new Map<unknown, Map<VirtualKey, number>>())

  let measurements = measurementCachesRef.current.get(measurementKey)
  if (!measurements) {
    measurements = new Map<VirtualKey, number>()
    measurementCachesRef.current.set(measurementKey, measurements)
  }

  const itemsRef = useRef(items)
  const getItemKeyRef = useRef(getItemKey)
  const activeMeasurementsRef = useRef(measurements)
  itemsRef.current = items
  getItemKeyRef.current = getItemKey
  activeMeasurementsRef.current = measurements

  useEffect(() => {
    for (const key of measurementCachesRef.current.keys()) {
      if (!Object.is(key, measurementKey)) {
        measurementCachesRef.current.delete(key)
      }
    }
  }, [measurementKey])

  const safeEstimate =
    Number.isFinite(estimatedRowHeight) && estimatedRowHeight > 0 ? estimatedRowHeight : 0
  const safeGap = Number.isFinite(itemGap) ? Math.max(0, itemGap) : 0
  const safeOverscan = Number.isFinite(overscan) ? Math.max(0, Math.floor(overscan)) : 0

  const layout = useMemo<VirtualLayout>(() => {
    const offsets = new Array<number>(items.length)
    const heights = new Array<number>(items.length)
    let nextOffset = 0

    for (let index = 0; index < items.length; index += 1) {
      const key = virtualKeyFor(items, index, getItemKey)
      const height = measurements.get(key) ?? safeEstimate
      offsets[index] = nextOffset
      heights[index] = height
      nextOffset += height
      if (index < items.length - 1) nextOffset += safeGap
    }

    return { offsets, heights, totalHeight: nextOffset }
  }, [getItemKey, items, measurementRevision, measurements, safeEstimate, safeGap]) // eslint-disable-line react-hooks/exhaustive-deps -- measurementRevision is an invalidation counter, intentionally included

  const range = useMemo(() => {
    if (safeEstimate <= 0 || items.length === 0) {
      return { start: 0, end: -1 }
    }

    const first = firstVisibleIndex(layout.offsets, layout.heights, scrollTop)
    const last = lastVisibleIndex(layout.offsets, scrollTop + viewportHeight)
    return {
      start: Math.max(0, first - safeOverscan),
      end: Math.min(items.length - 1, Math.max(first, last) + safeOverscan),
    }
  }, [
    items.length,
    layout.heights,
    layout.offsets,
    safeEstimate,
    safeOverscan,
    scrollTop,
    viewportHeight,
  ])

  const virtualItems = useMemo<VirtualItem<T>[]>(() => {
    const windowItems: VirtualItem<T>[] = []
    for (let index = range.start; index <= range.end; index += 1) {
      const item = items[index]
      if (item === undefined) continue
      windowItems.push({
        index,
        item,
        offset: layout.offsets[index],
        height: layout.heights[index],
      })
    }
    return windowItems
  }, [items, layout.heights, layout.offsets, range.end, range.start])

  const updateMeasurements = useCallback((elements: Iterable<HTMLElement>) => {
    const currentItems = itemsRef.current
    const currentGetItemKey = getItemKeyRef.current
    const currentMeasurements = activeMeasurementsRef.current
    let changed = false

    for (const element of elements) {
      const index = Number(element.dataset.virtualIndex)
      if (!Number.isInteger(index) || index < 0 || index >= currentItems.length) continue

      const height = element.getBoundingClientRect().height
      if (!Number.isFinite(height) || height <= 0) continue

      const key = virtualKeyFor(currentItems, index, currentGetItemKey)
      const previous = currentMeasurements.get(key)
      if (previous === undefined || Math.abs(previous - height) > MEASUREMENT_EPSILON) {
        currentMeasurements.set(key, height)
        changed = true
      }
    }

    if (changed) setMeasurementRevision((current) => current + 1)
  }, [])

  const measureElement = useCallback<RefCallback<HTMLElement>>((element) => {
    if (!element) return undefined
    measuredElementsRef.current.add(element)
    measurementObserverRef.current?.observe(element)

    return () => {
      measuredElementsRef.current.delete(element)
      measurementObserverRef.current?.unobserve(element)
    }
  }, [])

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined

    const observer = new ResizeObserver((entries) => {
      updateMeasurements(entries.map((entry) => entry.target as HTMLElement))
    })
    measurementObserverRef.current = observer
    for (const element of measuredElementsRef.current) observer.observe(element)

    return () => {
      measurementObserverRef.current = null
      observer.disconnect()
    }
  }, [updateMeasurements])

  useLayoutEffect(() => {
    updateMeasurements(measuredElementsRef.current)
  })

  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined
    let animationFrame: number | null = null

    const updateMetrics = () => {
      animationFrame = null
      setScrollTop(element.scrollTop)
      setViewportHeight(element.clientHeight || DEFAULT_VIEWPORT_HEIGHT)

      const width = element.clientWidth
      const previousWidth = previousContainerWidthRef.current
      previousContainerWidthRef.current = width
      if (previousWidth !== null && Math.abs(previousWidth - width) > MEASUREMENT_EPSILON) {
        activeMeasurementsRef.current.clear()
        setMeasurementRevision((current) => current + 1)
      }
    }

    const scheduleMetrics = () => {
      if (animationFrame === null) {
        animationFrame = window.requestAnimationFrame(updateMetrics)
      }
    }

    element.addEventListener("scroll", scheduleMetrics, { passive: true })
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMetrics)
    observer?.observe(element)
    updateMetrics()

    return () => {
      element.removeEventListener("scroll", scheduleMetrics)
      observer?.disconnect()
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
    }
  }, [containerRef])

  return {
    virtualItems,
    totalHeight: layout.totalHeight,
    measureElement,
  }
}

/** Pure helper retained for fixed-row range contracts. */
export function computeVisibleRange(
  scrollTop: number,
  viewportHeight: number,
  itemCount: number,
  rowHeight: number,
  overscan: number,
): { start: number; end: number } {
  if (rowHeight <= 0 || itemCount <= 0) return { start: 0, end: -1 }
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(
    itemCount - 1,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
  )
  return { start, end: Math.max(start, end) }
}
