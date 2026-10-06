import {
  open,
  type DB as NativeDatabaseConnection,
  type QueryResult,
  type Scalar,
} from '@op-engineering/op-sqlite'
import type {
  BindValue,
  DatabaseAdapter,
  DatabaseRow,
  StatementResult,
  TransactionExecutor,
} from '../core/database.js'
import { SynloquentError } from '../core/errors.js'

export interface DatabaseConfiguration {
  readonly name: string
  readonly location?: string
  readonly busyTimeoutMilliseconds?: number
  readonly observeNativeWork?: (event: {
    readonly phase: 'settled'
    readonly statement: string
    readonly elapsedMilliseconds: number
  }) => void
}

export interface NativeDatabaseMeasurements {
  readonly synchronousOpenMilliseconds: number
  readonly synchronousCloseMilliseconds: number | null
  readonly maximumStatementDispatchMilliseconds: number
}

export interface NativeDatabaseAdapter extends DatabaseAdapter {
  nativeMeasurements(): NativeDatabaseMeasurements
}

function normalizeValue(value: Scalar): BindValue {
  if (typeof value === 'boolean') return Number(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return value
}

function normalizeResult(result: QueryResult): StatementResult {
  // Pinned OP execute() creates owned ordinary data rows, never borrowed views.
  const rows: readonly DatabaseRow[] = result.rows.every(
    (row): row is Record<string, string | number | null> => {
      const prototype = Object.getPrototypeOf(row)
      if (prototype !== Object.prototype && prototype !== null) return false
      for (const field in row) {
        if (!Object.prototype.hasOwnProperty.call(row, field)) continue
        const value = row[field]
        if (
          value !== null &&
          typeof value !== 'string' &&
          typeof value !== 'number'
        )
          return false
      }
      return true
    },
  )
    ? result.rows
    : result.rows.map((row) => {
        const values: Record<string, BindValue> = {}
        for (const [field, value] of Object.entries(row))
          values[field] = normalizeValue(value)
        return values
      })
  return {
    rows,
    changes: result.rowsAffected,
    ...(result.insertId === undefined ? {} : { insertId: result.insertId }),
  }
}

/** Async statements and transaction boundaries share one serialized owner. */
export function createDatabaseAdapter(
  configuration: DatabaseConfiguration,
): NativeDatabaseAdapter {
  const platformClock = (
    globalThis as typeof globalThis & {
      readonly performance?: { now(): number }
    }
  ).performance
  const currentMilliseconds = (): number =>
    platformClock ? platformClock.now() : Date.now()
  if (
    !configuration.name ||
    configuration.name.includes('/') ||
    configuration.name.includes('\\')
  ) {
    throw new SynloquentError(
      'schema_mismatch',
      'The database name must be a plain file name.',
    )
  }
  const busyTimeout = configuration.busyTimeoutMilliseconds ?? 5000
  if (
    !Number.isSafeInteger(busyTimeout) ||
    busyTimeout < 0 ||
    busyTimeout > 60000
  ) {
    throw new SynloquentError(
      'schema_mismatch',
      'The busy timeout must be between zero and 60000 milliseconds.',
    )
  }
  // OP 18.2.5 opens synchronously. No query, import, checkpoint or commit runs here.
  const synchronousOpenStarted = currentMilliseconds()
  const connection: NativeDatabaseConnection = open({
    name: configuration.name,
    ...(configuration.location === undefined
      ? {}
      : { location: configuration.location }),
  })
  const synchronousOpenMilliseconds =
    currentMilliseconds() - synchronousOpenStarted
  let synchronousCloseMilliseconds: number | null = null
  let maximumStatementDispatchMilliseconds = 0
  let closed = false
  let closing = false
  let poisoned = false
  let queue: Promise<unknown> = Promise.resolve()
  let nextSavepoint = 0
  const ready = (async () => {
    await connection.execute('PRAGMA foreign_keys = ON')
    await connection.execute('PRAGMA journal_mode = WAL')
    await connection.execute('PRAGMA synchronous = FULL')
    await connection.execute(`PRAGMA busy_timeout = ${busyTimeout}`)
    await connection.execute('PRAGMA case_sensitive_like = ON')
    const comparison = await connection.execute(
      "SELECT 'A' LIKE 'a' AS ascii_match, 'Ž' LIKE 'ž' AS unicode_match",
    )
    if (
      comparison.rows[0]?.ascii_match !== 0 ||
      comparison.rows[0]?.unicode_match !== 0
    ) {
      throw new SynloquentError(
        'schema_mismatch',
        'The native SQLite build must support case-sensitive LIKE comparisons.',
      )
    }
  })()

  async function executeNative(
    statement: string,
    parameters: readonly BindValue[] = [],
  ): Promise<StatementResult> {
    if (closed || poisoned)
      throw new SynloquentError(
        'closed_database',
        'The database is closed or unusable.',
      )
    const started = currentMilliseconds()
    const execution = connection.execute(statement, [...parameters])
    maximumStatementDispatchMilliseconds = Math.max(
      maximumStatementDispatchMilliseconds,
      currentMilliseconds() - started,
    )
    try {
      return normalizeResult(await execution)
    } finally {
      try {
        configuration.observeNativeWork?.({
          phase: 'settled',
          statement,
          elapsedMilliseconds: currentMilliseconds() - started,
        })
      } catch {
        // Diagnostics are isolated from durable database execution.
      }
    }
  }

  function enqueue<Result>(callback: () => Promise<Result>): Promise<Result> {
    if (closing || closed || poisoned) {
      return Promise.reject(
        new SynloquentError(
          'closed_database',
          'The database is closing or closed.',
        ),
      )
    }
    const operation = queue.then(async () => {
      await ready
      return callback()
    })
    queue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  async function runTransaction<Result>(
    callback: (transaction: TransactionExecutor) => Promise<Result>,
    mode: 'read' | 'write',
  ): Promise<Result> {
    await executeNative(mode === 'read' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE')
    let active = true
    let activeScope = 0

    function createExecutor(scope: number): TransactionExecutor {
      const assertScope = () => {
        if (!active)
          throw new SynloquentError(
            'closed_database',
            'The transaction has finished.',
          )
        if (activeScope !== scope) {
          throw new SynloquentError(
            'nested_transaction',
            'Await the nested transaction and use its supplied handle.',
          )
        }
      }
      return {
        execute: async (statement, parameters) => {
          assertScope()
          return executeNative(statement, parameters)
        },
        transaction: async <NestedResult>(
          nested: (transaction: TransactionExecutor) => Promise<NestedResult>,
        ) => {
          assertScope()
          const nestedScope = ++nextSavepoint
          const savepoint = `synloquent_savepoint_${nestedScope}`
          activeScope = nestedScope
          try {
            await executeNative(`SAVEPOINT ${savepoint}`)
            try {
              const result = await nested(createExecutor(nestedScope))
              await executeNative(`RELEASE SAVEPOINT ${savepoint}`)
              return result
            } catch (error) {
              if (!active) throw error
              try {
                await executeNative(`ROLLBACK TO SAVEPOINT ${savepoint}`)
                await executeNative(`RELEASE SAVEPOINT ${savepoint}`)
              } catch (rollbackError) {
                poisoned = true
                throw new AggregateError(
                  [error, rollbackError],
                  'The nested transaction could not roll back.',
                  { cause: rollbackError },
                )
              }
              throw error
            }
          } finally {
            activeScope = scope
          }
        },
      }
    }

    try {
      const result = await callback(createExecutor(0))
      if (activeScope !== 0)
        throw new SynloquentError(
          'nested_transaction',
          'Await the nested transaction before returning from its parent.',
        )
      active = false
      await executeNative('COMMIT')
      return result
    } catch (error) {
      active = false
      try {
        // A poisoned connection can still be rolled back directly before closure.
        await connection.execute('ROLLBACK')
      } catch (rollbackError) {
        poisoned = true
        throw new AggregateError(
          [error, rollbackError],
          'The transaction could not roll back.',
          { cause: rollbackError },
        )
      }
      throw error
    } finally {
      active = false
    }
  }

  let closeOperation: Promise<void> | undefined
  return {
    nativeMeasurements: () => ({
      synchronousOpenMilliseconds,
      synchronousCloseMilliseconds,
      maximumStatementDispatchMilliseconds,
    }),
    capabilities: {
      asynchronous: true,
      transactions: true,
      savepoints: true,
      json: true,
      maximumParameters: 999,
    },
    execute: (statement, parameters) =>
      enqueue(() => executeNative(statement, parameters)),
    transaction: (callback, mode = 'write') =>
      enqueue(() => runTransaction(callback, mode)),
    checkpoint: () =>
      enqueue(async () => {
        const result = await executeNative('PRAGMA wal_checkpoint(TRUNCATE)')
        if (
          result.rows.length !== 1 ||
          result.rows.some((row) => row.busy !== 0)
        )
          throw new SynloquentError(
            'unsupported_query',
            'The WAL checkpoint could not finish.',
          )
      }),
    close: () => {
      if (closeOperation) return closeOperation
      closing = true
      closeOperation = (async () => {
        try {
          await queue
          await ready
          if (!poisoned) await executeNative('PRAGMA wal_checkpoint(TRUNCATE)')
        } finally {
          // OP closeAsync is a synchronous close wrapper. Drain and checkpoint first.
          const started = currentMilliseconds()
          connection.close()
          synchronousCloseMilliseconds = currentMilliseconds() - started
          closed = true
        }
      })()
      return closeOperation
    },
  }
}
