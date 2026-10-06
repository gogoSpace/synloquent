import { SynloquentError } from './errors.js'
import type { DigestLifecycle } from './types.js'

export type BindValue = string | number | null | Uint8Array
export type DatabaseRow = Readonly<Record<string, BindValue>>
export interface StatementResult {
  readonly rows: readonly DatabaseRow[]
  readonly changes: number
  readonly insertId?: string | number
}
export interface TransactionExecutor {
  transaction<Result>(
    callback: (transaction: TransactionExecutor) => Promise<Result>,
  ): Promise<Result>
  execute(
    statement: string,
    parameters?: readonly BindValue[],
  ): Promise<StatementResult>
}
export interface DatabaseAdapter extends TransactionExecutor {
  readonly capabilities: {
    readonly asynchronous: true
    readonly transactions: true
    readonly savepoints: boolean
    readonly json: boolean
    readonly maximumParameters: number
  }
  transaction<Result>(
    callback: (transaction: TransactionExecutor) => Promise<Result>,
    mode?: 'read' | 'write',
  ): Promise<Result>
  close(): Promise<void>
  checkpoint?(): Promise<void>
}

interface DigestCancellationState {
  readonly cancelled: boolean
  readonly cancellation: Promise<never>
  readonly lifecycle: DigestLifecycle
  readonly failure: SynloquentError
  readonly cancel: (reason: SynloquentError) => void
  clearListeners(): void
}

function createDigestCancellationState(
  replacement: SynloquentError,
): DigestCancellationState {
  let cancelled = false
  let failure = replacement
  const listeners = new Set<() => void>()
  let rejectCancellation: (failure: SynloquentError) => void = () => {}
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const lifecycle: DigestLifecycle = {
    get cancelled() {
      return cancelled
    },
    subscribe(listener) {
      if (cancelled) listener()
      else listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const cancel = (reason: SynloquentError): void => {
    if (cancelled) return
    cancelled = true
    failure = reason
    rejectCancellation(reason)
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* Cancellation diagnostics cannot prevent lifecycle cleanup. */
      }
    }
    listeners.clear()
  }
  return {
    get cancelled() {
      return cancelled
    },
    cancellation,
    lifecycle,
    get failure() {
      return failure
    },
    cancel,
    clearListeners() {
      listeners.clear()
    },
  }
}

/** The owner serializes the database lifecycle and publishes invalidations only after commit. */
export class DatabaseOwner {
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private closing = false
  private listeners = new Set<
    (tables: ReadonlySet<string>, generation: number) => void
  >()
  private generationValue = 0
  private pendingDigests = new Map<
    (failure: SynloquentError) => void,
    Promise<unknown>
  >()
  private lastDigestCancellation:
    ((failure: SynloquentError) => void) | undefined

  constructor(readonly adapter: DatabaseAdapter) {}

  verifyDigest<Result>(
    callback: (lifecycle: DigestLifecycle) => Promise<Result>,
  ): Promise<Result> {
    if (this.closed || this.closing)
      return Promise.reject(
        new SynloquentError(
          'closed_database',
          'Cannot verify a snapshot for a closed database.',
        ),
      )
    const replacement = new SynloquentError(
      'session_changed',
      'Snapshot verification was replaced by newer work.',
    )
    this.lastDigestCancellation?.(replacement)
    const cancellationState = createDigestCancellationState(replacement)
    const verification = Promise.resolve().then(() => {
      if (cancellationState.cancelled) throw cancellationState.failure
      return callback(cancellationState.lifecycle)
    })
    const result = Promise.race([
      verification,
      cancellationState.cancellation,
    ]).finally(() => {
      this.pendingDigests.delete(cancellationState.cancel)
      cancellationState.clearListeners()
    })
    this.pendingDigests.set(cancellationState.cancel, result)
    this.lastDigestCancellation = cancellationState.cancel
    return result
  }

  private cancelDigests(failure: SynloquentError): Promise<unknown>[] {
    const pending = [...this.pendingDigests.values()]
    for (const cancel of this.pendingDigests.keys()) cancel(failure)
    return pending
  }

  get generation(): number {
    return this.generationValue
  }

  private enqueue<Result>(callback: () => Promise<Result>): Promise<Result> {
    if (this.closing || this.closed)
      return Promise.reject(
        new SynloquentError(
          'closed_database',
          'The database owner is closing.',
        ),
      )
    const result = this.queue.then(async () => {
      if (this.closed)
        throw new SynloquentError(
          'closed_database',
          'The database owner is closed.',
        )
      return callback()
    })
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  read<Result>(
    callback: (executor: TransactionExecutor) => Promise<Result>,
  ): Promise<Result> {
    return this.enqueue(() => this.adapter.transaction(callback, 'read'))
  }

  write<Result>(
    callback: (
      executor: TransactionExecutor,
      changed: Set<string>,
    ) => Promise<Result>,
  ): Promise<Result> {
    return this.enqueue(async () => {
      const changed = new Set<string>()
      const result = await this.adapter.transaction(
        (executor) => callback(executor, changed),
        'write',
      )
      if (changed.size)
        for (const listener of this.listeners)
          listener(changed, this.generationValue)
      return result
    })
  }

  subscribe(
    listener: (tables: ReadonlySet<string>, generation: number) => void,
  ): () => void {
    if (this.closed || this.closing)
      throw new SynloquentError(
        'closed_database',
        'Cannot subscribe to a closed database.',
      )
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async replace<Result>(
    callback: (
      executor: TransactionExecutor,
      changed: Set<string>,
    ) => Promise<Result>,
    reclaimFreePages = false,
  ): Promise<Result> {
    await Promise.allSettled(
      this.cancelDigests(
        new SynloquentError(
          'session_changed',
          'Snapshot verification belongs to a previous database generation.',
        ),
      ),
    )
    return this.enqueue(async () => {
      const changed = new Set<string>()
      const result = await this.adapter.transaction(
        (executor) => callback(executor, changed),
        'write',
      )
      this.generationValue += 1
      for (const listener of this.listeners)
        listener(changed, this.generationValue)
      if (reclaimFreePages) {
        try {
          const pages = await this.adapter.execute('PRAGMA freelist_count')
          const freePages = Number(pages.rows[0]?.freelist_count)
          if (Number.isSafeInteger(freePages) && freePages > 0) {
            await this.adapter.execute('VACUUM')
            await this.adapter.checkpoint?.()
          }
        } catch {
          // Activation has committed. Failed maintenance leaves durable data intact.
        }
      }
      return result
    })
  }

  async close(): Promise<void> {
    this.closing = true
    this.lastDigestCancellation?.(
      new SynloquentError(
        'closed_database',
        'Snapshot verification was cancelled by database close.',
      ),
    )
    await Promise.allSettled(
      this.cancelDigests(
        new SynloquentError(
          'closed_database',
          'Snapshot verification was cancelled by database close.',
        ),
      ),
    )
    await this.queue
    if (this.closed) return
    this.closed = true
    this.generationValue += 1
    this.listeners.clear()
    await this.adapter.close()
  }

  checkpoint(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.adapter.checkpoint)
        throw new SynloquentError(
          'unsupported_query',
          'The database adapter does not support checkpoint maintenance.',
        )
      await this.adapter.checkpoint()
    })
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier))
    throw new SynloquentError('schema_mismatch', 'Unsafe storage identifier.', {
      identifier,
    })
  return `"${identifier}"`
}
