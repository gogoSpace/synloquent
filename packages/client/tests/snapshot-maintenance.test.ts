import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseOwner, type DatabaseAdapter } from '../src/core/database.js'
import { openTestDatabase } from './sqlite.js'

async function fixture(
  executeMaintenance?: () => Promise<void>,
  failurePhase?: 'freelist' | 'checkpoint',
) {
  const directory = await mkdtemp(
    join(tmpdir(), 'synloquent-snapshot-maintenance-'),
  )
  const filename = join(directory, 'owned.sqlite')
  const database = openTestDatabase(filename)
  let transactionActive = false
  let closed = false
  let maintenanceCalls = 0
  let checkpointCalls = 0
  const adapter: DatabaseAdapter = {
    ...database,
    transaction: async (callback, mode) => {
      transactionActive = true
      try {
        return await database.transaction(callback, mode)
      } finally {
        transactionActive = false
      }
    },
    execute: async (statement, parameters) => {
      if (statement === 'PRAGMA freelist_count' && failurePhase === 'freelist')
        throw new Error('owned freelist inspection failure')
      if (statement === 'VACUUM') {
        maintenanceCalls += 1
        assert.equal(transactionActive, false)
        await executeMaintenance?.()
      }
      return database.execute(statement, parameters)
    },
    checkpoint: async () => {
      checkpointCalls += 1
      assert.equal(transactionActive, false)
      if (failurePhase === 'checkpoint')
        throw new Error('owned checkpoint failure')
      const result = await database.execute('PRAGMA wal_checkpoint(TRUNCATE)')
      assert.equal(result.rows[0]?.busy, 0)
    },
    close: async () => {
      closed = true
      await database.close()
    },
  }
  const owner = new DatabaseOwner(adapter)
  await database.execute('PRAGMA journal_mode=WAL')
  await database.execute(
    'CREATE TABLE records (identity TEXT PRIMARY KEY, value TEXT)',
  )
  await database.execute(
    'CREATE TABLE pending_intent (identity TEXT PRIMARY KEY, value TEXT)',
  )
  await database.execute('INSERT INTO records VALUES (?, ?)', [
    'stable',
    'Žluťoučký 🐎',
  ])
  await database.execute('INSERT INTO pending_intent VALUES (?, ?)', [
    'stable',
    'unsent proposal',
  ])
  const witness = () =>
    owner.read(async (executor) => ({
      records: (
        await executor.execute('SELECT * FROM records ORDER BY identity')
      ).rows,
      pending: (
        await executor.execute('SELECT * FROM pending_intent ORDER BY identity')
      ).rows,
      schema: (
        await executor.execute(
          "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
      ).rows,
      integrity: (await executor.execute('PRAGMA integrity_check')).rows,
      foreignKeys: (await executor.execute('PRAGMA foreign_key_check')).rows,
    }))
  const freeScratchPages = async () => {
    await owner.write(async (executor) => {
      await executor.execute('CREATE TABLE consumed_parts (payload BLOB)')
      await executor.execute(
        'WITH RECURSIVE entries(position) AS (VALUES(1) UNION ALL SELECT position+1 FROM entries WHERE position<256) INSERT INTO consumed_parts SELECT randomblob(4096) FROM entries',
      )
    })
    await database.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  }
  return {
    owner,
    database,
    filename,
    witness,
    freeScratchPages,
    get closed() {
      return closed
    },
    get maintenanceCalls() {
      return maintenanceCalls
    },
    get checkpointCalls() {
      return checkpointCalls
    },
    async cleanup() {
      try {
        await owner.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}

test('committed replacement reclaims actual SQLite pages outside its transaction and preserves the full witness', async () => {
  const state = await fixture()
  try {
    const before = await state.witness()
    await state.freeScratchPages()
    const inflatedBytes = (await stat(state.filename)).size
    let publications = 0
    state.owner.subscribe(() => {
      publications += 1
    })
    const result = await state.owner.replace(async (executor, changed) => {
      await executor.execute('DROP TABLE consumed_parts')
      changed.add('records')
      return 'committed snapshot'
    }, true)
    assert.equal(result, 'committed snapshot')
    assert.equal(state.owner.generation, 1)
    assert.equal(publications, 1)
    assert.equal(state.maintenanceCalls, 1)
    assert.equal(state.checkpointCalls, 1)
    assert.deepEqual(await state.witness(), before)
    assert((await stat(state.filename)).size < inflatedBytes)
    assert.equal(
      (await state.database.execute('PRAGMA freelist_count')).rows[0]
        ?.freelist_count,
      0,
    )
    assert.equal((await stat(state.filename + '-wal')).size, 0)
  } finally {
    await state.cleanup()
  }
})

test('ordinary replacements and snapshots with no free pages skip maintenance', async () => {
  const state = await fixture()
  try {
    assert.equal(
      (await state.database.execute('PRAGMA freelist_count')).rows[0]
        ?.freelist_count,
      0,
    )
    await state.owner.replace(async (executor) => {
      await executor.execute('UPDATE records SET value=? WHERE identity=?', [
        'first',
        'stable',
      ])
    }, true)
    assert.equal(state.maintenanceCalls, 0)
    await state.freeScratchPages()
    await state.owner.replace(async (executor) => {
      await executor.execute('DROP TABLE consumed_parts')
    })
    assert(
      Number(
        (await state.database.execute('PRAGMA freelist_count')).rows[0]
          ?.freelist_count,
      ) > 0,
    )
    assert.equal(state.maintenanceCalls, 0)
    assert.equal(state.checkpointCalls, 0)
  } finally {
    await state.cleanup()
  }
})

test('maintenance failure cannot turn a committed activation into a rollback or poison later owner work', async () => {
  const state = await fixture(async () => {
    throw new Error('owned maintenance failure')
  })
  try {
    await state.freeScratchPages()
    let publications = 0
    state.owner.subscribe(() => {
      publications += 1
    })
    const result = await state.owner.replace(async (executor, changed) => {
      await executor.execute('DROP TABLE consumed_parts')
      await executor.execute('UPDATE records SET value=? WHERE identity=?', [
        'activated',
        'stable',
      ])
      changed.add('records')
      return 'success'
    }, true)
    assert.equal(result, 'success')
    assert.equal(state.owner.generation, 1)
    assert.equal(publications, 1)
    assert.equal(state.checkpointCalls, 0)
    await state.owner.write(async (executor) => {
      await executor.execute('UPDATE records SET value=? WHERE identity=?', [
        'later durable write',
        'stable',
      ])
    })
    const witness = await state.witness()
    assert.equal(witness.records[0]?.value, 'later durable write')
    assert.equal(witness.pending[0]?.value, 'unsent proposal')
    assert.equal(witness.integrity.length, 1)
    assert.equal(witness.integrity[0]?.integrity_check, 'ok')
    assert.deepEqual(witness.foreignKeys, [])
  } finally {
    await state.cleanup()
  }
})

test('the owner holds reads and close until asynchronous post-commit maintenance drains', async () => {
  let releaseMaintenance: () => void = () => {}
  let observeMaintenance: () => void = () => {}
  const maintenanceGate = new Promise<void>((resolve) => {
    releaseMaintenance = resolve
  })
  const started = new Promise<void>((resolve) => {
    observeMaintenance = resolve
  })
  const state = await fixture(async () => {
    observeMaintenance()
    await maintenanceGate
  })
  try {
    await state.freeScratchPages()
    const replacement = state.owner.replace(async (executor) => {
      await executor.execute('DROP TABLE consumed_parts')
      return 'committed'
    }, true)
    await started
    let readStarted = false
    const read = state.owner.read(async (executor) => {
      readStarted = true
      return (await executor.execute('SELECT value FROM pending_intent'))
        .rows[0]?.value
    })
    const closing = state.owner.close()
    await Promise.resolve()
    assert.equal(readStarted, false)
    assert.equal(state.closed, false)
    releaseMaintenance()
    assert.equal(await replacement, 'committed')
    assert.equal(await read, 'unsent proposal')
    await closing
    assert.equal(state.closed, true)
  } finally {
    releaseMaintenance()
    await state.cleanup()
  }
})

for (const failurePhase of ['freelist', 'checkpoint'] as const) {
  test(`post-commit ${failurePhase} failure preserves activation and pending intent`, async () => {
    const state = await fixture(undefined, failurePhase)
    try {
      await state.freeScratchPages()
      const result = await state.owner.replace(async (executor) => {
        await executor.execute('DROP TABLE consumed_parts')
        await executor.execute('UPDATE records SET value=? WHERE identity=?', [
          'committed despite maintenance failure',
          'stable',
        ])
        return 'accepted'
      }, true)
      assert.equal(result, 'accepted')
      assert.equal(state.owner.generation, 1)
      const witness = await state.witness()
      assert.equal(
        witness.records[0]?.value,
        'committed despite maintenance failure',
      )
      assert.equal(witness.pending[0]?.value, 'unsent proposal')
      assert.equal(witness.integrity[0]?.integrity_check, 'ok')
      assert.deepEqual(witness.foreignKeys, [])
      assert.equal(state.maintenanceCalls, failurePhase === 'freelist' ? 0 : 1)
      assert.equal(state.checkpointCalls, failurePhase === 'freelist' ? 0 : 1)
    } finally {
      await state.cleanup()
    }
  })
}
