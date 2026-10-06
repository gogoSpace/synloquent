import type { DatabaseOwner } from './database.js'
import type { MemoryBudgetPolicy } from './memory-budget.js'

export const recoverableCacheLimits = Object.freeze({
  maximumEntries: 256,
  maximumBytes: 4 * 1024 * 1024,
})

interface CacheEntry {
  readonly value: unknown
  readonly retainedBytes: number
}

/** Admission weights describe recoverable values, not measured heap allocations. */
export class RecoverableMemoryCache {
  private readonly entries = new Map<object, CacheEntry>()
  private retainedBytesValue = 0
  private closed = false
  private generation = 0

  constructor(
    private readonly policy?: MemoryBudgetPolicy,
    private readonly owner?: DatabaseOwner,
  ) {
    this.generation = owner?.generation ?? 0
  }

  get size(): number {
    return this.entries.size
  }

  get retainedBytes(): number {
    return this.retainedBytesValue
  }

  private limits(): { maximumEntries: number; maximumBytes: number } {
    if (this.owner && this.owner.generation !== this.generation) {
      this.clear()
      this.generation = this.owner.generation
    }
    if (this.closed) return { maximumEntries: 0, maximumBytes: 0 }
    try {
      const budget = this.policy?.current()
      const bounded = (value: number, maximum: number) =>
        Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0
      return budget
        ? {
            maximumEntries: bounded(
              budget.maximumCacheEntries,
              recoverableCacheLimits.maximumEntries,
            ),
            maximumBytes: bounded(
              budget.maximumCacheBytes,
              recoverableCacheLimits.maximumBytes,
            ),
          }
        : recoverableCacheLimits
    } catch {
      return { maximumEntries: 0, maximumBytes: 0 }
    }
  }

  get<Value>(key: object): Value | undefined {
    this.reduceToCurrentBudget()
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value as Value
  }

  set<Value>(key: object, value: Value, retainedBytes: number): boolean {
    this.delete(key)
    this.reduceToCurrentBudget()
    const limits = this.limits()
    if (
      !Number.isSafeInteger(retainedBytes) ||
      retainedBytes < 1 ||
      retainedBytes > limits.maximumBytes ||
      limits.maximumEntries === 0
    )
      return false
    while (
      this.entries.size >= limits.maximumEntries ||
      this.retainedBytesValue + retainedBytes > limits.maximumBytes
    )
      this.delete(this.entries.keys().next().value!)
    this.entries.set(key, { value, retainedBytes })
    this.retainedBytesValue += retainedBytes
    return true
  }

  delete(key: object): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.retainedBytesValue -= entry.retainedBytes
    this.entries.delete(key)
  }

  reduceToCurrentBudget(): void {
    const limits = this.limits()
    // At most 256 registry references are removed. No retained value is traversed.
    while (
      this.entries.size > limits.maximumEntries ||
      this.retainedBytesValue > limits.maximumBytes
    )
      this.delete(this.entries.keys().next().value!)
  }

  clear(): void {
    this.entries.clear()
    this.retainedBytesValue = 0
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.clear()
  }
}

const ownerCaches = new WeakMap<DatabaseOwner, RecoverableMemoryCache>()

/** Transaction-scoped Storage instances share one bounded database-owner cache. */
export function memoryCacheForOwner(
  owner: DatabaseOwner,
  policy?: MemoryBudgetPolicy,
): RecoverableMemoryCache {
  const existing = ownerCaches.get(owner)
  if (existing) return existing
  const cache = new RecoverableMemoryCache(policy, owner)
  ownerCaches.set(owner, cache)
  return cache
}
