import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSynloquent } from '../src/index.js'
import type {
  CanonicalRecord,
  DatabaseAdapter,
  Manifest,
  SynloquentClient,
  TransactionExecutor,
} from '../src/index.js'
import { canonicalJson } from '../src/core/values.js'
import { configuration, item, manifest, snapshotFor } from './fixtures.js'

const baselineEntry = process.env.SYNLOQUENT_STAGING_BASELINE
const createClient: typeof createSynloquent = baselineEntry
  ? (await import(pathToFileURL(resolve(baselineEntry)).href)).createSynloquent
  : createSynloquent

const schema: Manifest = {
  ...manifest,
  fingerprint: 'snapshot-staging-v1',
  models: {
    ...manifest.models,
    Item: { ...manifest.models.Item!, unique: [['name']] },
    Image: {
      ...manifest.models.Image!,
      fields: {
        ...manifest.models.Image!.fields,
        item_id: {
          ...manifest.models.Image!.fields.item_id!,
          nullable: true,
          default: null,
        },
      },
      indexes: [['item_id', 'url']],
      unique: [['item_id', 'url']],
      relations: {
        item: {
          ...manifest.models.Image!.relations.item!,
          onDelete: 'cascade',
        },
      },
    },
  },
}

async function witness(client: SynloquentClient): Promise<string> {
  return client.storage.read(async (executor) => {
    const tables = [
      'syn_model_Item',
      'syn_model_Image',
      'syn_outbox',
      'syn_relation_sets',
      'syn_metadata',
    ]
    const result: Record<string, unknown> = {}
    for (const table of tables)
      result[table] = (
        await executor.execute(`SELECT * FROM "${table}" ORDER BY rowid`)
      ).rows
    return canonicalJson(result)
  })
}

function image(identity: string, parent: string | null): CanonicalRecord {
  return {
    model: 'Image',
    id: identity,
    revision: '1',
    attributes: { id: identity, item_id: parent, url: 'same.jpg' },
  }
}

test('C29 C55 C58 combined live uniqueness retains declared replay prefixes and all nonnull raw FK searches', async () => {
  const client = await createClient({ ...configuration(), schema })
  try {
    await client.sync.installSnapshot(
      snapshotFor(
        [item('1', { name: 'one' }), image('1', '1'), image('2', null)],
        schema,
      ),
    )
    const layout = await client.storage.read(async (executor) => ({
      indexes: (await executor.execute('PRAGMA index_list("syn_model_Image")'))
        .rows,
      unique: (
        await executor.execute('PRAGMA index_xinfo("syn_unique_Image_0")')
      ).rows,
      foreign: (
        await executor.execute(
          "SELECT sql FROM sqlite_master WHERE name = 'syn_foreign_index_Image_item_id'",
        )
      ).rows,
      search: (
        await executor.execute(
          'EXPLAIN QUERY PLAN SELECT * FROM syn_model_Image WHERE _partition = ? AND item_id = ?',
          [client.storage.partition, '1'],
        )
      ).rows,
    }))
    assert.ok(
      !layout.indexes.some(
        (index) => index.name === 'syn_ordered_index_Image_0',
      ),
    )
    assert.ok(
      layout.unique
        .filter((column) => column.key === 1)
        .some((column) => column.cid === -2),
    )
    assert.match(String(layout.foreign[0]?.sql), /WHERE "item_id" IS NOT NULL$/)
    assert.ok(
      layout.search.some(
        (row) =>
          String(row.detail).includes('syn_foreign_index_Image_item_id') &&
          String(row.detail).includes('item_id=?'),
      ),
    )
    await client.storage.write(async (executor, changed) => {
      await client.storage.remove('Image', '1', 'remove', executor, changed)
      await client.storage.ingest(image('3', '1'), executor, changed)
    })
    await assert.rejects(
      client.storage.write((executor, changed) =>
        client.storage.ingest(image('4', '1'), executor, changed),
      ),
      /UNIQUE/,
    )
    const bytecode = await client.storage.read(async (executor) => {
      const index = await executor.execute(
        "SELECT rootpage FROM sqlite_master WHERE name='syn_foreign_index_Image_item_id'",
      )
      const program = await executor.execute(
        'EXPLAIN DELETE FROM syn_model_Item WHERE _partition=? AND id=?',
        [client.storage.partition, '1'],
      )
      return { rootpage: index.rows[0]?.rootpage, program: program.rows }
    })
    const cursor = bytecode.program.find(
      (instruction) =>
        instruction.opcode === 'OpenRead' &&
        instruction.p2 === bytecode.rootpage,
    )?.p1
    assert.ok(
      cursor !== undefined,
      'Actual parent mutation bytecode never opened the child FK index',
    )
    assert.ok(
      bytecode.program.some(
        (instruction) =>
          instruction.p1 === cursor &&
          ['SeekGE', 'Found'].includes(String(instruction.opcode)),
      ),
    )
    await assert.rejects(
      client.storage.write(async (executor) => {
        await executor.execute(
          'UPDATE syn_model_Image SET _visible=0 WHERE _partition=?',
          [client.storage.partition],
        )
        await executor.execute(
          'DELETE FROM syn_model_Item WHERE _partition=? AND id=?',
          [client.storage.partition, '1'],
        )
      }),
      /FOREIGN KEY/,
    )

    assert.equal(await client.models.Image!.where('item_id', '1').count(), 1)
    assert.deepEqual(
      (
        await client.storage.read((executor) =>
          executor.execute('PRAGMA foreign_key_check'),
        )
      ).rows,
      [],
    )
  } finally {
    await client.close()
  }
})

test('C55 C58 unchanged snapshot rows avoid visibility churn while changed absent and pending records retain atomic semantics', async () => {
  const base = configuration()
  let visibilityChanges = 0
  let canonicalComparisons = 0
  const measured = (executor: TransactionExecutor): TransactionExecutor => ({
    async execute(statement, parameters) {
      const result = await executor.execute(statement, parameters)
      if (statement.startsWith('WITH incoming')) canonicalComparisons += 1
      if (/UPDATE "syn_model_.* SET _visible\s*=\s*0/.test(statement))
        visibilityChanges += result.changes
      return result
    },
    transaction: (callback) =>
      executor.transaction((nested) => callback(measured(nested))),
  })
  const database: DatabaseAdapter = {
    ...measured(base.database),
    capabilities: base.database.capabilities,
    transaction: (callback, mode) =>
      base.database.transaction(
        (executor) => callback(measured(executor)),
        mode,
      ),
    close: () => base.database.close(),
  }
  const client = await createClient({ ...base, database, schema })
  try {
    const original = Array.from({ length: 130 }, (_, index) =>
      item(String(index + 1), { name: `item-${index + 1}` }),
    )
    Object.freeze(original)
    await client.sync.installSnapshot(snapshotFor(original, schema))
    assert.equal(
      canonicalComparisons,
      0,
      'A fresh scalar catalog compared canonical text against empty tables',
    )
    visibilityChanges = 0
    await client.sync.installSnapshot({
      ...snapshotFor(
        original.map((record) => ({ ...record, revision: '2' })),
        schema,
      ),
      generation: 'unchanged-data',
    })
    assert.ok(
      canonicalComparisons > 0,
      'A warm staging call reused the previous empty-table decision',
    )
    assert.equal(
      visibilityChanges,
      0,
      'Canonical-equal synced rows were hidden and reindexed',
    )
    const changed = original.slice(0, -1).map((record, index) => ({
      ...record,
      revision: '3',
      attributes: {
        ...record.attributes,
        name:
          index === 0
            ? 'item-129'
            : index === 128
              ? 'item-1'
              : record.attributes.name,
      },
    }))
    await client.sync.installSnapshot(snapshotFor(changed, schema))
    assert.equal(
      (await client.models.Item!.findOrFail('1')).attributes.name,
      'item-129',
    )
    assert.equal(
      (await client.models.Item!.findOrFail('129')).attributes.name,
      'item-1',
    )
    assert.equal(await client.models.Item!.find('130'), null)
    await (await client.models.Item!.findOrFail('2')).update({ count: 9 })
    const draft = await client.models.Item!.create({ name: 'pending-draft' })
    const before = await witness(client)
    let commits = 0
    const unsubscribe = client.storage.owner.subscribe(() => {
      commits += 1
    })
    try {
      await assert.rejects(
        client.sync.installSnapshot(
          snapshotFor([...changed, image('99', '999')], schema),
        ),
        /foreign key/i,
      )
      assert.equal(await witness(client), before)
      assert.equal(commits, 0)
      await client.sync.installSnapshot(snapshotFor(changed, schema))
      assert.equal(commits, 1)
      assert.equal(
        (await client.models.Item!.findOrFail('2')).attributes.count,
        9,
      )
      assert.equal(
        (await client.models.Item!.findOrFail(draft.localIdentity)).attributes
          .name,
        'pending-draft',
      )
      const temporary = await client.storage.read((executor) =>
        executor.execute(
          "SELECT name FROM sqlite_temp_master WHERE type='table'",
        ),
      )
      assert.deepEqual(temporary.rows, [])
    } finally {
      unsubscribe()
    }
  } finally {
    await client.close()
  }
})

test('C55 cold scalar staging ignores visible rows in another partition and refreshes its comparison decision each transaction', async () => {
  const base = configuration()
  let canonicalComparisons = 0
  const measured = (executor: TransactionExecutor): TransactionExecutor => ({
    async execute(statement, parameters) {
      if (statement.startsWith('WITH incoming')) canonicalComparisons += 1
      return executor.execute(statement, parameters)
    },
    transaction: (callback) =>
      executor.transaction((nested) => callback(measured(nested))),
  })
  const database: DatabaseAdapter = {
    ...measured(base.database),
    capabilities: base.database.capabilities,
    transaction: (callback, mode) =>
      base.database.transaction(
        (executor) => callback(measured(executor)),
        mode,
      ),
    close: () => base.database.close(),
  }
  const client = await createClient({ ...base, database, schema })
  try {
    await client.sync.installSnapshot(
      snapshotFor([item('1', { name: 'foreign' })], schema),
    )
    assert.equal(canonicalComparisons, 0)
    await client.storage.write((executor) =>
      executor.execute(
        'UPDATE syn_model_Item SET _partition = ? WHERE _partition = ?',
        ['other-partition', client.storage.partition],
      ),
    )
    canonicalComparisons = 0
    const current = [item('1', { name: 'current' })]
    await client.sync.installSnapshot(snapshotFor(current, schema))
    assert.equal(
      canonicalComparisons,
      0,
      'Another partition made the empty current partition appear warm',
    )
    const foreign = await client.storage.read((executor) =>
      executor.execute(
        'SELECT _canonical, _visible FROM syn_model_Item WHERE _partition = ?',
        ['other-partition'],
      ),
    )
    assert.equal(foreign.rows.length, 1)
    assert.equal(foreign.rows[0]?._visible, 1)
    assert.equal(
      JSON.parse(String(foreign.rows[0]?._canonical)).name,
      'foreign',
    )
    await client.sync.installSnapshot(snapshotFor(current, schema))
    assert.ok(canonicalComparisons > 0)
    assert.equal(await client.models.Item!.count(), 1)
    assert.equal(
      (await client.models.Item!.findOrFail('1')).attributes.name,
      'current',
    )
  } finally {
    await client.close()
  }
})

test('C55 empty JSON models preserve nested accessor serialization errors and comparison even when a record omits JSON attributes', async () => {
  const jsonSchema: Manifest = {
    ...schema,
    fingerprint: 'staging-json-serialization',
    models: {
      ...schema.models,
      Item: {
        ...schema.models.Item!,
        fields: {
          ...schema.models.Item!.fields,
          metadata: {
            type: 'json',
            readable: true,
            writable: true,
            nullable: true,
          },
        },
      },
    },
  }
  const base = configuration()
  let canonicalComparisons = 0
  const measured = (executor: TransactionExecutor): TransactionExecutor => ({
    async execute(statement, parameters) {
      if (statement.startsWith('WITH incoming')) canonicalComparisons += 1
      return executor.execute(statement, parameters)
    },
    transaction: (callback) =>
      executor.transaction((nested) => callback(measured(nested))),
  })
  const database: DatabaseAdapter = {
    ...measured(base.database),
    capabilities: base.database.capabilities,
    transaction: (callback, mode) =>
      base.database.transaction(
        (executor) => callback(measured(executor)),
        mode,
      ),
    close: () => base.database.close(),
  }
  const client = await createClient({ ...base, database, schema: jsonSchema })
  try {
    let reads = 0
    const serializationFailure = new Error('Nested serialization failed.')
    const metadata = {
      get value() {
        reads += 1
        if (reads === 2) throw serializationFailure
        return 'validated'
      },
    }
    const before = await witness(client)
    await assert.rejects(
      client.storage.write((executor) =>
        client.storage.stageSnapshotRecords(
          [
            item('1', { metadata }),
            item('2', { price: 'invalid-later-value' }),
          ],
          executor,
        ),
      ),
      (failure) => {
        assert.equal(failure, serializationFailure)
        return true
      },
    )
    assert.equal(reads, 2)
    assert.equal(await witness(client), before)
    assert.equal(canonicalComparisons, 0)
    await client.storage.write((executor) =>
      client.storage.stageSnapshotRecords([item('1', {})], executor),
    )
    assert.equal(
      canonicalComparisons,
      1,
      'A JSON model used the scalar path because this record omitted metadata',
    )
    await client.sync.installSnapshot(
      snapshotFor([item('1', { metadata: { value: 'stored' } })], jsonSchema),
    )
    assert.deepEqual(
      (await client.models.Item!.findOrFail('1')).attributes.metadata,
      { value: 'stored' },
    )
  } finally {
    await client.close()
  }
})

test('C55 scalar cold staging preserves attribute, unknown-model, batch and capacity error priority before its presence read', async () => {
  const restricted: Manifest = {
    ...schema,
    fingerprint: 'staging-error-order',
    models: {
      ...schema.models,
      Item: {
        ...schema.models.Item!,
        fields: {
          ...schema.models.Item!.fields,
          internal: {
            type: 'string',
            nullable: true,
            readable: false,
            writable: false,
          },
        },
      },
    },
  }
  const base = configuration()
  let presenceReads = 0
  const presenceFailure = new Error('Presence lookup failed.')
  const measured = (executor: TransactionExecutor): TransactionExecutor => ({
    async execute(statement, parameters) {
      if (statement.startsWith('SELECT 1 AS present')) {
        presenceReads += 1
        throw presenceFailure
      }
      return executor.execute(statement, parameters)
    },
    transaction: (callback) =>
      executor.transaction((nested) => callback(measured(nested))),
  })
  const database: DatabaseAdapter = {
    ...measured(base.database),
    capabilities: base.database.capabilities,
    transaction: (callback, mode) =>
      base.database.transaction(
        (executor) => callback(measured(executor)),
        mode,
      ),
    close: () => base.database.close(),
  }
  const client = await createClient({ ...base, database, schema: restricted })
  try {
    const before = await witness(client)
    const stage = (records: readonly CanonicalRecord[]) =>
      client.storage.write((executor) =>
        client.storage.stageSnapshotRecords(records, executor),
      )
    await assert.rejects(
      stage([item('1', {}), item('2', { price: 'invalid' })]),
      { code: 'validation_failed' },
    )
    await assert.rejects(stage([item('1', { internal: 'forbidden' })]), {
      code: 'forbidden_field',
    })
    const malformed = item('1', { unknown: 'field' })
    const unknown: CanonicalRecord = {
      model: 'Missing',
      id: '1',
      revision: '1',
      attributes: {},
    }
    await assert.rejects(stage([malformed, unknown]), {
      code: 'unknown_model',
    })
    await assert.rejects(stage([malformed, image('1', null)]), {
      code: 'unknown_field',
    })
    await assert.rejects(
      stage([
        malformed,
        ...Array.from({ length: 63 }, (_, index) =>
          item(String(index + 2), {}),
        ),
        unknown,
      ]),
      { code: 'unknown_model' },
    )
    assert.equal(presenceReads, 0)
    assert.equal(await witness(client), before)
    await assert.rejects(stage([item('1', {})]), (failure) => {
      assert.equal(failure, presenceFailure)
      return true
    })
    assert.equal(presenceReads, 1)
    assert.equal(await witness(client), before)
  } finally {
    await client.close()
  }
  const limited = configuration()
  const capacity = await createClient({
    ...limited,
    database: {
      ...limited.database,
      capabilities: { ...limited.database.capabilities, maximumParameters: 3 },
    },
    schema: restricted,
  })
  try {
    await assert.rejects(
      capacity.storage.write((executor) =>
        capacity.storage.stageSnapshotRecords(
          [item('1', { unknown: 'field' })],
          executor,
        ),
      ),
      {
        code: 'schema_mismatch',
        message:
          'Database parameter capacity is smaller than one snapshot staging row.',
      },
    )
  } finally {
    await capacity.close()
  }
})

test('C55 all pending and aliased scalar targets can skip comparison while replay and failed-install rollback stay atomic', async () => {
  const base = configuration()
  let canonicalComparisons = 0
  const measured = (executor: TransactionExecutor): TransactionExecutor => ({
    async execute(statement, parameters) {
      if (statement.startsWith('WITH incoming')) canonicalComparisons += 1
      return executor.execute(statement, parameters)
    },
    transaction: (callback) =>
      executor.transaction((nested) => callback(measured(nested))),
  })
  const database: DatabaseAdapter = {
    ...measured(base.database),
    capabilities: base.database.capabilities,
    transaction: (callback, mode) =>
      base.database.transaction(
        (executor) => callback(measured(executor)),
        mode,
      ),
    close: () => base.database.close(),
  }
  const client = await createClient({ ...base, database, schema })
  let unsubscribe: () => void = () => undefined
  try {
    await client.sync.installSnapshot(
      snapshotFor([item('1', { name: 'retained' })], schema),
    )
    await (await client.models.Item!.findOrFail('1')).update({ count: 9 })
    const draft = await client.models.Item!.create({ name: 'pending-draft' })
    await client.storage.write((executor, changed) =>
      client.storage.ingest(
        {
          ...item('2', { name: 'server-draft' }),
          localIdentity: draft.localIdentity,
        },
        executor,
        changed,
      ),
    )
    const before = await witness(client)
    let publications = 0
    unsubscribe = client.storage.owner.subscribe(() => {
      publications += 1
    })
    canonicalComparisons = 0
    const records = [
      item('1', { name: 'retained' }),
      item('2', { name: 'server-draft' }),
    ]
    await assert.rejects(
      client.sync.installSnapshot(
        snapshotFor([...records, image('99', '999')], schema),
      ),
      /foreign key/i,
    )
    assert.equal(canonicalComparisons, 0)
    assert.equal(await witness(client), before)
    assert.equal(publications, 0)
    await client.sync.installSnapshot(snapshotFor(records, schema))
    assert.equal(canonicalComparisons, 0)
    assert.equal(publications, 1)
    assert.equal(
      (await client.models.Item!.findOrFail('1')).attributes.count,
      9,
    )
    const aliased = await client.models.Item!.findOrFail('2')
    assert.equal(aliased.localIdentity, draft.localIdentity)
    assert.equal(aliased.attributes.name, 'pending-draft')
    assert.equal(
      (await client.models.Item!.findOrFail(draft.localIdentity)).attributes
        .name,
      'pending-draft',
    )
    assert.deepEqual(
      (
        await client.storage.read((executor) =>
          executor.execute(
            "SELECT name FROM sqlite_temp_master WHERE type='table'",
          ),
        )
      ).rows,
      [],
    )
  } finally {
    unsubscribe()
    await client.close()
  }
})

test('C55 bounded snapshot staging uses primary identity searches despite a competing visibility index', async () => {
  const base = configuration()
  const plans: string[][] = []
  const traced = (executor: TransactionExecutor): TransactionExecutor => ({
    async execute(statement, parameters) {
      assert.ok((parameters?.length ?? 0) <= 25)
      if (statement.startsWith('WITH incoming'))
        plans.push(
          (
            await executor.execute(
              'EXPLAIN QUERY PLAN ' + statement,
              parameters,
            )
          ).rows.map((row) => String(row.detail)),
        )
      return executor.execute(statement, parameters)
    },
    transaction: (callback) =>
      executor.transaction((nested) => callback(traced(nested))),
  })
  const database: DatabaseAdapter = {
    ...traced(base.database),
    capabilities: { ...base.database.capabilities, maximumParameters: 25 },
    transaction: (callback, mode) =>
      base.database.transaction((executor) => callback(traced(executor)), mode),
    close: () => base.database.close(),
  }
  const indexed: Manifest = {
    ...schema,
    fingerprint: 'staging-visibility-competition',
    models: {
      ...schema.models,
      Image: { ...schema.models.Image!, indexes: [['item_id', 'url'], ['id']] },
    },
  }
  const client = await createClient({ ...base, database, schema: indexed })
  try {
    const records = [
      item('1', { name: 'one' }),
      ...Array.from({ length: 130 }, (_, position) => ({
        ...image(String(position + 1), '1'),
        attributes: {
          id: String(position + 1),
          item_id: '1',
          url: `bounded-${position}.jpg`,
        },
      })),
    ]
    await client.sync.installSnapshot(snapshotFor(records, indexed))
    plans.length = 0
    await client.sync.installSnapshot(snapshotFor(records, indexed))
    assert.ok(plans.length > 10)
    for (const details of plans) {
      assert.ok(
        details.some((detail) =>
          detail.includes('_partition=? AND _local_identity=?'),
        ),
        `Missing bounded UPDATE identity search: ${details}`,
      )
      assert.ok(
        details.some(
          (detail) =>
            detail.includes('SEARCH target') &&
            detail.includes('_partition=? AND id=?'),
        ),
        `Missing bounded incoming primary-key search: ${details}`,
      )
      assert.ok(
        !details.some(
          (detail) =>
            detail.startsWith('SCAN syn_model_') ||
            detail.startsWith('SCAN target'),
        ),
      )
    }
    assert.equal(await client.models.Image!.count(), 130)
  } finally {
    await client.close()
  }
})
