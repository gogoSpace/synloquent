import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createSynloquent, SynloquentError } from '../src/index.js'
import type {
  BindValue,
  CanonicalRecord,
  ClientConfiguration,
  DatabaseAdapter,
  Manifest,
  RelationSet,
  SynloquentClient,
  TransactionExecutor,
} from '../src/index.js'
import { canonicalJson } from '../src/core/values.js'
import { configuration, item, manifest, snapshotFor } from './fixtures.js'
import { testTransport } from './transport-fixture.js'

const baselineEntry = process.env.SYNLOQUENT_RELATION_BATCH_BASELINE
const createClient: typeof createSynloquent = baselineEntry
  ? (await import(pathToFileURL(resolve(baselineEntry)).href)).createSynloquent
  : createSynloquent

const field = { nullable: false, readable: true, writable: true }
function relationSchema(): Manifest {
  const tags = manifest.models.Item!.relations.tags!
  const pivot = {
    ...tags.pivot!,
    fields: {
      ...tags.pivot!.fields,
      note: {
        ...field,
        type: 'string' as const,
        writable: false,
        default: 'default-note',
      },
      secret: {
        ...field,
        type: 'string' as const,
        nullable: true,
        readable: false,
        writable: false,
        default: null,
      },
    },
  }
  const morphMap = { item: 'Item', archive: 'Archive' }
  return {
    ...manifest,
    fingerprint: 'snapshot-relation-batches-v1',
    models: {
      ...manifest.models,
      Item: {
        ...manifest.models.Item!,
        fields: {
          ...manifest.models.Item!.fields,
          code: { ...field, type: 'string', default: 'natural' },
        },
        relations: {
          ...manifest.models.Item!.relations,
          tags: { ...tags, pivot },
          naturalTags: {
            ...tags,
            localKey: 'code',
            pivot: {
              ...pivot,
              table: 'natural_tag',
              foreignKey: 'item_code',
            },
          },
          classifications: {
            ...tags,
            type: 'morphToMany',
            morphType: 'taggable_type',
            morphMap,
            pivot: {
              ...pivot,
              table: 'taggables',
              foreignKey: 'taggable_id',
            },
          },
        },
      },
      Tag: {
        ...manifest.models.Tag!,
        relations: {
          items: {
            type: 'belongsToMany',
            model: 'Item',
            pivot: {
              ...pivot,
              foreignKey: 'tag_id',
              relatedKey: 'item_id',
            },
          },
        },
      },
      Image: {
        ...manifest.models.Image!,
        relations: {
          item: {
            ...manifest.models.Image!.relations.item!,
            onDelete: 'restrict',
          },
        },
      },
      Archive: {
        ...manifest.models.Item!,
        table: 'archives',
        resource: 'archives',
        relations: {
          classifications: {
            ...tags,
            type: 'morphToMany',
            morphType: 'taggable_type',
            morphMap,
            pivot: {
              ...pivot,
              table: 'taggables',
              foreignKey: 'taggable_id',
            },
          },
        },
      },
    },
  }
}

function relationSet(
  parentId: string,
  targets: RelationSet['targets'] = [],
  relation = 'tags',
  model = 'Item',
  revision = '1',
): RelationSet {
  return {
    model,
    relation,
    parentId,
    revision,
    completeness: 'complete',
    targets,
  }
}
function tag(identity = '1'): CanonicalRecord {
  return {
    model: 'Tag',
    id: identity,
    revision: '1',
    attributes: { id: identity, label: `Tag ${identity}` },
  }
}
interface ExecutedStatement {
  readonly statement: string
  readonly parameters: readonly BindValue[]
  readonly rows: number
}
function measuredConfiguration(
  schema: Manifest = relationSchema(),
  maximumParameters = 999,
) {
  const original = configuration()
  const relationStatements: ExecutedStatement[] = []
  const statements: ExecutedStatement[] = []
  let relationPhase = false
  let beforeExecute:
    | ((statement: string, parameters: readonly BindValue[]) => Promise<void>)
    | undefined
  const wrap = (executor: TransactionExecutor): TransactionExecutor => ({
    async execute(statement, parameters = []) {
      assert.ok(
        parameters.length <= maximumParameters,
        `Statement binds ${parameters.length} values with capacity ${maximumParameters}`,
      )
      await beforeExecute?.(statement, parameters)
      const result = await executor.execute(statement, parameters)
      statements.push({ statement, parameters, rows: result.rows.length })
      if (relationPhase)
        relationStatements.push({
          statement,
          parameters,
          rows: result.rows.length,
        })
      return result
    },
    transaction: (callback) =>
      executor.transaction((transaction) => callback(wrap(transaction))),
  })
  const database: DatabaseAdapter = {
    ...original.database,
    capabilities: { ...original.database.capabilities, maximumParameters },
    execute: wrap(original.database).execute,
    transaction: (callback, mode) =>
      original.database.transaction(
        (transaction) => callback(wrap(transaction)),
        mode,
      ),
  }
  const settings: ClientConfiguration = {
    ...original,
    schema,
    database,
    observeSnapshotPhase(event) {
      if (event.phase === 'relationSets')
        relationPhase = event.state === 'begin'
    },
  }
  return {
    settings,
    relationStatements,
    statements,
    intercept(callback: typeof beforeExecute) {
      beforeExecute = callback
    },
  }
}
function useScalarRelations(client: SynloquentClient): void {
  Object.assign(client.storage, {
    async ingestSnapshotRelationSets(
      sets: readonly RelationSet[],
      executor: TransactionExecutor,
      changed: Set<string>,
    ) {
      for (const set of sets)
        await client.storage.ingestRelationSet(set, executor, changed)
    },
  })
}
async function stateWitness(client: SynloquentClient): Promise<string> {
  return client.storage.read(async (executor) => {
    const tables = await executor.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    const state: Record<string, unknown> = {}
    for (const row of tables.rows) {
      const name = String(row.name)
      assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/)
      const result = await executor.execute(
        `SELECT * FROM "${name}" ORDER BY rowid`,
      )
      state[name] = [...result.rows].map((entry) => canonicalJson(entry)).sort()
    }
    return canonicalJson(state)
  })
}

test('C55 snapshot relation batching bounds actual SQL for sparse sets and matches the scalar canonical catalog', async (context) => {
  const schema = relationSchema()
  const records = [
    ...Array.from({ length: 256 }, (_, position) =>
      item(String(position + 1), { code: `code-${position + 1}` }),
    ),
    tag(),
  ]
  const sets = ['tags', 'naturalTags', 'classifications'].flatMap((relation) =>
    records
      .filter((record) => record.model === 'Item')
      .map((record, position) =>
        relationSet(
          record.id,
          relation === 'tags' && position < 8
            ? [{ id: '1', attributes: { position, featured: false } }]
            : [],
          relation,
        ),
      ),
  )
  const measured = measuredConfiguration(schema)
  const scalarMeasured = measuredConfiguration(schema)
  const batch = await createClient(measured.settings)
  const scalar = await createClient(scalarMeasured.settings)
  useScalarRelations(scalar)
  let notifications = 0
  const unsubscribe = batch.storage.owner.subscribe(() => notifications++)
  try {
    const snapshot = snapshotFor(records, schema, sets)
    await scalar.sync.installSnapshot(snapshot)
    await batch.sync.installSnapshot(snapshot)
    assert.equal(await stateWitness(batch), await stateWitness(scalar))
    assert.equal(notifications, 1)
    assert.equal(
      batch.storage.owner.generation,
      scalar.storage.owner.generation,
    )
    const scalarCount = scalarMeasured.relationStatements.length
    const batchCount = measured.relationStatements.length
    context.diagnostic(
      JSON.stringify({
        sets: sets.length,
        targets: 8,
        scalarCount,
        batchCount,
      }),
    )
    assert.equal(scalarCount, 3 * sets.length + 8)
    assert.ok(
      batchCount <= 50,
      `Sparse relation import executed ${batchCount} SQL statements`,
    )
    assert.ok(
      measured.relationStatements.every(
        (entry) => entry.parameters.length <= 999,
      ),
    )
    assert.ok(measured.relationStatements.every((entry) => entry.rows <= 128))
    const lookup = measured.relationStatements.find((entry) =>
      entry.statement.startsWith('WITH requested'),
    )!
    const plan = await batch.storage.read((executor) =>
      executor.execute(
        `EXPLAIN QUERY PLAN ${lookup.statement}`,
        lookup.parameters,
      ),
    )
    const details = plan.rows.map((row) => String(row.detail))
    assert.ok(
      details.some((detail) =>
        detail.includes('_partition=? AND _local_identity=?'),
      ),
      details.join('\n'),
    )
    assert.ok(
      details.some((detail) => detail.includes('_partition=? AND id=?')),
      details.join('\n'),
    )
    assert.ok(
      !details.some((detail) => detail.startsWith('SCAN parent')),
      details.join('\n'),
    )
    context.diagnostic(JSON.stringify({ parentLookupPlan: details }))
  } finally {
    unsubscribe()
    await Promise.all([batch.close(), scalar.close()])
  }
})

test('C29 C40 C55 snapshot batches preserve directed input order effective duplicate keys morph partitions partial sets and projection defaults', async () => {
  const schema = relationSchema()
  const measured = measuredConfiguration(schema)
  const batch = await createClient(measured.settings)
  const scalar = await createClient({ ...configuration(), schema })
  useScalarRelations(scalar)
  try {
    const records = [
      ...Array.from({ length: 70 }, (_, position) =>
        item(String(position + 1), {
          code: position < 2 ? 'shared' : `code-${position + 1}`,
        }),
      ),
      tag('1'),
      tag('2'),
      { ...item('1', {}), model: 'Archive' },
    ]
    const initial = snapshotFor(
      [...records, item('71', { code: 'invisible' })],
      schema,
      [relationSet('71', [{ id: '1', attributes: {} }])],
    )
    await scalar.sync.installSnapshot(initial)
    await batch.sync.installSnapshot(initial)
    const sets = [
      ...Array.from({ length: 70 }, (_, position) =>
        relationSet(
          String(position + 1),
          position === 0 ? [{ id: '1', attributes: { position: 1 } }] : [],
        ),
      ),
      relationSet(
        '1',
        [{ id: '2', attributes: { position: 2 } }],
        'tags',
        'Item',
        '2',
      ),
      relationSet('1', [], 'items', 'Tag'),
      relationSet('1', [], 'tags'),
      relationSet('1', [
        { id: '1', attributes: { position: 5, note: 'read-only projection' } },
      ]),
      relationSet(
        '1',
        [{ id: '1', attributes: { position: 6 } }],
        'items',
        'Tag',
      ),
      relationSet(
        '1',
        [{ id: '1', attributes: { position: 7 } }],
        'naturalTags',
      ),
      relationSet(
        '2',
        [{ id: '2', attributes: { position: 8 } }],
        'naturalTags',
      ),
      relationSet(
        '1',
        [{ id: '1', attributes: { position: 11 } }],
        'classifications',
      ),
      relationSet(
        '1',
        [{ id: '2', attributes: { position: 22 } }],
        'classifications',
        'Archive',
      ),
      relationSet('1', [], 'classifications'),
      relationSet(
        '1',
        [
          { id: '1', attributes: { position: 23 } },
          { id: '1', attributes: { position: 24 } },
        ],
        'classifications',
        'Archive',
      ),
      {
        ...relationSet('3', [{ id: '2', attributes: {} }]),
        completeness: 'partial' as const,
      },
      relationSet('71', [
        { id: '1', attributes: { unexpected: 'skipped invisible parent' } },
      ]),
      relationSet('999', [
        { id: '1', attributes: { unexpected: 'skipped absent parent' } },
      ]),
    ]
    const replacement = snapshotFor(records, schema, sets)
    await scalar.sync.installSnapshot(replacement)
    await batch.sync.installSnapshot(replacement)
    assert.equal(await stateWitness(batch), await stateWitness(scalar))
    const result = await batch.storage.read(async (executor) => ({
      ordinary: (
        await executor.execute(
          'SELECT item_id,tag_id,position,note FROM syn_canonical_pivot_item_tag ORDER BY item_id',
        )
      ).rows,
      natural: (
        await executor.execute(
          'SELECT item_code,tag_id,position FROM syn_canonical_pivot_natural_tag',
        )
      ).rows,
      morph: (
        await executor.execute(
          'SELECT taggable_id,tag_id,taggable_type,position FROM syn_canonical_pivot_taggables',
        )
      ).rows,
      metadata: (
        await executor.execute(
          "SELECT parent_identity,completeness FROM syn_relation_sets WHERE model='Item' AND relation='tags' ORDER BY parent_identity",
        )
      ).rows,
    }))
    assert.deepEqual(
      result.ordinary.map((row) => ({ ...row })),
      [
        { item_id: '1', tag_id: '1', position: '6', note: 'default-note' },
        { item_id: '3', tag_id: '2', position: '0', note: 'default-note' },
      ],
    )
    assert.deepEqual(
      result.natural.map((row) => ({ ...row })),
      [{ item_code: 'shared', tag_id: '2', position: '8' }],
    )
    assert.deepEqual(
      result.morph.map((row) => ({ ...row })),
      [
        {
          taggable_id: '1',
          tag_id: '1',
          taggable_type: 'archive',
          position: '24',
        },
      ],
    )
    assert.equal(
      result.metadata.find((row) => row.parent_identity === 'c:3')
        ?.completeness,
      'partial',
    )
    assert.ok(
      !result.metadata.some((row) =>
        ['c:71', 'c:999'].includes(String(row.parent_identity)),
      ),
    )
  } finally {
    await Promise.all([batch.close(), scalar.close()])
  }
})

test('C55 relation metadata and targets respect adapter capacity across more than one target chunk', async (context) => {
  for (const capacity of [21, 999]) {
    const schema = relationSchema()
    const measured = measuredConfiguration(schema, capacity)
    const client = await createClient(measured.settings)
    try {
      const tags = Array.from({ length: 70 }, (_, position) =>
        tag(String(position + 1)),
      )
      const sets = Array.from({ length: 8 }, (_, position) =>
        relationSet(
          String(position + 1),
          position === 0
            ? tags.map((record) => ({ id: record.id, attributes: {} }))
            : [],
        ),
      )
      await client.sync.installSnapshot(
        snapshotFor(
          [
            ...Array.from({ length: 8 }, (_, position) =>
              item(String(position + 1), {}),
            ),
            ...tags,
          ],
          schema,
          sets,
        ),
      )
      const members = await (
        await client.models.Item!.findOrFail(1)
      )
        .relation('tags')
        .get()
      assert.equal(members.length, 70)
      const inserts = measured.relationStatements.filter((entry) =>
        entry.statement.startsWith('INSERT OR REPLACE'),
      )
      assert.equal(inserts.length, capacity === 21 ? 24 : 2)
      assert.ok(
        measured.statements.every(
          (entry) => entry.parameters.length <= capacity,
        ),
      )
      context.diagnostic(
        JSON.stringify({
          capacity,
          targetInsertStatements: inserts.length,
          relationStatements: measured.relationStatements.length,
        }),
      )
    } finally {
      await client.close()
    }
  }
})

test('C55 late relation errors and second chunk failure roll back canonical membership aliases outbox metadata and publication', async () => {
  const schema = relationSchema()
  const measured = measuredConfiguration(schema)
  const client = await createClient(measured.settings)
  try {
    const records = [
      ...Array.from({ length: 80 }, (_, position) =>
        item(String(position + 1), {}),
      ),
      tag(),
    ]
    await client.sync.installSnapshot(
      snapshotFor(records, schema, [
        relationSet('1', [{ id: '1', attributes: { position: 1 } }]),
      ]),
    )
    await (
      await client.models.Item!.findOrFail(1)
    )
      .relation('tags')
      .attach([1], { position: 5 })
    const original = await stateWitness(client)
    const generation = client.storage.owner.generation
    let notifications = 0
    const unsubscribe = client.storage.owner.subscribe(() => notifications++)
    try {
      const sets = records
        .filter((record) => record.model === 'Item')
        .map((record) => relationSet(record.id))
      for (const attributes of [
        { secret: 'not readable' },
        { position: 'invalid integer' },
      ]) {
        await assert.rejects(
          client.sync.installSnapshot(
            snapshotFor(records, schema, [
              ...sets,
              relationSet('1', [{ id: '1', attributes }]),
            ]),
          ),
          (error: unknown) => error instanceof SynloquentError,
        )
        assert.equal(await stateWitness(client), original)
        assert.equal(client.storage.owner.generation, generation)
        assert.equal(notifications, 0)
      }
      let metadataWrites = 0
      measured.intercept(async (statement) => {
        if (
          statement.startsWith('INSERT INTO syn_relation_sets') &&
          ++metadataWrites === 2
        )
          throw new Error('Injected second metadata chunk failure')
      })
      await assert.rejects(
        client.sync.installSnapshot({
          ...snapshotFor(
            records.map((record) =>
              record.model === 'Item'
                ? {
                    ...record,
                    attributes: {
                      ...record.attributes,
                      name: 'New generation',
                    },
                  }
                : record,
            ),
            schema,
            sets,
          ),
          generation: 'must-roll-back',
          cursor: 'must-roll-back',
        }),
        /second metadata chunk failure/,
      )
      measured.intercept(undefined)
      assert.equal(metadataWrites, 2)
      assert.equal(await stateWitness(client), original)
      assert.equal(client.storage.owner.generation, generation)
      assert.equal(notifications, 0)
      let targetWrites = 0
      measured.intercept(async (statement) => {
        if (
          statement.startsWith(
            'INSERT OR REPLACE INTO "syn_canonical_pivot_',
          ) &&
          ++targetWrites === 2
        )
          throw new Error('Injected second target chunk failure')
      })
      const manyTags = Array.from({ length: 70 }, (_, position) =>
        tag(String(position + 1)),
      )
      await assert.rejects(
        client.sync.installSnapshot(
          snapshotFor(
            [
              ...records.filter((record) => record.model !== 'Tag'),
              ...manyTags,
            ],
            schema,
            [
              relationSet(
                '1',
                manyTags.map((record) => ({ id: record.id, attributes: {} })),
              ),
            ],
          ),
        ),
        /second target chunk failure/,
      )
      measured.intercept(undefined)
      assert.equal(targetWrites, 2)
      assert.equal(await stateWitness(client), original)
      assert.equal(client.storage.owner.generation, generation)
      assert.equal(notifications, 0)
      const invalidChild = {
        model: 'Image',
        id: '1',
        revision: '1',
        attributes: { id: '1', item_id: '999', url: 'invalid.jpg' },
      }
      await assert.rejects(
        client.sync.installSnapshot(
          snapshotFor([...records, invalidChild], schema, sets),
        ),
        /foreign key/i,
      )
      assert.equal(await stateWitness(client), original)
      assert.equal(client.storage.owner.generation, generation)
      assert.equal(notifications, 0)
    } finally {
      measured.intercept(undefined)
      unsubscribe()
    }
  } finally {
    await client.close()
  }
})

test('C29 C40 C55 authoritative aliases natural owner proposals and pending pivot overlays survive repeated batched snapshots', async () => {
  const schema = relationSchema()
  const clients = await Promise.all([
    createClient({ ...configuration(), schema }),
    createClient({ ...configuration(), schema }),
  ])
  useScalarRelations(clients[1]!)
  try {
    for (const client of clients) {
      await client.sync.installSnapshot(
        snapshotFor([item('1', { code: 'existing' }), tag('1')], schema),
      )
      const draft = await client.models.Item!.create({
        name: 'Offline parent',
        code: 'proposal-key',
      })
      const draftTag = await client.models.Tag!.create({ label: 'Offline tag' })
      await draft.relation('tags').attach([draftTag], { position: 7 })
      const before = canonicalJson(
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        ),
      )
      const records = [
        item('1', { code: 'existing' }),
        tag('1'),
        {
          ...item('106', { code: 'canonical-key', name: 'Canonical parent' }),
          localIdentity: draft.localIdentity,
        },
        { ...tag('206'), localIdentity: draftTag.localIdentity },
      ]
      const sets = [
        relationSet('106', [
          { id: '1', attributes: { position: 2, note: 'read-only canonical' } },
        ]),
        relationSet(
          '106',
          [{ id: '206', attributes: { position: 3 } }],
          'naturalTags',
        ),
      ]
      for (let iteration = 0; iteration < 2; iteration++) {
        await client.sync.installSnapshot(snapshotFor(records, schema, sets))
        const parent = await client.models.Item!.findOrFail('106')
        assert.equal(parent.localIdentity, draft.localIdentity)
        assert.equal(parent.attributes.code, 'proposal-key')
        assert.equal((await parent.relation('tags').get()).length, 2)
        const metadata = await client.storage.read((executor) =>
          executor.execute(
            "SELECT parent_identity FROM syn_relation_sets WHERE model='Item' AND relation='naturalTags'",
          ),
        )
        assert.equal(metadata.rows[0]?.parent_identity, draft.localIdentity)
        const natural = await client.storage.read((executor) =>
          executor.execute(
            'SELECT item_code FROM syn_canonical_pivot_natural_tag',
          ),
        )
        assert.equal(natural.rows[0]?.item_code, 'proposal-key')
        assert.equal(
          canonicalJson(
            await client.storage.read((executor) =>
              client.storage.pending(executor),
            ),
          ),
          before,
        )
      }
    }
    assert.equal(
      await stateWitness(clients[0]!),
      await stateWitness(clients[1]!),
    )
  } finally {
    await Promise.all(clients.map((client) => client.close()))
  }
})

function barrier() {
  let signal = (): void => {}
  let resume = (): void => {}
  const started = new Promise<void>((resolve) => {
    signal = resolve
  })
  const pending = new Promise<void>((resolve) => {
    resume = resolve
  })
  return { started, pending, signal, resume }
}
test(
  'C51 C55 active relation batches retain serialized session and close boundaries without partial publication',
  { timeout: 2000 },
  async () => {
    for (const action of ['session', 'close']) {
      const schema = relationSchema()
      const measured = measuredConfiguration(schema)
      const client = await createClient(measured.settings)
      const paused = barrier()
      let notifications = 0
      const generations: number[] = []
      const unsubscribe = client.storage.owner.subscribe(
        (_changed, generation) => {
          notifications++
          generations.push(generation)
        },
      )
      let blocked = false
      measured.intercept(async (statement) => {
        if (!blocked && statement.startsWith('INSERT INTO syn_relation_sets')) {
          blocked = true
          paused.signal()
          await paused.pending
        }
      })
      try {
        const originalSession = { ...client.storage.session }
        const installation = client.sync.installSnapshot(
          snapshotFor([item('1', {}), tag()], schema, [relationSet('1')]),
        )
        await paused.started
        assert.equal(notifications, 0)
        const transition =
          action === 'session'
            ? client.setSession({
                ...originalSession,
                accountId: 'other-actor',
              })
            : client.close()
        assert.equal(
          client.storage.session.accountId,
          originalSession.accountId,
        )
        paused.resume()
        await installation
        await transition
        assert.deepEqual(generations, action === 'session' ? [1, 2] : [1])
        if (action === 'session') {
          assert.equal(await client.storage.metadata('cursor:default'), null)
          assert.equal((await client.models.Item!.get()).length, 0)
          await client.setSession(originalSession)
          assert.equal(
            await client.storage.metadata('cursor:default'),
            'cursor-1',
          )
          assert.equal((await client.models.Item!.get()).length, 1)
        }
      } finally {
        paused.resume()
        unsubscribe()
        await client.close()
      }
    }
  },
)

test('C55 schema backfill uses the same batched relation path and preserves canonical revisions', async () => {
  const schema = relationSchema()
  const next: Manifest = {
    ...schema,
    fingerprint: 'snapshot-relation-batches-v2',
  }
  const measured = measuredConfiguration(schema)
  const server = testTransport()
  server.transport.manifest = async () => next
  const records = [
    ...Array.from({ length: 80 }, (_, position) =>
      item(String(position + 1), {}),
    ),
    tag(),
  ]
  const sets = records
    .filter((record) => record.model === 'Item')
    .map((record) => relationSet(record.id, [], 'tags', 'Item', 'new-revision'))
  server.transport.snapshot = async () => snapshotFor(records, next, sets)
  const client = await createClient({
    ...measured.settings,
    transport: server.transport,
  })
  try {
    await client.sync.installSnapshot(snapshotFor(records, schema))
    measured.statements.length = 0
    assert.equal(await client.sync.updateManifest(), true)
    assert.equal(client.storage.manifest.fingerprint, next.fingerprint)
    assert.equal(
      measured.statements.filter((entry) =>
        entry.statement.startsWith('WITH requested'),
      ).length,
      2,
    )
    assert.equal(
      measured.statements.filter((entry) =>
        entry.statement.startsWith('INSERT INTO syn_relation_sets'),
      ).length,
      2,
    )
    const stored = await client.storage.read((executor) =>
      executor.execute(
        'SELECT revision,count(*) AS sets FROM syn_relation_sets GROUP BY revision',
      ),
    )
    assert.deepEqual(
      stored.rows.map((row) => ({ ...row })),
      [{ revision: 'new-revision', sets: 80 }],
    )
  } finally {
    await client.close()
  }
})

test('C29 C55 batched parent lookup keeps local identity priority string keys and exact unsafe integer decimal local keys', async () => {
  const original = relationSchema()
  const tags = original.models.Item!.relations.tags!
  const schema: Manifest = {
    ...original,
    models: {
      ...original.models,
      Item: {
        ...original.models.Item!,
        relations: {
          ...original.models.Item!.relations,
          integerTags: {
            ...tags,
            localKey: 'count',
            pivot: {
              ...tags.pivot!,
              table: 'integer_tag',
              foreignKey: 'item_count',
            },
          },
          decimalTags: {
            ...tags,
            localKey: 'price',
            pivot: {
              ...tags.pivot!,
              table: 'decimal_tag',
              foreignKey: 'item_price',
            },
          },
        },
      },
      Archive: {
        ...original.models.Archive!,
        keyType: 'string',
        incrementing: false,
        fields: {
          ...original.models.Archive!.fields,
          id: { ...field, type: 'string', writable: false },
        },
      },
    },
  }
  const clients = await Promise.all([
    createClient({ ...configuration(), schema }),
    createClient({ ...configuration(), schema }),
  ])
  useScalarRelations(clients[1]!)
  try {
    const records = [
      { ...item('1', {}), localIdentity: '2' },
      { ...item('2', {}), localIdentity: 'stable-server-two' },
      item('9007199254740993', {
        count: '9007199254740993',
        price: '90071992547409.93',
      }),
      { ...item('string-key', {}), model: 'Archive' },
      tag(),
    ]
    const sets = [
      relationSet('2', [{ id: '1', attributes: {} }]),
      relationSet('9007199254740993', [{ id: '1', attributes: {} }]),
      relationSet(
        '9007199254740993',
        [{ id: '1', attributes: {} }],
        'integerTags',
      ),
      relationSet(
        '9007199254740993',
        [{ id: '1', attributes: {} }],
        'decimalTags',
      ),
      relationSet(
        'string-key',
        [{ id: '1', attributes: {} }],
        'classifications',
        'Archive',
      ),
    ]
    for (const client of clients)
      await client.sync.installSnapshot(snapshotFor(records, schema, sets))
    assert.equal(
      await stateWitness(clients[0]!),
      await stateWitness(clients[1]!),
    )
    const actual = await clients[0]!.storage.read(async (executor) => ({
      ordinary: (
        await executor.execute(
          'SELECT item_id FROM syn_canonical_pivot_item_tag ORDER BY item_id',
        )
      ).rows,
      integer: (
        await executor.execute(
          'SELECT item_count FROM syn_canonical_pivot_integer_tag',
        )
      ).rows,
      decimal: (
        await executor.execute(
          'SELECT item_price FROM syn_canonical_pivot_decimal_tag',
        )
      ).rows,
      string: (
        await executor.execute(
          'SELECT taggable_id FROM syn_canonical_pivot_taggables',
        )
      ).rows,
      identity: (
        await executor.execute(
          "SELECT parent_identity FROM syn_relation_sets WHERE model='Item' AND relation='tags' AND parent_identity='2'",
        )
      ).rows,
    }))
    assert.deepEqual(
      actual.ordinary.map((row) => row.item_id),
      ['1', '9007199254740993'],
    )
    assert.equal(actual.integer[0]?.item_count, '9007199254740993')
    assert.equal(actual.decimal[0]?.item_price, '90071992547409.93')
    assert.equal(actual.string[0]?.taggable_id, 'string-key')
    assert.equal(actual.identity[0]?.parent_identity, '2')
  } finally {
    await Promise.all(clients.map((client) => client.close()))
  }
})

test('C40 C55 projected physical pivot keys retain scalar replace ordering through the bounded fallback', async () => {
  const original = relationSchema()
  const tags = original.models.Item!.relations.tags!
  const schema: Manifest = {
    ...original,
    models: {
      ...original.models,
      Item: {
        ...original.models.Item!,
        relations: {
          ...original.models.Item!.relations,
          tags: {
            ...tags,
            pivot: {
              ...tags.pivot!,
              fields: {
                ...tags.pivot!.fields,
                item_id: {
                  ...field,
                  type: 'string',
                  writable: false,
                  default: '2',
                },
              },
            },
          },
        },
      },
    },
  }
  const measured = measuredConfiguration(schema)
  const batch = await createClient(measured.settings)
  const scalar = await createClient({ ...configuration(), schema })
  useScalarRelations(scalar)
  try {
    const snapshot = snapshotFor(
      [item('1', {}), item('2', {}), tag()],
      schema,
      [
        relationSet('1', [{ id: '1', attributes: { item_id: '2' } }]),
        relationSet('2'),
      ],
    )
    await scalar.sync.installSnapshot(snapshot)
    await batch.sync.installSnapshot(snapshot)
    assert.equal(await stateWitness(batch), await stateWitness(scalar))
    assert.equal(measured.relationStatements.length, 7)
    const canonical = await batch.storage.read((executor) =>
      executor.execute('SELECT * FROM syn_canonical_pivot_item_tag'),
    )
    assert.equal(canonical.rows.length, 0)
  } finally {
    await Promise.all([batch.close(), scalar.close()])
  }
})

test(
  'C51 C55 close cancellation before relation staging leaves no batch SQL or partial publication',
  { timeout: 1000 },
  async () => {
    const schema = relationSchema()
    const measured = measuredConfiguration(schema)
    const paused = barrier()
    const finished = barrier()
    const originalDigest = measured.settings.digest
    const client = await createClient({
      ...measured.settings,
      digest: async (content, lifecycle) => {
        paused.signal()
        try {
          await paused.pending
          assert.equal(lifecycle?.cancelled, true)
          return await originalDigest(content, lifecycle)
        } finally {
          finished.signal()
        }
      },
    })
    let notifications = 0
    const unsubscribe = client.storage.owner.subscribe(() => notifications++)
    try {
      const installation = client.sync.installSnapshot(
        snapshotFor([item('1', {}), tag()], schema, [relationSet('1')]),
      )
      const rejected = assert.rejects(
        installation,
        (error: unknown) =>
          error instanceof SynloquentError && error.code === 'closed_database',
      )
      await paused.started
      await client.close()
      await rejected
      assert.equal(notifications, 0)
      assert.equal(measured.relationStatements.length, 0)
      paused.resume()
      await finished.started
      assert.equal(notifications, 0)
    } finally {
      paused.resume()
      unsubscribe()
      await client.close()
    }
  },
)
