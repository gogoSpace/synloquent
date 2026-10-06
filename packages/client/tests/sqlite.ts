import { DatabaseSync } from 'node:sqlite'
import type {
  BindValue,
  DatabaseAdapter,
  DatabaseRow,
  StatementResult,
  TransactionExecutor,
} from '../src/core/database.js'
import { SynloquentError } from '../src/core/errors.js'

export function openTestDatabase(filename = ':memory:'): DatabaseAdapter {
  const database = new DatabaseSync(filename)
  let savepoint = 0
  let closed = false
  const execute = async (
    statement: string,
    parameters: readonly BindValue[] = [],
  ): Promise<StatementResult> => {
    if (closed)
      throw new SynloquentError('closed_database', 'Test database is closed.')
    const prepared = database.prepare(statement)
    if (prepared.columns().length)
      return { rows: prepared.all(...parameters) as DatabaseRow[], changes: 0 }
    const result = prepared.run(...parameters)
    return {
      rows: [],
      changes: Number(result.changes),
      insertId: String(result.lastInsertRowid),
    }
  }
  const nested: TransactionExecutor = {
    execute,
    async transaction(callback) {
      const name = `nested_${savepoint++}`
      await execute(`SAVEPOINT ${name}`)
      try {
        const result = await callback(nested)
        await execute(`RELEASE SAVEPOINT ${name}`)
        return result
      } catch (error) {
        await execute(`ROLLBACK TO SAVEPOINT ${name}`)
        await execute(`RELEASE SAVEPOINT ${name}`)
        throw error
      }
    },
  }
  return {
    capabilities: {
      asynchronous: true,
      transactions: true,
      savepoints: true,
      json: true,
      maximumParameters: 32766,
    },
    execute,
    async transaction(callback, mode = 'write') {
      await execute(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN')
      try {
        const result = await callback(nested)
        await execute('COMMIT')
        return result
      } catch (error) {
        await execute('ROLLBACK')
        throw error
      }
    },
    async close() {
      if (!closed) {
        closed = true
        database.close()
      }
    },
  }
}
