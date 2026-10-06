import { DatabaseSync } from 'node:sqlite'
import type {
  BindValue,
  DatabaseAdapter,
  DatabaseRow,
  StatementResult,
  TransactionExecutor,
} from '@synloquent/client'

/** Real SQLite test adapter. This synchronous Node witness makes no native timing claim. */
export class NodeDatabase implements DatabaseAdapter {
  readonly capabilities = {
    asynchronous: true,
    transactions: true,
    savepoints: true,
    json: true,
    maximumParameters: 32766,
  } as const
  private readonly connection: DatabaseSync
  private queue: Promise<unknown> = Promise.resolve()
  private savepointSequence = 0
  private closed = false

  constructor(filename: string) {
    this.connection = new DatabaseSync(filename)
    this.connection.exec('PRAGMA foreign_keys = ON')
    this.connection.exec('PRAGMA journal_mode = WAL')
    this.connection.exec('PRAGMA synchronous = FULL')
    this.connection.exec('PRAGMA case_sensitive_like = ON')
  }

  private enqueue<Result>(callback: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(callback)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async executeDirect(statement: string, parameters: readonly BindValue[] = []): Promise<StatementResult> {
    if (this.closed) throw new Error('Node test database is closed')
    const prepared = this.connection.prepare(statement)
    const rows = prepared.all(...parameters) as DatabaseRow[]
    const mutation = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statement)
    if (!mutation) return { rows, changes: 0 }
    const metadata = this.connection.prepare('SELECT changes() AS changes, last_insert_rowid() AS identity').get()
    return { rows, changes: Number(metadata?.changes ?? 0), insertId: String(metadata?.identity ?? 0) }
  }

  execute(statement: string, parameters: readonly BindValue[] = []): Promise<StatementResult> {
    return this.enqueue(() => this.executeDirect(statement, parameters))
  }

  private executor(): TransactionExecutor {
    return {
      execute: (statement, parameters) => this.executeDirect(statement, parameters),
      transaction: async <Result>(callback: (transaction: TransactionExecutor) => Promise<Result>): Promise<Result> => {
        const savepoint = `synloquent_test_${++this.savepointSequence}`
        await this.executeDirect(`SAVEPOINT ${savepoint}`)
        try {
          const result = await callback(this.executor())
          await this.executeDirect(`RELEASE SAVEPOINT ${savepoint}`)
          return result
        } catch (failure) {
          await this.executeDirect(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          await this.executeDirect(`RELEASE SAVEPOINT ${savepoint}`)
          throw failure
        }
      },
    }
  }

  transaction<Result>(callback: (transaction: TransactionExecutor) => Promise<Result>, mode: 'read' | 'write' = 'write'): Promise<Result> {
    return this.enqueue(async () => {
      await this.executeDirect(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN')
      try {
        const result = await callback(this.executor())
        await this.executeDirect('COMMIT')
        return result
      } catch (failure) {
        await this.executeDirect('ROLLBACK')
        throw failure
      }
    })
  }

  async close(): Promise<void> {
    await this.queue
    if (this.closed) return
    this.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.connection.close()
    this.closed = true
  }
}
