import { open } from '@op-engineering/op-sqlite'
import { Platform } from 'react-native'
import {
  createDatabaseAdapter,
  type NativeDatabaseAdapter,
} from '@synloquent/client/sqlite'

const nativeClock = (
  globalThis as typeof globalThis & { readonly performance: { now(): number } }
).performance

export interface NativeCheck {
  readonly name: string
  readonly durationMilliseconds: number
  readonly detail: unknown
}

export interface NativeSpikeResult {
  readonly platform: string
  readonly hermes: boolean
  readonly status: 'passed' | 'failed'
  readonly checks: readonly NativeCheck[]
  readonly error?: string
  readonly startedAt: string
  readonly finishedAt: string
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export async function runDriverSpike(
  onProgress: (message: string) => void,
): Promise<NativeSpikeResult> {
  const startedAt = new Date().toISOString()
  const checks: NativeCheck[] = []
  const prefix = `synloquent_spike_${Date.now()}_`
  const activeName = `${prefix}active.sqlite`
  const snapshotName = `${prefix}snapshot.sqlite`
  const pathConnection = open({ name: activeName })
  const activePath = pathConnection.getDbPath()
  pathConnection.close()
  const snapshotPath =
    activePath.slice(0, activePath.lastIndexOf('/') + 1) + snapshotName
  let database: NativeDatabaseAdapter | undefined
  let snapshot: NativeDatabaseAdapter | undefined

  async function check(
    name: string,
    callback: () => Promise<unknown>,
  ): Promise<void> {
    onProgress(name)
    const started = nativeClock.now()
    const detail = await callback()
    checks.push({
      name,
      durationMilliseconds: nativeClock.now() - started,
      detail,
    })
  }

  try {
    const runtime = globalThis as typeof globalThis & {
      HermesInternal?: unknown
    }
    assert(
      runtime.HermesInternal,
      'The spike must run under Hermes, not a Node runtime.',
    )
    database = createDatabaseAdapter({ name: activeName })
    const active = database

    await check('native SQLite and persistence configuration', async () => {
      const version = await active.execute(
        'SELECT sqlite_version() AS version, json_valid(?) AS json_supported',
        ['{"value":true}'],
      )
      const journal = await active.execute('PRAGMA journal_mode')
      const foreignKeys = await active.execute('PRAGMA foreign_keys')
      assert(journal.rows[0]?.journal_mode === 'wal', 'WAL must be enabled.')
      assert(
        foreignKeys.rows[0]?.foreign_keys === 1,
        'Foreign keys must be enabled.',
      )
      assert(
        version.rows[0]?.json_supported === 1,
        'The selected SQLite must include JSON functions.',
      )
      await active.execute(
        'CREATE TABLE parent (identity INTEGER PRIMARY KEY, name TEXT NOT NULL)',
      )
      await active.execute(
        'CREATE TABLE child (identity INTEGER PRIMARY KEY, parent_identity INTEGER NOT NULL REFERENCES parent(identity), position INTEGER NOT NULL, note TEXT)',
      )
      await active.execute(
        'CREATE INDEX child_parent_position ON child(parent_identity, position, identity)',
      )
      await active.execute(
        'CREATE TABLE pending_operation (identity TEXT PRIMARY KEY, payload TEXT NOT NULL)',
      )
      return {
        version: version.rows[0]?.version,
        journal: journal.rows[0],
        foreignKeys: foreignKeys.rows[0],
        jsonSupported: version.rows[0]?.json_supported,
        driverCapabilities: active.capabilities,
      }
    })

    await check('local data and outbox rollback together', async () => {
      let rejected = false
      try {
        await active.transaction(async (transaction) => {
          await transaction.execute('INSERT INTO parent VALUES (?, ?)', [
            1,
            'proposal',
          ])
          await transaction.execute(
            'INSERT INTO pending_operation VALUES (?, ?)',
            ['operation-one', '{"name":"proposal"}'],
          )
          throw new Error('intentional rollback')
        })
      } catch (error) {
        rejected = String(error).includes('intentional rollback')
      }
      assert(rejected, 'Rollback must reject with the original error.')
      const result = await active.execute(
        'SELECT (SELECT count(*) FROM parent) AS parents, (SELECT count(*) FROM pending_operation) AS operations',
      )
      assert(
        result.rows[0]?.parents === 0 && result.rows[0]?.operations === 0,
        'Both domain and outbox writes must roll back.',
      )
      return result.rows[0]
    })

    await check(
      'generated JSON columns preserve exact overlays and foreign keys',
      async () => {
        await active.execute(
          `CREATE TABLE generated_parent (canonical TEXT NOT NULL, proposal TEXT NOT NULL, identity TEXT GENERATED ALWAYS AS (CAST(json_extract(canonical, '$.id') AS TEXT)) VIRTUAL, note TEXT GENERATED ALWAYS AS (CASE WHEN json_type(proposal, '$.note') IS NOT NULL THEN json_extract(proposal, '$.note') ELSE json_extract(canonical, '$.note') END) VIRTUAL, UNIQUE(identity))`,
        )
        await active.execute(
          `CREATE TABLE generated_child (canonical TEXT NOT NULL, parent_identity TEXT GENERATED ALWAYS AS (CAST(json_extract(canonical, '$.parent_id') AS TEXT)) VIRTUAL REFERENCES generated_parent(identity))`,
        )
        const identity = '18446744073709551614'
        await active.transaction(async (transaction) => {
          await transaction.execute(
            'INSERT INTO generated_parent(canonical,proposal) VALUES (?,?)',
            [
              JSON.stringify({ id: identity, note: 'canonical' }),
              '{"note":null}',
            ],
          )
          await transaction.execute(
            'INSERT INTO generated_child(canonical) VALUES (?)',
            [JSON.stringify({ parent_id: identity })],
          )
        })
        const values = await active.execute(
          'SELECT identity,note FROM generated_parent',
        )
        assert(
          values.rows[0]?.identity === identity &&
            values.rows[0]?.note === null,
          'Generated columns must preserve exact text identities and explicit null proposals.',
        )
        let rejected = false
        try {
          await active.execute(
            'INSERT INTO generated_child(canonical) VALUES (?)',
            ['{"parent_id":"absent"}'],
          )
        } catch {
          rejected = true
        }
        assert(
          rejected,
          'Foreign keys must enforce generated relation columns.',
        )
        let databaseStatistics: unknown
        try {
          databaseStatistics = (
            await active.execute(
              'SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name',
            )
          ).rows
        } catch (failure) {
          databaseStatistics = { unavailable: String(failure) }
        }
        return {
          exactIdentity: identity,
          explicitNull: true,
          foreignKeys: true,
          databaseStatistics,
        }
      },
    )

    await check(
      'foreign key failures roll back their transaction',
      async () => {
        let rejected = false
        try {
          await active.transaction(async (transaction) => {
            await transaction.execute('INSERT INTO parent VALUES (?, ?)', [
              1,
              'parent',
            ])
            await transaction.execute('INSERT INTO child VALUES (?, ?, ?, ?)', [
              1,
              999,
              0,
              null,
            ])
          })
        } catch {
          rejected = true
        }
        assert(rejected, 'A missing parent must violate the foreign key.')
        const result = await active.execute(
          'SELECT count(*) AS count FROM parent',
        )
        assert(
          result.rows[0]?.count === 0,
          'The preceding parent insert must also roll back.',
        )
        return { rejected }
      },
    )

    await check('nested savepoint and scoped handle', async () => {
      await active.transaction(async (transaction) => {
        await transaction.execute('INSERT INTO parent VALUES (?, ?)', [
          1,
          'retained',
        ])
        try {
          await transaction.transaction(async (nested) => {
            await nested.execute('INSERT INTO child VALUES (?, ?, ?, ?)', [
              1,
              1,
              0,
              'rolled back',
            ])
            let blocked = false
            try {
              await transaction.execute('SELECT 1')
            } catch {
              blocked = true
            }
            assert(
              blocked,
              'The outer handle must not escape an active nested scope.',
            )
            throw new Error('nested rollback')
          })
        } catch (error) {
          assert(
            String(error).includes('nested rollback'),
            'The nested transaction must preserve its rejection.',
          )
        }
        await transaction.execute('INSERT INTO child VALUES (?, ?, ?, ?)', [
          2,
          1,
          1,
          'retained child',
        ])
        await transaction.execute(
          'INSERT INTO pending_operation VALUES (?, ?)',
          ['operation-two', '{"name":"retained"}'],
        )
      })
      const result = await active.execute(
        'SELECT parent.name, child.identity, child.position FROM parent JOIN child ON child.parent_identity = parent.identity',
      )
      assert(
        result.rows.length === 1 && result.rows[0]?.identity === 2,
        'Only the committed child must remain.',
      )
      return result.rows[0]
    })

    await check('unfinished nested work cannot escape rollback', async () => {
      let releaseNested: () => void = () => undefined
      const barrier = new Promise<void>((resolve) => {
        releaseNested = resolve
      })
      let unfinished: Promise<unknown> | undefined
      let rejected = false
      try {
        await active.transaction(async (transaction) => {
          await transaction.execute(
            'UPDATE parent SET name = ? WHERE identity = ?',
            ['unfinished parent', 1],
          )
          unfinished = transaction.transaction(async (nested) => {
            await barrier
            await nested.execute(
              'UPDATE parent SET name = ? WHERE identity = ?',
              ['escaped nested write', 1],
            )
          })
          void unfinished.catch(() => undefined)
        })
      } catch (failure) {
        rejected = String(failure).includes('Await the nested transaction')
      } finally {
        releaseNested()
      }
      let lateRejected = false
      try {
        await unfinished
      } catch {
        lateRejected = true
      }
      const retained = await active.execute(
        'SELECT name FROM parent WHERE identity = ?',
        [1],
      )
      assert(
        rejected && lateRejected && retained.rows[0]?.name === 'retained',
        'A parent must reject unfinished savepoint work, roll back and invalidate late handles.',
      )
      return {
        unfinishedParentRejected: rejected,
        lateHandleRejected: lateRejected,
        retained: retained.rows[0]?.name,
      }
    })

    await check(
      'parallel callers serialize transaction ownership',
      async () => {
        const events: string[] = []
        await Promise.all([
          active.transaction(async (transaction) => {
            events.push('first begins')
            await transaction.execute(
              'UPDATE parent SET name = ? WHERE identity = ?',
              ['first', 1],
            )
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
            events.push('first ends')
          }),
          active.transaction(async (transaction) => {
            events.push('second begins')
            const result = await transaction.execute(
              'SELECT name FROM parent WHERE identity = ?',
              [1],
            )
            assert(
              result.rows[0]?.name === 'first',
              'The next transaction must observe the committed prior write.',
            )
            events.push('second ends')
          }),
        ])
        assert(
          events.join('|') ===
            'first begins|first ends|second begins|second ends',
          'Transactions must never interleave.',
        )
        return events
      },
    )

    await check(
      'WAL-aware immutable snapshot retains pending work',
      async () => {
        await active.execute('PRAGMA wal_autocheckpoint = 0')
        await active.execute('UPDATE parent SET name = ? WHERE identity = ?', [
          'committed in WAL',
          1,
        ])
        await active.execute('VACUUM INTO ?', [snapshotPath])
        snapshot = createDatabaseAdapter({ name: snapshotName })
        const result = await snapshot.execute(
          'SELECT name FROM parent WHERE identity = ?',
          [1],
        )
        const pending = await snapshot.execute(
          'SELECT count(*) AS count FROM pending_operation',
        )
        assert(
          result.rows[0]?.name === 'committed in WAL',
          'The immutable snapshot must include committed WAL data.',
        )
        assert(
          pending.rows[0]?.count === 1,
          'Snapshot lifecycle must preserve pending work.',
        )
        await active.execute('UPDATE parent SET name = ? WHERE identity = ?', [
          'new generation',
          1,
        ])
        const unchanged = await snapshot.execute(
          'SELECT name FROM parent WHERE identity = ?',
          [1],
        )
        assert(
          unchanged.rows[0]?.name === 'committed in WAL',
          'The snapshot must remain immutable after new writes.',
        )
        return {
          snapshotIncludesWal: true,
          pendingOperations: pending.rows[0]?.count,
          immutable: true,
        }
      },
    )

    await check(
      'async native bulk import and timer responsiveness',
      async () => {
        let timerTicks = 0
        let maximumTimerGapMilliseconds = 0
        let previousTick = nativeClock.now()
        const timer = setInterval(() => {
          const current = nativeClock.now()
          maximumTimerGapMilliseconds = Math.max(
            maximumTimerGapMilliseconds,
            current - previousTick,
          )
          previousTick = current
          timerTicks += 1
        }, 4)
        const started = nativeClock.now()
        try {
          await active.transaction(async (transaction) => {
            await transaction.execute(
              "WITH RECURSIVE sequence(value) AS (SELECT 2 UNION ALL SELECT value + 1 FROM sequence WHERE value < 17000) INSERT INTO parent SELECT value, 'Catalog item ' || value FROM sequence",
            )
            await transaction.execute(
              "WITH RECURSIVE sequence(value) AS (SELECT 3 UNION ALL SELECT value + 1 FROM sequence WHERE value < 100002) INSERT INTO child SELECT value, 1 + (value % 17000), value % 7, 'Synthetic child ' || value FROM sequence",
            )
          })
          await active.execute(
            'WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 2000000) SELECT sum(value) AS total FROM sequence',
          )
          await new Promise<void>((resolve) => setTimeout(resolve, 12))
        } finally {
          clearInterval(timer)
        }
        const counts = await active.execute(
          'SELECT (SELECT count(*) FROM parent) AS parents, (SELECT count(*) FROM child) AS children',
        )
        const plan = await active.execute(
          'EXPLAIN QUERY PLAN SELECT * FROM child WHERE parent_identity = ? ORDER BY position, identity LIMIT 20',
          [1],
        )
        assert(
          counts.rows[0]?.parents === 17000 &&
            counts.rows[0]?.children === 100001,
          'The complete synthetic native catalog must be imported.',
        )
        assert(
          timerTicks > 5,
          'A long native workload must keep the JS event loop responsive.',
        )
        assert(
          plan.rows.some((row) =>
            String(row.detail).includes('child_parent_position'),
          ),
          'Relation reads must use the declared index.',
        )
        return {
          ...counts.rows[0],
          durationMilliseconds: nativeClock.now() - started,
          timerTicks,
          maximumTimerGapMilliseconds,
          queryPlan: plan.rows,
          maximumStatementDispatchMilliseconds:
            active.nativeMeasurements().maximumStatementDispatchMilliseconds,
        }
      },
    )

    await check(
      'close drains accepted work and reopen preserves durability',
      async () => {
        const update = active.execute(
          'UPDATE parent SET name = ? WHERE identity = ?',
          ['durable reopen', 1],
        )
        const started = nativeClock.now()
        await active.close()
        await update
        const closeMilliseconds = nativeClock.now() - started
        const reopenStarted = nativeClock.now()
        database = createDatabaseAdapter({ name: activeName })
        const synchronousOpenMilliseconds = nativeClock.now() - reopenStarted
        const retained = await database.execute(
          'SELECT name FROM parent WHERE identity = ?',
          [1],
        )
        const pending = await database.execute(
          'SELECT count(*) AS count FROM pending_operation',
        )
        assert(
          retained.rows[0]?.name === 'durable reopen' &&
            pending.rows[0]?.count === 1,
          'Reopen must retain committed domain and pending operation rows.',
        )
        let rejected = false
        try {
          await active.execute('SELECT 1')
        } catch {
          rejected = true
        }
        assert(rejected, 'Closed-generation handles must reject.')
        return {
          closeMilliseconds,
          synchronousOpenMilliseconds,
          synchronousNativeCloseMilliseconds:
            active.nativeMeasurements().synchronousCloseMilliseconds,
          durable: true,
          staleHandleRejected: rejected,
        }
      },
    )

    return {
      platform: Platform.OS,
      hermes: true,
      status: 'passed',
      checks,
      startedAt,
      finishedAt: new Date().toISOString(),
    }
  } catch (error) {
    return {
      platform: Platform.OS,
      hermes: Boolean(
        (globalThis as typeof globalThis & { HermesInternal?: unknown })
          .HermesInternal,
      ),
      status: 'failed',
      checks,
      error:
        error instanceof Error
          ? `${error.message}\n${error.stack ?? ''}`
          : String(error),
      startedAt,
      finishedAt: new Date().toISOString(),
    }
  } finally {
    await database?.close()
    await snapshot?.close()
    // Only this spike's uniquely named files are removed.
    for (const name of [activeName, snapshotName]) {
      const cleanup = open({ name })
      cleanup.delete()
    }
  }
}
