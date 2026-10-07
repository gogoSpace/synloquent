import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createSynloquent, SynloquentError } from '../src/index.js'
import type {
  BindValue,
  CanonicalRecord,
  Manifest,
  RelationSet,
  Snapshot,
  SnapshotPartsDescriptor,
  SnapshotTransferPart,
  StatementResult,
  SynloquentClient,
  TransactionExecutor,
  Transport,
} from '../src/index.js'
import { canonicalJson } from '../src/core/values.js'
import { utf8Length } from '../src/core/snapshot-content.js'
import { configuration, item, manifest, snapshotFor } from './fixtures.js'
import { testTransport } from './transport-fixture.js'

type Installation = 'ordinary' | 'parts' | 'manifest'

const upgradedManifest: Manifest = {
  ...manifest,
  fingerprint: 'installation-v2',
  schemaVersion: 2,
  models: {
    ...manifest.models,
    Item: {
      ...manifest.models.Item!,
      fields: {
        ...manifest.models.Item!.fields,
        rank: {
          type: 'integer',
          nullable: true,
          readable: true,
          writable: true,
        },
      },
    },
  },
}

function tag(identity: string): CanonicalRecord {
  return {
    model: 'Tag',
    id: identity,
    revision: '1',
    attributes: { id: identity, label: `Tag ${identity}` },
  }
}

function relations(target: string): RelationSet[] {
  return [
    {
      model: 'Item',
      parentId: '1',
      relation: 'tags',
      revision: '1',
      completeness: 'complete',
      targets: [{ id: target, attributes: { position: 1, featured: false } }],
    },
  ]
}

function partsTransport(snapshot: Snapshot) {
  const { records, relationSets, ...metadata } = snapshot
  const parts: SnapshotTransferPart[] = []
  for (const section of ['records', 'relationSets'] as const) {
    const rows = section === 'records' ? records : relationSets
    for (let firstIndex = 0; firstIndex < rows.length; firstIndex++) {
      const chunk = rows.slice(firstIndex, firstIndex + 1)
      const document = {
        format: 'canonical-parts-v1' as const,
        ordinal: parts.length,
        section,
        firstIndex,
        rowCount: 1,
        rows: chunk,
      }
      const rawDocument = canonicalJson(document)
      parts.push({
        ...document,
        rawDocument,
        rawRows: canonicalJson(chunk),
        byteSize: utf8Length(rawDocument),
        hash: createHash('sha256').update(rawDocument).digest('hex'),
      })
    }
  }
  function identity(ordinal: number) {
    const part = parts[ordinal]!
    return {
      ordinal,
      hash: part.hash,
      byteSize: part.byteSize,
      downloadUrl: `https://fixture.invalid/installation/${ordinal}`,
      continuation: `installation-${ordinal}`,
    }
  }
  const descriptor: SnapshotPartsDescriptor = {
    ...metadata,
    format: 'canonical-parts-v1',
    status: 'ready',
    partCount: parts.length,
    recordCount: records.length,
    relationSetCount: relationSets.length,
    maximumPartBytes: 65536,
    maximumRowBytes: 65536,
    partRowLimit: 256,
    firstPart: identity(0),
  }
  let confirmations = 0
  const transport: Transport = {
    ...testTransport().transport,
    snapshot: async () => {
      throw new Error('Parts installation must not use the array transport')
    },
    snapshotParts: async () => descriptor,
    snapshotPartBatch: async (request) => {
      const ordinal = request.payload.part.ordinal
      return {
        parts: (async function* () {
          yield parts[ordinal]!
        })(),
        ...(ordinal + 1 < parts.length
          ? { nextPart: identity(ordinal + 1) }
          : { confirmationToken: 'installation-confirmation' }),
      }
    },
    confirmSnapshotParts: async () => {
      confirmations++
      return { ...metadata, confirmed: true }
    },
  }
  return { transport, confirmations: () => confirmations }
}

async function installationFixture(installation: Installation) {
  const schema = installation === 'manifest' ? upgradedManifest : manifest
  const snapshot: Snapshot = {
    ...snapshotFor(
      [
        item('1', {
          name: 'New canonical',
          ...(installation === 'manifest' ? { rank: 7 } : {}),
        }),
        item('2', { name: 'Pending delete canonical' }),
        item('4', { name: 'Pending soft delete canonical' }),
        tag('10'),
        tag('11'),
        tag('12'),
      ],
      schema,
      relations('11'),
    ),
    cursor: 'replacement-cursor',
    generation: 'replacement-generation',
  }
  const parts = partsTransport(snapshot)
  const transport: Transport =
    installation === 'parts'
      ? parts.transport
      : {
          ...testTransport().transport,
          manifest: async () => schema,
          snapshot: async () => snapshot,
        }
  const settings = configuration(':memory:', transport)
  let intercept:
    | ((
        statement: string,
        parameters: readonly BindValue[],
        result: StatementResult,
      ) => Promise<StatementResult>)
    | undefined
  const wrap = (executor: TransactionExecutor): TransactionExecutor => ({
    async execute(statement, parameters = []) {
      const result = await executor.execute(statement, parameters)
      return intercept ? intercept(statement, parameters, result) : result
    },
    transaction: (callback) =>
      executor.transaction((nested) => callback(wrap(nested))),
  })
  const originalTransaction = settings.database.transaction.bind(
    settings.database,
  )
  settings.database.transaction = (callback, mode) =>
    originalTransaction((executor) => callback(wrap(executor)), mode)
  const client = await createSynloquent({
    ...settings,
    digestChunks: async (chunks) => {
      const hashing = createHash('sha256')
      for await (const chunk of chunks) hashing.update(chunk)
      return hashing.digest('hex')
    },
  })
  return {
    client,
    snapshot,
    parts,
    intercept(callback: typeof intercept) {
      intercept = callback
    },
    async install() {
      if (installation === 'ordinary')
        await client.sync.installSnapshot(snapshot)
      else if (installation === 'parts') await client.sync.resnapshot()
      else assert.equal(await client.sync.updateManifest('default'), true)
    },
  }
}

async function seed(client: SynloquentClient) {
  await client.sync.installSnapshot(
    snapshotFor(
      [
        item('1', { name: 'Original' }),
        item('2', { name: 'Hard delete' }),
        item('3', { name: 'Removed from scope' }),
        item('4', { name: 'Soft delete' }),
        tag('10'),
        tag('11'),
        tag('12'),
      ],
      manifest,
      relations('12'),
    ),
  )
  const retained = await client.models.Item!.findOrFail(1)
  await retained.update({ name: 'Pending update' })
  const removed = await client.models.Item!.findOrFail(3)
  await removed.update({ name: 'Recover this proposal' })
  await (await client.models.Item!.findOrFail(2)).forceDelete()
  await (await client.models.Item!.findOrFail(4)).delete()
  const created = await client.models.Item!.create({ name: 'Pending create' })
  const child = await created.relation('images').create({ url: 'local.jpg' })
  await retained.relation('tags').attach([10], { position: 9 })
  const pending = await client.storage.read((executor) =>
    client.storage.pending(executor),
  )
  return { retained, removed, created, child, pending }
}

async function durableState(client: SynloquentClient) {
  return client.storage.read(async (executor) => {
    const tables = await executor.execute(
      "SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'syn_%' AND name NOT LIKE 'syn_snapshot_%' ORDER BY name",
    )
    const contents: Record<string, unknown> = {}
    for (const table of tables.rows)
      contents[String(table.name)] = (
        await executor.execute(`SELECT * FROM "${String(table.name)}"`)
      ).rows
    return canonicalJson({ tables: tables.rows, contents })
  })
}

for (const installation of ['ordinary', 'parts', 'manifest'] as const) {
  test(`${installation} installation preserves pending intent identity relations recovery and snapshot metadata`, async () => {
    const fixture = await installationFixture(installation)
    const { client } = fixture
    try {
      const original = await seed(client)
      const generation = client.storage.owner.generation
      let publications = 0
      client.storage.owner.subscribe(() => publications++)
      await fixture.install()
      const retained = await client.models.Item!.findOrFail(
        original.retained.localIdentity,
      )
      assert.equal(retained.localIdentity, original.retained.localIdentity)
      assert.equal(retained.attributes.name, 'Pending update')
      assert.equal(
        (await client.models.Item!.findOrFail(original.created.localIdentity))
          .attributes.name,
        'Pending create',
      )
      assert.equal(
        (await client.models.Image!.findOrFail(original.child.localIdentity))
          .attributes.item_id,
        original.created.localIdentity,
      )
      assert.equal(await client.models.Item!.withTrashed().find(2), null)
      assert.equal(await client.models.Item!.find(4), null)
      assert.ok(
        (await client.models.Item!.withTrashed().findOrFail(4)).attributes
          .deleted_at,
      )
      assert.equal(await client.models.Item!.find(3), null)
      const related = await retained.relation('tags').get()
      assert.deepEqual(
        related
          .all()
          .map((record) => String(record.attributes.id))
          .sort(),
        ['10', '11'],
      )
      const pendingTarget = related
        .all()
        .find((record) => String(record.attributes.id) === '10')
      assert.equal(
        (pendingTarget as { pivot?: { position: number } }).pivot?.position,
        9,
      )
      assert.deepEqual(
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        ),
        original.pending,
      )
      const recovery = await client.storage.read((executor) =>
        executor.execute('SELECT * FROM syn_recovery WHERE partition=?', [
          client.storage.partition,
        ]),
      )
      assert.equal(recovery.rows.length, 1)
      assert.equal(
        recovery.rows[0]?.local_identity,
        original.removed.localIdentity,
      )
      assert.equal(recovery.rows[0]?.reason, 'snapshot_scope_removed')
      assert.deepEqual(JSON.parse(String(recovery.rows[0]?.proposal)), {
        name: 'Recover this proposal',
      })
      assert.equal(
        await client.storage.metadata('cursor:default'),
        fixture.snapshot.cursor,
      )
      assert.equal(
        await client.storage.metadata('scope'),
        canonicalJson(fixture.snapshot.scope),
      )
      assert.equal(
        await client.storage.metadata('snapshotGeneration'),
        fixture.snapshot.generation,
      )
      assert.equal(client.storage.owner.generation, generation + 1)
      assert.equal(publications, 1)
      if (installation === 'manifest') {
        assert.equal(
          client.storage.manifest.fingerprint,
          upgradedManifest.fingerprint,
        )
        assert.equal(retained.attributes.rank, 7)
      }
      if (installation === 'parts')
        assert.equal(fixture.parts.confirmations(), 1)
    } finally {
      await client.close()
    }
  })

  for (const rejection of [
    'integrity',
    'foreign keys',
    'cancellation',
  ] as const) {
    const completesActiveTransaction =
      rejection === 'cancellation' && installation !== 'parts'
    const outcome = completesActiveTransaction
      ? 'finishes its active transaction when digest verification is superseded'
      : `rolls back ${rejection} failure after final writes begin`
    test(`${installation} installation ${outcome}`, async () => {
      const fixture = await installationFixture(installation)
      const { client } = fixture
      try {
        const original = await seed(client)
        const before = await durableState(client)
        const publicManifest = client.storage.manifest
        const generation = client.storage.owner.generation
        let publications = 0
        let injected = false
        client.storage.owner.subscribe(() => publications++)
        fixture.intercept(async (statement, parameters, result) => {
          if (injected) return result
          if (
            rejection === 'integrity' &&
            statement === 'PRAGMA integrity_check'
          ) {
            injected = true
            return {
              ...result,
              rows: [{ integrity_check: 'fixture corruption' }],
            }
          }
          if (
            rejection === 'foreign keys' &&
            statement === 'PRAGMA foreign_key_check'
          ) {
            injected = true
            return {
              ...result,
              rows: [
                {
                  table: 'syn_model_Image',
                  rowid: 1,
                  parent: 'syn_model_Item',
                  fkid: 0,
                },
              ],
            }
          }
          if (
            rejection === 'cancellation' &&
            statement.startsWith('INSERT INTO syn_metadata') &&
            parameters[1] === 'cursor:default'
          ) {
            injected = true
            await client.storage.owner.verifyDigest(async () => undefined)
          }
          return result
        })
        if (completesActiveTransaction) {
          await fixture.install()
          assert.equal(injected, true)
          assert.equal(publications, 1)
          assert.equal(client.storage.owner.generation, generation + 1)
          assert.equal(
            client.storage.manifest.fingerprint,
            fixture.snapshot.schemaFingerprint,
          )
          assert.equal(
            await client.storage.metadata('cursor:default'),
            fixture.snapshot.cursor,
          )
          assert.equal(
            await client.storage.metadata('scope'),
            canonicalJson(fixture.snapshot.scope),
          )
          assert.equal(
            await client.storage.metadata('snapshotGeneration'),
            fixture.snapshot.generation,
          )
          assert.deepEqual(
            await client.storage.read((executor) =>
              client.storage.pending(executor),
            ),
            original.pending,
          )
          return
        }
        await assert.rejects(
          fixture.install(),
          (failure: unknown) =>
            failure instanceof SynloquentError &&
            failure.code ===
              (rejection === 'cancellation'
                ? 'session_changed'
                : 'snapshot_invalid'),
        )
        assert.equal(injected, true)
        assert.equal(await durableState(client), before)
        assert.equal(client.storage.manifest, publicManifest)
        assert.equal(client.storage.owner.generation, generation)
        assert.equal(publications, 0)
        fixture.intercept(undefined)
        if (installation === 'parts' && rejection === 'cancellation') {
          const acquisition = await client.storage.read((executor) =>
            executor.execute(
              'SELECT COUNT(*) AS count FROM syn_snapshot_acquisitions',
            ),
          )
          assert.equal(acquisition.rows[0]?.count, 1)
          await fixture.install()
          assert.equal(
            await client.storage.metadata('snapshotGeneration'),
            fixture.snapshot.generation,
          )
        }
      } finally {
        await client.close()
      }
    })
  }
}
