import {
  createSynloquent,
  createMemoryBudgetPolicy,
  type DatabaseAdapter,
  type TransactionExecutor,
  type BindValue,
  type ClientConfiguration,
  type Manifest,
  type MemoryBudgetPolicy,
} from '@synloquent/client'
import { createDatabaseAdapter } from '@synloquent/client/sqlite'
import {
  backendSchema,
  type BackendModels,
  type BackendCommands,
  type BackendScopes,
} from '../backend.generated'
import { createExampleTransport } from './httpTransport'
import { exampleSession, type ExampleClient } from './nativeQualification'
import {
  createMeasuredCryptoProvider,
  generateIdentity,
  nativeClock,
  createNativeSqlObserver,
  schedule,
} from './platform'
import {
  calibrationUtf8Length,
  type CalibrationSourceStatement,
} from './nativeCalibrationSource'
import type { CalibrationSqlCounters } from './nativeCalibrationReceipts'

function parameterBytes(values: readonly BindValue[]): number {
  let bytes = 0
  for (const value of values)
    bytes +=
      typeof value === 'string'
        ? calibrationUtf8Length(value)
        : value instanceof Uint8Array
          ? value.byteLength
          : 8
  return bytes
}
function category(statement: string): string {
  if (/^VACUUM\b/i.test(statement.trim())) return 'vacuum'
  if (/syn_snapshot_rows/.test(statement)) return 'private-rows'
  if (/syn_snapshot_parts/.test(statement)) return 'private-parts'
  if (/syn_calibration_reference_identities/.test(statement))
    return 'reference-identities'
  if (/syn_snapshot_membership/.test(statement)) return 'membership'
  if (/syn_model_/.test(statement)) return 'model'
  if (/syn_(?:relation|pivot)/.test(statement)) return 'relation'
  if (/syn_(?:outbox|dependency|alias|recovery)/.test(statement))
    return 'pending'
  if (/^PRAGMA\b/i.test(statement.trim())) return 'pragma'
  if (/^(?:CREATE|DROP|ALTER)\b/i.test(statement.trim())) return 'ddl'
  return 'other'
}
export function createCalibrationSqlObserver(actual: DatabaseAdapter) {
  type MutableCounters = {
    -readonly [Key in keyof CalibrationSqlCounters]: CalibrationSqlCounters[Key]
  }
  const fresh = (): MutableCounters => ({
    statements: 0,
    rejectedStatements: 0,
    transactions: 0,
    checkpoints: 0,
    rejectedCheckpoints: 0,
    vacuumStatements: 0,
    rejectedVacuumStatements: 0,
    maximumParameters: 0,
    maximumBindingBytes: 0,
    maximumReturnedRows: 0,
    maximumActivationPageRows: 0,
    activationPageStatements: 0,
    maximumModelInsertRows: 0,
    actualDriverParameterLimit: actual.capabilities.maximumParameters,
    nativeSettledStatements: 0,
    nativeCheckpointStatements: 0,
    sourceStatements: 0,
    rejectedSourceStatements: 0,
    maximumSourceParameters: 0,
    maximumSourceBindingBytes: 0,
    maximumSourceReturnedRows: 0,
    statementCategories: {},
  })
  let counters = fresh()
  const execute = async (
    original: TransactionExecutor,
    statement: string,
    parameters: readonly BindValue[] = [],
  ) => {
    const name = category(statement)
    const bytes = parameterBytes(parameters)
    const values = /\bVALUES\s+([\s\S]*?)(?:\bON\s+CONFLICT\b|$)/i.exec(
      statement,
    )?.[1]
    const inserted =
      /^INSERT(?:\s+OR\s+\w+)?\s+INTO\s+["`]?syn_model_/.test(
        statement.trim(),
      ) && values
        ? (values.match(/\((?:\?,)*\?\)/g)?.length ?? 0)
        : 0
    counters.statements += 1
    counters.maximumParameters = Math.max(
      counters.maximumParameters,
      parameters.length,
    )
    counters.maximumBindingBytes = Math.max(counters.maximumBindingBytes, bytes)
    counters.maximumModelInsertRows = Math.max(
      counters.maximumModelInsertRows,
      inserted,
    )
    counters.vacuumStatements += Number(name === 'vacuum')
    const categories = counters.statementCategories as Record<string, number>
    categories[name] = (categories[name] ?? 0) + 1
    try {
      const result = await original.execute(statement, parameters)
      const page =
        (/WITH page_scope AS/.test(statement) &&
          /FROM syn_snapshot_rows/.test(statement)) ||
        (/^SELECT row_index/.test(statement) &&
          /FROM syn_snapshot_rows/.test(statement) &&
          /(?:LIMIT|row_index IN)/.test(statement))
      counters.maximumReturnedRows = Math.max(
        counters.maximumReturnedRows,
        result.rows.length,
      )
      counters.maximumActivationPageRows = Math.max(
        counters.maximumActivationPageRows,
        page ? result.rows.length : 0,
      )
      counters.activationPageStatements += Number(page)
      return result
    } catch (failure) {
      counters.rejectedStatements += 1
      counters.rejectedVacuumStatements += Number(name === 'vacuum')
      throw failure
    }
  }
  const executor = (original: TransactionExecutor): TransactionExecutor => ({
    execute: (statement, parameters) =>
      execute(original, statement, parameters),
    transaction: (callback) =>
      original.transaction((nested) => callback(executor(nested))),
  })
  const database: DatabaseAdapter = {
    capabilities: actual.capabilities,
    execute: (statement, parameters) => execute(actual, statement, parameters),
    transaction: (callback, mode) => {
      counters.transactions += 1
      return actual.transaction(
        (original) => callback(executor(original)),
        mode,
      )
    },
    ...(actual.checkpoint
      ? {
          checkpoint: async () => {
            counters.checkpoints += 1
            try {
              await actual.checkpoint!()
            } catch (failure) {
              counters.rejectedCheckpoints += 1
              throw failure
            }
          },
        }
      : {}),
    close: () => actual.close(),
  }
  return {
    database,
    observeNative(statement: string) {
      counters.nativeSettledStatements += 1
      counters.nativeCheckpointStatements += Number(
        /^PRAGMA wal_checkpoint/.test(statement),
      )
    },
    observeSource(event: CalibrationSourceStatement) {
      counters.sourceStatements += 1
      counters.rejectedSourceStatements += Number(event.rejected)
      counters.maximumSourceParameters = Math.max(
        counters.maximumSourceParameters,
        event.parameters,
      )
      counters.maximumSourceBindingBytes = Math.max(
        counters.maximumSourceBindingBytes,
        event.bindingBytes,
      )
      counters.maximumSourceReturnedRows = Math.max(
        counters.maximumSourceReturnedRows,
        event.returnedRows,
      )
    },
    reset() {
      counters = fresh()
    },
    receipt(): CalibrationSqlCounters {
      return {
        ...counters,
        statementCategories: { ...counters.statementCategories },
      }
    },
  }
}

export interface CalibrationClientOwner {
  readonly databaseName: string
  readonly client: ExampleClient
  readonly policy: MemoryBudgetPolicy
  readonly sql: ReturnType<typeof createCalibrationSqlObserver>
  close(): Promise<void>
}
/** Example-only instrumentation is installed before the owner and Storage exist. */
export async function makeCalibrationClient(
  name: string,
  address: string,
  diagnostics: Partial<
    Pick<
      ClientConfiguration,
      'observeSnapshotPhase' | 'now' | 'generateIdentity' | 'transport'
    >
  > = {},
  schema: Manifest = backendSchema,
  recordCleanupFailure: (resource: string, failure: unknown) => void,
): Promise<CalibrationClientOwner> {
  let policy: MemoryBudgetPolicy | undefined
  let crypto: ReturnType<typeof createMeasuredCryptoProvider> | undefined
  let transport: ReturnType<typeof createExampleTransport> | undefined
  let actual: ReturnType<typeof createDatabaseAdapter> | undefined
  let client: ExampleClient | undefined
  let sql: ReturnType<typeof createCalibrationSqlObserver> | undefined
  try {
    const ownedPolicy = createMemoryBudgetPolicy({
      nowMilliseconds: () => nativeClock.now(),
    })
    policy = ownedPolicy
    const ownedCrypto = createMeasuredCryptoProvider(
      () => ownedPolicy.current().maximumHashBufferUnits,
    )
    crypto = ownedCrypto
    const ownedTransport = createExampleTransport({
      address,
      digest: ownedCrypto.digest,
    })
    transport = ownedTransport
    const nativeSqlObserver = createNativeSqlObserver(name)
    actual = createDatabaseAdapter({
      name,
      observeNativeWork: (event) => {
        sql?.observeNative(event.statement)
        nativeSqlObserver.observeNativeWork(event)
      },
    })
    sql = createCalibrationSqlObserver(actual)
    client = await createSynloquent<
      BackendModels,
      BackendCommands,
      BackendScopes
    >({
      schema,
      database: sql.database,
      session: exampleSession,
      transport: ownedTransport,
      generateIdentity,
      now: () => new Date().toISOString(),
      digest: ownedCrypto.digest,
      digestChunks: ownedCrypto.digestChunks,
      memoryBudget: ownedPolicy,
      schedule,
      ...diagnostics,
      observeSnapshotPhase(event) {
        nativeSqlObserver.observeSnapshotPhase(event)
        diagnostics.observeSnapshotPhase?.call(this, event)
      },
    })
    nativeSqlObserver.bindClient(client)
    const originalSetSession = client.sync.setSession.bind(client.sync)
    const originalClose = client.close.bind(client)
    client.sync.setSession = async (session) => {
      ownedTransport.suspend()
      await originalSetSession(session)
    }
    let closing: Promise<void> | undefined
    client.close = () => {
      if (closing) return closing
      const resources = [
        { resource: 'policy', close: () => ownedPolicy.close() },
        { resource: 'transport', close: () => ownedTransport.close() },
        { resource: 'crypto', close: () => ownedCrypto.close() },
        { resource: 'client', close: () => originalClose() },
      ]
      closing = Promise.allSettled(
        resources.map(({ close }) => Promise.resolve().then(close)),
      ).then((results) => {
        const failures: unknown[] = []
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            recordCleanupFailure(
              'client ' + name + ' ' + resources[index]!.resource,
              result.reason,
            )
            failures.push(result.reason)
          }
        })
        if (failures.length)
          throw new AggregateError(
            failures,
            'Calibration client cleanup failed.',
          )
      })
      return closing
    }
    const owned = client
    const ownedSql = sql
    return {
      databaseName: name,
      client: owned,
      policy: ownedPolicy,
      sql: ownedSql,
      close: () => owned.close(),
    }
  } catch (failure) {
    const resources: {
      resource: string
      close: () => unknown | Promise<unknown>
    }[] = []
    if (policy) {
      const owned = policy
      resources.push({ resource: 'policy', close: () => owned.close() })
    }
    if (transport) {
      const owned = transport
      resources.push({ resource: 'transport', close: () => owned.close() })
    }
    if (crypto) {
      const owned = crypto
      resources.push({ resource: 'crypto', close: () => owned.close() })
    }
    if (client) {
      const owned = client
      resources.push({ resource: 'client', close: () => owned.close() })
    } else if (actual) {
      const owned = actual
      resources.push({ resource: 'adapter', close: () => owned.close() })
    }
    const results = await Promise.allSettled(
      resources.map(({ close }) => Promise.resolve().then(close)),
    )
    results.forEach((result, index) => {
      if (result.status === 'rejected')
        recordCleanupFailure(
          'partial client ' + name + ' ' + resources[index]!.resource,
          result.reason,
        )
    })
    throw failure
  }
}
