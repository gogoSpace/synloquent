import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { createSynloquent } from '../src/index.js'
import type {
  Attributes,
  BindValue,
  CanonicalRecord,
  FieldDefinition,
  Manifest,
  SynloquentClient,
} from '../src/index.js'
import {
  canonicalJson,
  decimalOrder,
  integerOrder,
} from '../src/core/values.js'
import { configuration, item, manifest, snapshotFor } from './fixtures.js'
import { testTransport } from './transport-fixture.js'

// The isolated diagnostic runtime permits the same regressions to demonstrate
// failure on the preserved schema before the repair, without changing source.
const baselineEntry = process.env.SYNLOQUENT_SCHEMA_INDEX_BASELINE
const createClient: typeof createSynloquent = baselineEntry
  ? (await import(pathToFileURL(resolve(baselineEntry)).href)).createSynloquent
  : createSynloquent
const seedBaselineEntry = process.env.SYNLOQUENT_SCHEMA_INDEX_SEED_BASELINE
const createExistingClient: typeof createSynloquent = seedBaselineEntry
  ? (await import(pathToFileURL(resolve(seedBaselineEntry)).href))
      .createSynloquent
  : createClient

interface IndexLayout {
  readonly name: string
  readonly columns: readonly string[]
  readonly partial: boolean
  readonly unique: boolean
  readonly sql: string
}

async function indexLayouts(
  client: SynloquentClient,
  model: string,
): Promise<readonly IndexLayout[]> {
  return client.storage.read(async (executor) => {
    const indexes = await executor.execute(
      `PRAGMA index_list("syn_model_${model}")`,
    )
    const definitions = await executor.execute(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
      [`syn_model_${model}`],
    )
    const layouts: IndexLayout[] = []
    for (const index of indexes.rows) {
      const columns = await executor.execute(
        `PRAGMA index_xinfo("${String(index.name)}")`,
      )
      layouts.push({
        name: String(index.name),
        columns: columns.rows
          .filter((column) => column.key === 1)
          .map((column) => String(column.name)),
        partial: index.partial === 1,
        unique: index.unique === 1,
        sql: String(
          definitions.rows.find((definition) => definition.name === index.name)
            ?.sql,
        ),
      })
    }
    return layouts.sort((left, right) => left.name.localeCompare(right.name))
  })
}

function requireLayout(
  layouts: readonly IndexLayout[],
  columns: readonly string[],
  partial = false,
  unique = false,
): IndexLayout {
  const found = layouts.find(
    (layout) =>
      canonicalJson(layout.columns) === canonicalJson(columns) &&
      layout.partial === partial &&
      layout.unique === unique,
  )
  assert.ok(
    found,
    `Missing ${partial ? 'partial' : 'full'} index on ${columns}`,
  )
  return found
}

function requireForeignLayout(
  layouts: readonly IndexLayout[],
  foreignColumn: string,
): IndexLayout {
  const layout = requireLayout(layouts, ['_partition', foreignColumn], true)
  assert.ok(layout.sql.endsWith(`WHERE "${foreignColumn}" IS NOT NULL`))
  return layout
}

function requireCombinedLayout(
  layouts: readonly IndexLayout[],
  columns: readonly string[],
): IndexLayout {
  const layout = requireLayout(layouts, [...columns, 'null'], false, true)
  assert.ok(
    layout.sql.endsWith(
      'CASE WHEN _visible = 1 AND _deleted = 0 THEN 1 ELSE NULL END)',
    ),
  )
  return layout
}

async function requireValueSearch(
  client: SynloquentClient,
  statement: string,
  parameters: readonly BindValue[],
  columns: readonly string[],
): Promise<void> {
  const result = await client.storage.read((executor) =>
    executor.execute(`EXPLAIN QUERY PLAN ${statement}`, parameters),
  )
  const details = result.rows.map((row) => String(row.detail))
  assert.ok(
    details.some(
      (detail) =>
        detail.startsWith('SEARCH ') &&
        columns.every((column) => detail.includes(`${column}=?`)),
    ),
    `Expected value-bound index search on ${columns}. Actual ${details}`,
  )
  assert.ok(!details.some((detail) => detail.startsWith('SCAN ')))
}

function record(
  model: string,
  identity: string,
  attributes: Attributes,
): CanonicalRecord {
  return {
    model,
    id: identity,
    revision: '1',
    attributes: { id: identity, ...attributes },
  }
}

async function integrity(client: SynloquentClient): Promise<void> {
  const result = await client.storage.read((executor) =>
    executor.execute('PRAGMA foreign_key_check'),
  )
  assert.deepEqual(result.rows, [])
}

async function stateWitness(client: SynloquentClient): Promise<string> {
  return client.storage.read(async (executor) => {
    const rows: Record<string, unknown> = {}
    for (const model of Object.keys(client.storage.manifest.models))
      rows[model] = (
        await executor.execute(
          `SELECT _local_identity,_server_identity,_revision,_canonical,_proposal,_visible,_deleted,_state FROM "syn_model_${model}" WHERE _partition = ? ORDER BY _local_identity`,
          [client.storage.partition],
        )
      ).rows
    rows.outbox = await client.storage.pending(executor)
    return canonicalJson(rows)
  })
}

test('C29 C55 actual generated Image indexes bind raw SQLite FK and includeDeleted replay values after populated parent UPSERT', async () => {
  const schema = JSON.parse(
    await readFile(
      new URL('../../../protocol/fixtures/manifest.json', import.meta.url),
      'utf8',
    ),
  ) as Manifest
  const client = await createClient({ ...configuration(), schema })
  try {
    const parents = Array.from({ length: 4 }, (_, position) =>
      record('Item', String(position + 1), {
        title: `Indexed parent ${position + 1}`,
        category_id: null,
        active: true,
        price: '1.00',
        quantity: 0,
        metadata: null,
      }),
    )
    const children = Array.from({ length: 64 }, (_, position) =>
      record('Image', String(position + 1), {
        item_id: (position % 4) + 1,
        url: `indexed-${position + 1}.jpg`,
      }),
    )
    await client.sync.installSnapshot(
      snapshotFor([...parents, ...children], schema),
    )
    const layouts = await indexLayouts(client, 'Image')
    requireForeignLayout(layouts, 'item_id')
    const replayIndex = requireCombinedLayout(layouts, [
      '_partition',
      '_visible',
      '_order_item_id',
      'url',
    ])
    const foreignKeys = await client.storage.read((executor) =>
      executor.execute('PRAGMA foreign_key_list("syn_model_Image")'),
    )
    assert.deepEqual(
      foreignKeys.rows.map((row) => row.from),
      ['_partition', 'item_id'],
    )
    assert.ok(foreignKeys.rows.every((row) => row.on_update === 'NO ACTION'))
    assert.ok(foreignKeys.rows.every((row) => row.on_delete === 'NO ACTION'))
    await client.storage.owner.replace((executor, changed) =>
      client.storage.ingestSnapshotRecords(parents, executor, changed),
    )
    await requireValueSearch(
      client,
      'SELECT _local_identity FROM syn_model_Image WHERE _partition = ? AND item_id = ?',
      [client.storage.partition, '3'],
      ['_partition', 'item_id'],
    )
    await requireValueSearch(
      client,
      'SELECT * FROM syn_model_Image WHERE _partition = ? AND _visible = 1 AND _order_item_id IN (?,?)',
      [client.storage.partition, integerOrder('c:3'), integerOrder('3')],
      ['_partition', '_visible', '_order_item_id'],
    )
    const forced = await client.storage.read((executor) =>
      executor.execute(
        `SELECT COUNT(*) AS total FROM syn_model_Image INDEXED BY "${replayIndex.name}" WHERE _partition = ? AND _visible = 1 AND _order_item_id = ?`,
        [client.storage.partition, integerOrder('3')],
      ),
    )
    assert.equal(forced.rows[0]?.total, 16)
    assert.equal(await client.models.Image!.where('item_id', 3).count(), 16)
    const before = await stateWitness(client)
    await client.sync.installSnapshot({
      ...snapshotFor([...parents, ...children], schema),
      generation: 'populated-parent-repeat',
    })
    assert.equal(await stateWitness(client), before)
    await integrity(client)
  } finally {
    await client.close()
  }
})

function lifecycleSchema(): Manifest {
  return {
    ...manifest,
    fingerprint: 'schema-index-lifecycle',
    models: {
      ...manifest.models,
      Item: {
        ...manifest.models.Item!,
        fields: {
          ...manifest.models.Item!.fields,
          tag_id: {
            type: 'integer',
            readable: true,
            writable: true,
            nullable: true,
            default: null,
          },
        },
        relations: {
          ...manifest.models.Item!.relations,
          tag: {
            type: 'belongsTo',
            model: 'Tag',
            foreignKey: 'tag_id',
            onDelete: 'nullify',
          },
        },
      },
      Image: {
        ...manifest.models.Image!,
        indexes: [['item_id', 'url']],
        unique: [['item_id', 'url']],
        relations: {
          item: {
            type: 'belongsTo',
            model: 'Item',
            foreignKey: 'item_id',
            onDelete: 'cascade',
          },
        },
      },
    },
  }
}

test('C55 C57 C58 repeated indexed snapshot keeps pending cascade nullify independent outbox and authoritative aliases through invalid FK rollback', async () => {
  const schema = lifecycleSchema()
  const server = testTransport()
  const initial = [
    record('Tag', '90', { label: 'Nullify owner' }),
    item('100', { name: 'Cascade owner', tag_id: '90' }),
    record('Image', '200', { item_id: '100', url: 'canonical.jpg' }),
  ]
  for (const canonical of initial)
    server.records.set(`${canonical.model}:${canonical.id}`, canonical)
  const originalSnapshot = server.transport.snapshot
  server.transport.snapshot = async (request) => {
    const response = await originalSnapshot(request)
    return snapshotFor(response.records, schema, response.relationSets)
  }
  const client = await createClient({
    ...configuration(':memory:', server.transport),
    schema,
  })
  try {
    await client.sync.installSnapshot(snapshotFor(initial, schema))
    const draftParent = await client.models.Item!.create({
      name: 'Alias parent',
    })
    const draftChild = await draftParent
      .relation('images')
      .create({ url: 'alias.jpg' })
    const parentIdentity = draftParent.localIdentity
    const childIdentity = draftChild.localIdentity
    server.loseNextResponse()
    await assert.rejects(client.sync.flush(), /response lost/)
    const canonicalSnapshot = await server.transport.snapshot(
      client.sync.envelope('snapshot', { dataset: 'default' }),
    )
    await client.sync.installSnapshot(canonicalSnapshot)
    const aliased = await client.models.Item!.findOrFail(parentIdentity)
    assert.equal(aliased.localIdentity, parentIdentity)
    assert.equal(
      (await client.models.Image!.findOrFail(childIdentity)).attributes.item_id,
      aliased.id,
    )
    const child = await client.models.Image!.findOrFail('200')
    await child.update({ url: 'retained.jpg' })
    const independentOperation = child.lastOperationId!
    await (await client.models.Tag!.findOrFail('90')).delete()
    const nullified = await client.models.Item!.findOrFail('100')
    assert.equal(nullified.attributes.tag_id, null)
    assert.equal(nullified.canonicalRecord()?.attributes.tag_id, '90')
    await nullified.forceDelete()
    const outboxBefore = await client.storage.read(async (executor) =>
      canonicalJson(await client.storage.pending(executor)),
    )
    for (let repetition = 0; repetition < 2; repetition++) {
      await client.sync.installSnapshot({
        ...canonicalSnapshot,
        generation: `indexed-pending-repeat-${repetition}`,
      })
      assert.equal(await client.models.Item!.find('100'), null)
      assert.equal(await client.models.Image!.find('200'), null)
      assert.equal(await client.models.Tag!.find('90'), null)
      const retainedParent = await client.storage.read((executor) =>
        client.storage.findStored('Item', '100', executor),
      )
      assert.equal(retainedParent?.canonical.tag_id, '90')
      assert.equal(retainedParent?.proposal.tag_id, null)
      assert.equal(retainedParent?.deleted, true)
      const retained = await client.storage.read((executor) =>
        client.storage.findStored('Image', '200', executor),
      )
      assert.equal(retained?.canonical.url, 'canonical.jpg')
      assert.equal(retained?.proposal.url, 'retained.jpg')
      assert.equal(retained?.deleted, true)
      assert.equal(await client.sync.status(independentOperation), 'pending')
      assert.equal(
        (await client.models.Item!.findOrFail(parentIdentity)).localIdentity,
        parentIdentity,
      )
      assert.equal(
        (await client.models.Image!.findOrFail(childIdentity)).localIdentity,
        childIdentity,
      )
      assert.equal(
        await client.storage.read(async (executor) =>
          canonicalJson(await client.storage.pending(executor)),
        ),
        outboxBefore,
      )
      await integrity(client)
    }
    const before = await stateWitness(client)
    const generation = client.storage.owner.generation
    await assert.rejects(
      client.sync.installSnapshot(
        snapshotFor(
          [
            ...canonicalSnapshot.records,
            record('Image', '9999', { item_id: '9999', url: 'orphan.jpg' }),
          ],
          schema,
        ),
      ),
      /foreign key/i,
    )
    assert.equal(client.storage.owner.generation, generation)
    assert.equal(await stateWitness(client), before)
    await integrity(client)
  } finally {
    await client.close()
  }
})

const writableString: FieldDefinition = {
  type: 'string',
  nullable: false,
  readable: true,
  writable: true,
}
const identifier: FieldDefinition = {
  type: 'integer',
  nullable: false,
  readable: true,
  writable: false,
}

function customOwnerSchema(field: FieldDefinition): Manifest {
  return {
    ...manifest,
    fingerprint: `schema-index-custom-${field.type}`,
    models: {
      Owner: {
        resource: 'owners',
        table: 'owners',
        primaryKey: 'id',
        keyType: 'integer',
        incrementing: true,
        fields: { id: identifier, code: field, title: writableString },
        operations: ['create', 'update', 'delete'],
        indexes: [['code']],
        unique: [['code']],
        relations: {
          children: {
            type: 'hasMany',
            model: 'Child',
            foreignKey: 'owner_code',
            localKey: 'code',
          },
        },
      },
      Child: {
        resource: 'children',
        table: 'children',
        primaryKey: 'id',
        keyType: 'integer',
        incrementing: true,
        fields: {
          id: identifier,
          owner_code: { ...field, nullable: true },
          title: writableString,
        },
        operations: ['create', 'update', 'delete'],
        indexes: [['owner_code', 'title']],
        unique: [['owner_code', 'title']],
        relations: {
          owner: {
            type: 'belongsTo',
            model: 'Owner',
            foreignKey: 'owner_code',
            ownerKey: 'code',
            onDelete: 'cascade',
            onUpdate: 'restrict',
          },
        },
      },
    },
  }
}

for (const declaration of [
  { field: writableString, value: 'natural-code' },
  {
    field: { ...writableString, type: 'integer' as const },
    value: '9007199254740993',
  },
  {
    field: { ...writableString, type: 'decimal' as const, precision: 2 },
    value: '12345678901234567890.12',
  },
])
  test(`C29 C58 ${declaration.field.type} custom owner FK indexes exact reference column while hidden duplicates retain live uniqueness`, async () => {
    const schema = customOwnerSchema(declaration.field)
    const client = await createClient({ ...configuration(), schema })
    try {
      const canonical = [
        record('Owner', '1', {
          code: declaration.value,
          title: 'Historical owner',
        }),
        record('Child', '10', {
          owner_code: declaration.value,
          title: 'Reused tuple',
        }),
      ]
      await client.sync.installSnapshot(snapshotFor(canonical, schema))
      const layouts = await indexLayouts(client, 'Child')
      requireForeignLayout(layouts, '_reference_owner_code')
      const foreignKeys = await client.storage.read((executor) =>
        executor.execute('PRAGMA foreign_key_list("syn_model_Child")'),
      )
      assert.deepEqual(
        foreignKeys.rows.map((row) => [row.from, row.to]),
        [
          ['_partition', '_partition'],
          ['_reference_owner_code', '_reference_code'],
        ],
      )
      const boundCode =
        declaration.field.type === 'integer'
          ? integerOrder(declaration.value)
          : declaration.field.type === 'decimal'
            ? decimalOrder(declaration.value, declaration.field.precision!)
            : declaration.value
      await requireValueSearch(
        client,
        'SELECT _local_identity FROM syn_model_Child WHERE _partition = ? AND _reference_owner_code = ?',
        [client.storage.partition, boundCode],
        ['_partition', '_reference_owner_code'],
      )
      const orderedColumn =
        declaration.field.type === 'string' ? 'owner_code' : '_order_owner_code'
      requireCombinedLayout(
        layouts,
        declaration.field.type === 'string'
          ? ['_partition', 'owner_code', 'title']
          : ['_partition', '_visible', '_order_owner_code', 'title'],
      )
      await requireValueSearch(
        client,
        `SELECT * FROM syn_model_Child WHERE _partition = ? AND _visible = 1 AND "${orderedColumn}" = ?`,
        [client.storage.partition, boundCode],
        ['_partition', orderedColumn],
      )
      await client.storage.write(async (executor, changed) => {
        await client.storage.remove('Child', '10', 'remove', executor, changed)
        await client.storage.remove('Owner', '1', 'remove', executor, changed)
        await client.storage.ingest(
          record('Owner', '2', {
            code: declaration.value,
            title: 'Replacement owner',
          }),
          executor,
          changed,
        )
        await client.storage.ingest(
          record('Child', '20', {
            owner_code: declaration.value,
            title: 'Reused tuple',
          }),
          executor,
          changed,
        )
      })
      const referenceValues = await client.storage.read((executor) =>
        executor.execute(
          'SELECT _server_identity,_visible,_reference_owner_code FROM syn_model_Child WHERE _partition = ? ORDER BY _server_identity',
          [client.storage.partition],
        ),
      )
      assert.equal(referenceValues.rows[0]?._reference_owner_code, null)
      assert.equal(referenceValues.rows[1]?._reference_owner_code, boundCode)
      assert.equal(
        (await client.models.Child!.findOrFail('20')).attributes.owner_code,
        declaration.value,
      )
      assert.equal(
        (
          await (
            await client.models.Child!.findOrFail('20')
          )
            .relation('owner')
            .get()
        ).first()?.id,
        '2',
      )
      const before = await stateWitness(client)
      await assert.rejects(
        client.storage.write((executor, changed) =>
          client.storage.ingest(
            record('Owner', '3', {
              code: declaration.value,
              title: 'Live duplicate owner',
            }),
            executor,
            changed,
          ),
        ),
        /UNIQUE/,
      )
      await assert.rejects(
        client.storage.write((executor, changed) =>
          client.storage.ingest(
            record('Child', '21', {
              owner_code: declaration.value,
              title: 'Reused tuple',
            }),
            executor,
            changed,
          ),
        ),
        /UNIQUE/,
      )
      assert.equal(await stateWitness(client), before)
      await (await client.models.Child!.findOrFail('20')).delete()
      const replacementChild = await client.models.Child!.create({
        owner_code: declaration.value,
        title: 'Reused tuple',
      })
      assert.equal(replacementChild.attributes.owner_code, declaration.value)
      const deletedDuplicate = await client.storage.read((executor) =>
        client.storage.findStored('Child', '20', executor),
      )
      assert.equal(deletedDuplicate?.deleted, true)
      assert.equal(deletedDuplicate?.canonical.owner_code, declaration.value)
      const activeReference = await client.storage.read((executor) =>
        executor.execute(
          'SELECT _reference_owner_code FROM syn_model_Child WHERE _partition = ? AND _local_identity = ?',
          [client.storage.partition, replacementChild.localIdentity],
        ),
      )
      assert.equal(activeReference.rows[0]?._reference_owner_code, boundCode)
      await client.sync.installSnapshot(
        snapshotFor(
          [
            record('Owner', '2', {
              code: declaration.value,
              title: 'Replacement owner',
            }),
            record('Child', '20', {
              owner_code: declaration.value,
              title: 'Reused tuple',
            }),
          ],
          schema,
        ),
      )
      assert.equal(await client.models.Child!.find('20'), null)
      assert.equal(
        (await client.models.Child!.findOrFail(replacementChild.localIdentity))
          .attributes.owner_code,
        declaration.value,
      )
      await integrity(client)
    } finally {
      await client.close()
    }
  })

test('C29 string primary compound and mixed integer decimal tuple indexes preserve declaration order without inventing morph FK', async () => {
  const schema: Manifest = {
    ...manifest,
    fingerprint: 'schema-index-typed-tuples',
    models: {
      Textual: {
        resource: 'textual',
        table: 'textual',
        primaryKey: 'id',
        keyType: 'string',
        incrementing: false,
        fields: {
          id: { ...writableString, writable: false },
          label: writableString,
        },
        operations: ['query', 'create'],
        relations: {},
        indexes: [['id'], ['label', 'id'], ['id', 'label'], ['label']],
        unique: [['label']],
      },
      Mixed: {
        resource: 'mixed',
        table: 'mixed',
        primaryKey: 'id',
        keyType: 'integer',
        incrementing: true,
        fields: {
          id: identifier,
          label: writableString,
          quantity: { ...identifier, writable: true },
          amount: { ...writableString, type: 'decimal', precision: 2 },
        },
        operations: ['query', 'create'],
        relations: {},
        indexes: [
          ['label', 'quantity', 'amount'],
          ['amount', 'label'],
          ['quantity', 'label'],
        ],
        unique: [['label', 'quantity', 'amount']],
      },
      Polymorphic: {
        resource: 'polymorphic',
        table: 'polymorphic',
        primaryKey: 'id',
        keyType: 'integer',
        incrementing: true,
        fields: {
          id: identifier,
          subject_type: writableString,
          subject_id: { ...identifier, writable: true },
        },
        operations: ['query', 'create'],
        indexes: [['subject_type', 'subject_id']],
        relations: {
          subject: {
            type: 'morphTo',
            model: 'Mixed',
            foreignKey: 'subject_id',
            morphType: 'subject_type',
            morphMap: { mixed: 'Mixed' },
          },
        },
      },
    },
  }
  const client = await createClient({ ...configuration(), schema })
  try {
    await client.sync.installSnapshot(
      snapshotFor(
        [
          record('Textual', 'string-id', { label: 'Textual label' }),
          record('Mixed', '1', {
            label: 'Mixed label',
            quantity: '9007199254740993',
            amount: '12345678901234567890.12',
          }),
          record('Polymorphic', '1', {
            subject_type: 'mixed',
            subject_id: '1',
          }),
        ],
        schema,
      ),
    )
    const textual = await indexLayouts(client, 'Textual')
    requireLayout(textual, ['_partition', 'label', 'id'])
    requireLayout(textual, ['_partition', 'id', 'label'])
    requireCombinedLayout(textual, ['_partition', 'label'])
    assert.equal(
      textual.filter(
        (layout) =>
          !layout.partial &&
          canonicalJson(layout.columns) === canonicalJson(['_partition', 'id']),
      ).length,
      1,
    )
    const mixed = await indexLayouts(client, 'Mixed')
    const mixedIndex = requireCombinedLayout(mixed, [
      '_partition',
      '_visible',
      'label',
      '_order_quantity',
      '_order_amount',
    ])
    requireLayout(mixed, ['_partition', '_visible', '_order_amount', 'label'])
    requireLayout(mixed, ['_partition', '_visible', '_order_quantity', 'label'])
    await requireValueSearch(
      client,
      `SELECT _local_identity FROM syn_model_Mixed INDEXED BY "${mixedIndex.name}" WHERE _partition = ? AND _visible = 1 AND label = ? AND _order_quantity = ? AND _order_amount = ?`,
      [
        client.storage.partition,
        'Mixed label',
        integerOrder('9007199254740993'),
        decimalOrder('12345678901234567890.12', 2),
      ],
      ['_partition', '_visible', 'label', '_order_quantity', '_order_amount'],
    )
    const polymorphic = await indexLayouts(client, 'Polymorphic')
    requireLayout(polymorphic, [
      '_partition',
      '_visible',
      'subject_type',
      '_order_subject_id',
    ])
    assert.deepEqual(
      (
        await client.storage.read((executor) =>
          executor.execute('PRAGMA foreign_key_list("syn_model_Polymorphic")'),
        )
      ).rows,
      [],
    )
    assert.ok(
      !polymorphic.some((layout) =>
        layout.name.startsWith('syn_foreign_index_'),
      ),
    )
    assert.equal(
      (await client.models.Mixed!.findOrFail('1')).attributes.quantity,
      '9007199254740993',
    )
    assert.equal(
      (await client.models.Mixed!.findOrFail('1')).attributes.amount,
      '12345678901234567890.12',
    )
    await integrity(client)
  } finally {
    await client.close()
  }
})

test('C29 C55 existing database initialization adds missing complete lookup indexes and reopens idempotently without changing rows or outbox', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synloquent-schema-indexes-'))
  const filename = join(directory, 'existing.sqlite')
  const schema = lifecycleSchema()
  let client = await createExistingClient({
    ...configuration(filename),
    schema,
  })
  try {
    await client.sync.installSnapshot(
      snapshotFor(
        [
          item('1', { name: 'Reopened owner', tag_id: null }),
          record('Image', '10', { item_id: '1', url: 'reopened.jpg' }),
        ],
        schema,
      ),
    )
    await (
      await client.models.Image!.findOrFail('10')
    ).update({ url: 'retained.jpg' })
    const aliasDraft = await client.models.Item!.create({
      name: 'Retained alias proposal',
    })
    await client.storage.write((executor, changed) =>
      client.storage.ingest(
        {
          ...item('2', { name: 'Canonical alias parent', tag_id: null }),
          localIdentity: aliasDraft.localIdentity,
        },
        executor,
        changed,
      ),
    )
    const aliasIdentity = aliasDraft.localIdentity
    assert.equal(
      (await client.models.Item!.findOrFail('2')).localIdentity,
      aliasIdentity,
    )
    const cachedManifest = await client.storage.read((executor) =>
      client.storage.metadata('manifest', executor),
    )
    assert.equal(cachedManifest, canonicalJson(schema))
    const before = await stateWitness(client)
    const tableDefinition = (
      await client.storage.read((executor) =>
        executor.execute(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'syn_model_Image'",
        ),
      )
    ).rows[0]?.sql
    const layouts = await indexLayouts(client, 'Image')
    const added = layouts.filter(
      (layout) =>
        layout.name.startsWith('syn_foreign_index_') ||
        layout.name === 'syn_ordered_index_Image_0',
    )
    await client.storage.write(async (executor) => {
      for (const layout of added)
        await executor.execute(`DROP INDEX "${layout.name}"`)
    })
    await client.close()
    client = await createClient({ ...configuration(filename), schema })
    let previousLayouts = await indexLayouts(client, 'Image')
    requireForeignLayout(previousLayouts, 'item_id')
    requireCombinedLayout(previousLayouts, [
      '_partition',
      '_visible',
      '_order_item_id',
      'url',
    ])
    assert.equal(await stateWitness(client), before)
    assert.equal(
      await client.storage.read((executor) =>
        client.storage.metadata('manifest', executor),
      ),
      cachedManifest,
    )
    assert.equal(
      (await client.models.Item!.findOrFail('2')).localIdentity,
      aliasIdentity,
    )
    assert.equal(
      (await client.models.Item!.findOrFail(aliasIdentity)).attributes.name,
      'Retained alias proposal',
    )
    assert.equal(
      (
        await client.storage.read((executor) =>
          executor.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'syn_model_Image'",
          ),
        )
      ).rows[0]?.sql,
      tableDefinition,
    )
    for (let repetition = 0; repetition < 2; repetition++) {
      await client.close()
      client = await createClient({ ...configuration(filename), schema })
      const currentLayouts = await indexLayouts(client, 'Image')
      assert.deepEqual(currentLayouts, previousLayouts)
      previousLayouts = currentLayouts
      assert.equal(await stateWitness(client), before)
      assert.equal(
        await client.storage.read((executor) =>
          client.storage.metadata('manifest', executor),
        ),
        cachedManifest,
      )
      assert.equal(
        (await client.models.Item!.findOrFail('2')).localIdentity,
        aliasIdentity,
      )
      await integrity(client)
    }
  } finally {
    await client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('C29 C55 legacy table rebuild restores nonnull FK and combined unique ordered indexes after old index names disappear', async () => {
  const field = { ...identifier, nullable: true, writable: true }
  const schema: Manifest = {
    ...manifest,
    fingerprint: 'schema-index-legacy-rebuild',
    models: {
      Owner: {
        resource: 'owners',
        table: 'owners',
        primaryKey: 'id',
        keyType: 'integer',
        incrementing: true,
        fields: { id: identifier, title: writableString },
        relations: {},
        operations: ['query'],
      },
      Child: {
        resource: 'children',
        table: 'children',
        primaryKey: 'id',
        keyType: 'integer',
        incrementing: true,
        fields: { id: identifier, owner_id: field, title: writableString },
        operations: ['query'],
        indexes: [['owner_id', 'title']],
        unique: [['owner_id', 'title']],
        relations: {
          owner: {
            type: 'belongsTo',
            model: 'Owner',
            foreignKey: 'owner_id',
            onDelete: 'cascade',
          },
        },
      },
    },
  }
  const original = configuration()
  for (const model of ['Owner', 'Child'])
    await original.database.execute(
      `CREATE TABLE "syn_model_${model}" (_partition TEXT NOT NULL,_local_identity TEXT NOT NULL,_server_identity TEXT,_revision TEXT,_canonical TEXT NOT NULL,_proposal TEXT NOT NULL,_visible INTEGER NOT NULL,_deleted INTEGER NOT NULL,_state TEXT NOT NULL,id TEXT,title TEXT${model === 'Child' ? ',owner_id TEXT' : ''},PRIMARY KEY(_partition,_local_identity))`,
    )
  await original.database.execute(
    'CREATE INDEX syn_ordered_index_Child_0 ON syn_model_Child(_partition,owner_id,title)',
  )
  const partitionIdentity = canonicalJson([
    'actor-1',
    'tenant-1',
    'device-1',
    'epoch-1',
  ])
  // Legacy rows already use the selected numbered partition layout.
  await original.database.execute(
    'CREATE TABLE syn_partitions(identity TEXT NOT NULL UNIQUE,number INTEGER PRIMARY KEY AUTOINCREMENT)',
  )
  await original.database.execute(
    'INSERT INTO syn_partitions(identity) VALUES (?)',
    [partitionIdentity],
  )
  for (const canonical of [
    record('Owner', '1', { title: 'Legacy owner' }),
    record('Child', '10', { owner_id: '1', title: 'Legacy child' }),
  ])
    await original.database.execute(
      `INSERT INTO "syn_model_${canonical.model}" (_partition,_local_identity,_server_identity,_revision,_canonical,_proposal,_visible,_deleted,_state,id,title${canonical.model === 'Child' ? ',owner_id' : ''}) VALUES (?,?,?,?,?,?,?,?,?,?,?${canonical.model === 'Child' ? ',?' : ''})`,
      [
        '1',
        `c:${canonical.id}`,
        canonical.id,
        '1',
        canonicalJson(canonical.attributes),
        '{}',
        1,
        0,
        'synced',
        canonical.id,
        String(canonical.attributes.title),
        ...(canonical.model === 'Child' ? ['1'] : []),
      ],
    )
  const client = await createClient({ ...original, schema })
  try {
    requireForeignLayout(await indexLayouts(client, 'Child'), 'owner_id')
    requireCombinedLayout(await indexLayouts(client, 'Child'), [
      '_partition',
      '_visible',
      '_order_owner_id',
      'title',
    ])
    assert.equal(
      (await client.models.Child!.findOrFail('10')).attributes.title,
      'Legacy child',
    )
    assert.equal(
      (await client.models.Child!.findOrFail('10')).attributes.owner_id,
      '1',
    )
    assert.deepEqual(
      (
        await client.storage.read((executor) =>
          executor.execute(
            "SELECT name FROM sqlite_master WHERE name LIKE 'syn_legacy_%'",
          ),
        )
      ).rows,
      [],
    )
    await requireValueSearch(
      client,
      'SELECT _local_identity FROM syn_model_Child WHERE _partition = ? AND owner_id = ?',
      [client.storage.partition, '1'],
      ['_partition', 'owner_id'],
    )
    await integrity(client)
  } finally {
    await client.close()
  }
})
