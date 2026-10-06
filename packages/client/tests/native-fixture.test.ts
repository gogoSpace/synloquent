import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import typescript from 'typescript'
import * as clientApi from '../src/index.js'
import type {
  CanonicalRecord,
  DatabaseAdapter,
  Envelope,
  Manifest,
  RelationSet,
  Snapshot,
  SnapshotMetadata,
  SnapshotTransferPart,
  Transport,
} from '../src/index.js'
import { canonicalJson } from '../src/core/values.js'
import { configuration } from './fixtures.js'
import { openTestDatabase } from './sqlite.js'

interface FixtureInput {
  readonly metadata: SnapshotMetadata
  readonly recordCount: number
  readonly relationSetCount: number
  readonly partCount: number
  readonly maximumRowBytes: number
  readonly databaseBytes: number
  parts(): AsyncIterable<SnapshotTransferPart>
  records(): AsyncIterable<readonly CanonicalRecord[]>
  relationSets(): AsyncIterable<readonly RelationSet[]>
  transport(generation: () => string): Transport
  close(): Promise<void>
}
type Client = Awaited<ReturnType<typeof clientApi.createSynloquent>>
type Input = FixtureInput | Snapshot
interface Reference {
  snapshotContent(input: Input): Promise<{ hash: string; byteSize: number }>
  preparePendingCatalog(client: Client, input: Input): Promise<unknown>
  installReferenceSnapshot(client: Client, input: Input): Promise<unknown>
}
const digest = async (content: string) =>
  createHash('sha256').update(content).digest('hex')
const digestChunks = async (source: AsyncIterable<string>) => {
  const hash = createHash('sha256')
  for await (const chunk of source) hash.update(chunk)
  return hash.digest('hex')
}
const platform = {
  canonicalJson,
  digest,
  digestChunks,
  encodeUtf8: (content: string) => Buffer.from(content),
  yieldToApplication: async () => undefined,
  observeNativeContinuation: () => undefined,
  nativeClock: { now: () => performance.now() },
  setApplicationWorkPhase: () => undefined,
}
async function evaluate<Exported>(
  filename: URL,
  dependencies: Record<string, unknown>,
): Promise<Exported> {
  const compiled = typescript.transpileModule(
    await readFile(filename, 'utf8'),
    {
      compilerOptions: {
        target: typescript.ScriptTarget.ES2022,
        module: typescript.ModuleKind.CommonJS,
      },
    },
  ).outputText
  const exported = {}
  new Function('require', 'exports', compiled)((name: string) => {
    if (!(name in dependencies))
      throw new Error(`Unexpected source dependency ${name}`)
    return dependencies[name]
  }, exported)
  return exported as Exported
}
async function harness(options: { failDigest?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'synloquent-native-fixture-'))
  const databases = new Map<string, DatabaseAdapter>()
  const deleted: string[] = []
  const statements: string[] = []
  const schema: Manifest = JSON.parse(
    await readFile(
      new URL('../../../protocol/fixtures/manifest.json', import.meta.url),
      'utf8',
    ),
  )
  const source = await evaluate<{
    createNativeFixture(
      name: string,
      schema: Manifest,
      sizes?: { items: number; images: number },
    ): Promise<FixtureInput>
  }>(
    new URL(
      '../../../examples/react-native/src/nativeFixture.ts',
      import.meta.url,
    ),
    {
      '@synloquent/client/sqlite': {
        createDatabaseAdapter({ name }: { name: string }) {
          const database = openTestDatabase(join(directory, name))
          const observed: DatabaseAdapter = {
            ...database,
            async execute(statement, parameters) {
              statements.push(statement)
              return database.execute(statement, parameters)
            },
          }
          databases.set(name, observed)
          return observed
        },
      },
      './platform': {
        ...platform,
        digest: options.failDigest
          ? async () => {
              throw new Error('controlled digest failure')
            }
          : digest,
      },
      './nativeQualification': {
        deleteDatabase(name: string) {
          deleted.push(name)
          unlinkSync(join(directory, name))
        },
      },
    },
  )
  const reference = await evaluate<Reference>(
    new URL(
      '../../../examples/react-native/src/nativeReference.ts',
      import.meta.url,
    ),
    { '@synloquent/client': clientApi, './platform': platform },
  )
  let sequence = 0
  return {
    schema,
    databases,
    deleted,
    statements,
    directory,
    reference,
    create: (sizes?: { items: number; images: number }) =>
      source.createNativeFixture(`input-${++sequence}.sqlite`, schema, sizes),
    async close() {
      for (const database of databases.values()) await database.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function envelope<Payload>(
  schema: Manifest,
  payload: Payload,
): Envelope<Payload> {
  return {
    protocolVersion: 1,
    requestId: 'fixture-control',
    kind: 'snapshot',
    schemaFingerprint: schema.fingerprint,
    session: {
      accountId: 'actor-1',
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      deviceEpoch: 'epoch-1',
      generation: 1,
    },
    payload,
  }
}
async function state(client: Client) {
  return client.storage.read(async (executor) => {
    const tables = Object.keys(client.storage.manifest.models).map(
      (model) => `syn_model_${model}`,
    )
    tables.push(
      'syn_relation_sets',
      'syn_pivot_item_tag',
      'syn_canonical_pivot_item_tag',
    )
    const rows: Record<string, unknown> = {}
    for (const table of tables) {
      const selected = (
        await executor.execute(`SELECT * FROM "${table}" ORDER BY 1,2,3`)
      ).rows
      rows[table] = {
        count: selected.length,
        hash: await digest(canonicalJson(selected)),
      }
    }
    rows.metadata = (
      await executor.execute(
        'SELECT * FROM syn_metadata ORDER BY partition,key',
      )
    ).rows
    rows.pending = await client.storage.pending(executor)
    const schema = (
      await executor.execute(
        "SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'syn_%' ORDER BY type,name",
      )
    ).rows
    rows.schema = {
      count: schema.length,
      hash: await digest(canonicalJson(schema)),
    }
    return rows
  })
}

test('native fixture retains the exact original 117115/100/300 catalog in immutable bounded SQLite parts', async () => {
  const fixture = await harness()
  const input = await fixture.create()
  try {
    assert.equal(input.recordCount, 117115)
    assert.equal(input.relationSetCount, 100)
    // Golden obtained from the preserved original fixture() and snapshotContent().
    // It includes every original field, exact decimal, null, false, identity and order.
    assert.equal(
      input.metadata.hash,
      '91789cdb48a8415c597c8513aee5d9d2dd78d5d5095420fb282f4360a6f2763b',
    )
    assert.equal(input.metadata.byteSize, 19291810)
    assert.deepEqual(await fixture.reference.snapshotContent(input), {
      hash: input.metadata.hash,
      byteSize: input.metadata.byteSize,
    })
    let records = 0
    let sets = 0
    let targets = 0
    let ordinal = 0
    const models: Record<string, number> = {}
    for await (const part of input.parts()) {
      assert.equal(part.ordinal, ordinal++)
      assert.ok(part.rowCount <= 256 && part.byteSize <= 65536)
      assert.equal(await digest(part.rawDocument), part.hash)
      if (part.section === 'records') {
        for (const record of part.rows as readonly CanonicalRecord[]) {
          models[record.model] = (models[record.model] ?? 0) + 1
          records += 1
          if (record.model === 'Item' && record.id === '7') {
            assert.equal(record.attributes.active, false)
            assert.equal(record.attributes.price, '7.07')
            assert.equal(record.attributes.metadata, null)
          }
          if (record.model === 'Image' && record.id === '100001') {
            assert.equal(record.attributes.url, 'image-20261002-100001.jpg')
            assert.equal(record.attributes.item_id, 15002)
          }
        }
      } else {
        for (const set of part.rows as readonly RelationSet[]) {
          sets += 1
          targets += set.targets.length
        }
      }
    }
    assert.deepEqual(models, {
      Category: 50,
      Tag: 64,
      Item: 17000,
      Image: 100001,
    })
    assert.deepEqual(
      [records, sets, targets, ordinal],
      [117115, 100, 300, input.partCount],
    )
    let repeated = 0
    for await (const page of input.records()) {
      assert.ok(page.length <= 64)
      repeated += page.length
    }
    assert.equal(repeated, records)
    assert.ok(input.databaseBytes >= input.metadata.byteSize)
    const database = fixture.databases.get('input-1.sqlite')!
    await assert.rejects(
      database.execute('DELETE FROM fixture_parts'),
      /readonly/,
    )
    assert.ok(
      fixture.statements
        .filter((statement) => statement.includes('bounded_document'))
        .every((statement) => !statement.includes('SELECT *')),
    )
  } finally {
    await input.close()
    await input.close()
    assert.deepEqual(fixture.deleted, ['input-1.sqlite'])
    assert.deepEqual(await readdir(fixture.directory), [])
    await fixture.close()
  }
})

for (const pending of [false, true])
  test(`the actual public parts SDK and independent SQL reference preserve complete rollback state with pending=${pending}`, async () => {
    const fixture = await harness()
    const input = await fixture.create({ items: 100, images: 25 })
    let generation = input.metadata.generation
    const makeClient = () =>
      clientApi.createSynloquent({
        ...configuration(),
        schema: fixture.schema,
        transport: input.transport(() => generation),
        digestChunks,
      })
    const sdk = await makeClient()
    const reference = await makeClient()
    try {
      if (pending) {
        await fixture.reference.preparePendingCatalog(sdk, input)
        await fixture.reference.preparePendingCatalog(reference, input)
      }
      await sdk.sync.resnapshot('catalog')
      await fixture.reference.installReferenceSnapshot(reference, input)
      assert.deepEqual(await state(sdk), await state(reference))
      for (let repetition = 0; repetition < 2; repetition += 1) {
        generation = `native-repeat-${repetition}`
        await sdk.sync.resnapshot('catalog')
        assert.equal(
          await sdk.storage.read((executor) =>
            sdk.storage.metadata('snapshotGeneration', executor),
          ),
          generation,
        )
        assert.equal(await sdk.models.Item!.count(), 100)
        assert.equal(await sdk.storage.owner.listenerCount, 0)
      }
      const sdkBefore = await state(sdk)
      const referenceBefore = await state(reference)
      const records: CanonicalRecord[] = [
        {
          model: 'Image',
          id: '1',
          revision: '2',
          attributes: {
            id: 1,
            item_id: 999999,
            url: 'invalid-foreign-key.jpg',
            created_at: null,
            updated_at: null,
          },
        },
      ]
      const content = canonicalJson({ records, relationSets: [] })
      const invalid: Snapshot = {
        ...input.metadata,
        records,
        relationSets: [],
        generation: 'native-rejected-snapshot',
        hash: await digest(content),
        byteSize: Buffer.byteLength(content),
      }
      await assert.rejects(sdk.sync.installSnapshot(invalid))
      await assert.rejects(
        fixture.reference.installReferenceSnapshot(reference, invalid),
      )
      assert.deepEqual(await state(sdk), sdkBefore)
      assert.deepEqual(await state(reference), referenceBefore)
      if (pending) {
        const deleted = await sdk.models.Item!.find('3')
        assert.equal(deleted, null)
        assert.equal(await sdk.models.Image!.where('item_id', 3).count(), 0)
        assert.equal(
          (await sdk.storage.read((executor) => sdk.storage.pending(executor)))
            .length,
          3,
        )
      }
    } finally {
      await sdk.close()
      await reference.close()
      await input.close()
      await fixture.close()
    }
  })

test('fixture descriptor, continuation, generation, cancellation and close reject stale reads', async () => {
  const fixture = await harness()
  const input = await fixture.create({ items: 3, images: 0 })
  let generation = 'first'
  const transport = input.transport(() => generation)
  try {
    const descriptor = await transport.snapshotParts!(
      envelope(fixture.schema, { dataset: 'catalog' }),
    )
    assert.ok(descriptor.firstPart)
    const request = envelope(fixture.schema, {
      descriptor,
      part: descriptor.firstPart,
    })
    const batch = await transport.snapshotPartBatch!(request)
    const iterator = batch.parts[Symbol.asyncIterator]()
    generation = 'second'
    await assert.rejects(iterator.next(), /generation changed/)
    await assert.rejects(
      transport.snapshotPartBatch!(request),
      /descriptor changed/,
    )
    await assert.rejects(
      transport.snapshotParts!(envelope(fixture.schema, { dataset: 'other' })),
      /dataset differs/,
    )
    await assert.rejects(
      transport.snapshotParts!(
        envelope(fixture.schema, { dataset: 'catalog' }),
        { cancelled: true, subscribe: () => () => undefined },
      ),
      /cancelled/,
    )
    const current = await transport.snapshotParts!(
      envelope(fixture.schema, { dataset: 'catalog' }),
    )
    await assert.rejects(
      transport.snapshotPartBatch!(
        envelope(fixture.schema, {
          descriptor: current,
          part: { ...current.firstPart!, ordinal: -1 },
        }),
      ),
      /ordinal/,
    )
    await assert.rejects(
      transport.confirmSnapshotParts!(
        envelope(fixture.schema, {
          descriptor: current,
          confirmationToken: 'wrong',
        }),
      ),
      /confirmation/,
    )
    await input.close()
    await assert.rejects(input.parts()[Symbol.asyncIterator]().next(), /closed/)
    await assert.rejects(
      transport.snapshotParts!(
        envelope(fixture.schema, { dataset: 'catalog' }),
      ),
      /closed/,
    )
  } finally {
    await input.close()
    await fixture.close()
  }
})

test('oversized or corrupt durable input is bounded and rejected by the independent reference and SDK', async () => {
  const fixture = await harness()
  const input = await fixture.create({ items: 3, images: 1 })
  const database = fixture.databases.get('input-1.sqlite')!
  const sdk = await clientApi.createSynloquent({
    ...configuration(),
    schema: fixture.schema,
    transport: input.transport(() => input.metadata.generation),
    digestChunks,
  })
  try {
    await database.execute('PRAGMA query_only=OFF')
    await database.execute('UPDATE fixture_parts SET hash=? WHERE ordinal=0', [
      '0'.repeat(64),
    ])
    await assert.rejects(fixture.reference.snapshotContent(input), /integrity/)
    await assert.rejects(sdk.sync.resnapshot('catalog'))
    assert.equal(await sdk.models.Item!.allowPartial().count(), 0)
    await database.execute(
      'UPDATE fixture_parts SET raw_document=? WHERE ordinal=0',
      ['x'.repeat(65537)],
    )
    await assert.rejects(
      input.parts()[Symbol.asyncIterator]().next(),
      /oversized/,
    )
    assert.ok(
      fixture.statements
        .filter((statement) => statement.includes('bounded_document'))
        .every((statement) =>
          statement.startsWith('SELECT section,first_index'),
        ),
    )
  } finally {
    await sdk.close()
    await input.close()
    await fixture.close()
  }
})

test('fixture construction failure closes and deletes only its exact owned SQLite input', async () => {
  const fixture = await harness({ failDigest: true })
  try {
    await assert.rejects(
      fixture.create({ items: 3, images: 1 }),
      /controlled digest failure/,
    )
    assert.deepEqual(fixture.deleted, ['input-1.sqlite'])
    assert.deepEqual(await readdir(fixture.directory), [])
    await assert.rejects(
      fixture.databases.get('input-1.sqlite')!.execute('SELECT 1'),
      /closed/,
    )
    await assert.rejects(
      fixture.create({ items: 0, images: 1 }),
      /Invalid deterministic fixture size/,
    )
    assert.equal(fixture.databases.size, 1)
  } finally {
    await fixture.close()
  }
})

test('bounded independent reference rejects duplicate source identities and rolls back all data', async () => {
  const fixture = await harness()
  const input = await fixture.create({ items: 3, images: 1 })
  const database = fixture.databases.get('input-1.sqlite')!
  const client = await clientApi.createSynloquent({
    ...configuration(),
    schema: fixture.schema,
  })
  try {
    const first = await input.parts()[Symbol.asyncIterator]().next()
    assert.ok(!first.done && first.value.section === 'records')
    const part = first.value
    const rows = [...part.rows, part.rows[0]!]
    const rawDocument = canonicalJson({
      format: part.format,
      ordinal: part.ordinal,
      section: part.section,
      firstIndex: part.firstIndex,
      rowCount: rows.length,
      rows,
    })
    await database.execute('PRAGMA query_only=OFF')
    await database.execute(
      'UPDATE fixture_parts SET row_count=?,hash=?,byte_size=?,raw_document=? WHERE ordinal=0',
      [
        rows.length,
        await digest(rawDocument),
        Buffer.byteLength(rawDocument),
        rawDocument,
      ],
    )
    let controlled: FixtureInput = {
      ...input,
      recordCount: input.recordCount + 1,
    }
    controlled = {
      ...controlled,
      metadata: {
        ...input.metadata,
        ...(await fixture.reference.snapshotContent(controlled)),
      },
    }
    const before = await state(client)
    await assert.rejects(
      fixture.reference.installReferenceSnapshot(client, controlled),
      /duplicate reference identity/,
    )
    assert.deepEqual(await state(client), before)
    const temporary = await client.storage.read((executor) =>
      executor.execute(
        "SELECT name FROM sqlite_temp_master WHERE name IN ('syn_reference_identities','syn_snapshot_membership')",
      ),
    )
    assert.deepEqual(temporary.rows, [])
  } finally {
    await client.close()
    await input.close()
    await fixture.close()
  }
})

test('independent reference handles bounded input model switches and a small SQL parameter capacity', async () => {
  const fixture = await harness()
  const input = await fixture.create({ items: 3, images: 12 })
  const original = configuration()
  const database: DatabaseAdapter = {
    ...original.database,
    capabilities: { ...original.database.capabilities, maximumParameters: 32 },
  }
  const client = await clientApi.createSynloquent({
    ...original,
    database,
    schema: fixture.schema,
  })
  try {
    await fixture.reference.installReferenceSnapshot(client, input)
    assert.equal(await client.models.Category!.count(), 50)
    assert.equal(await client.models.Tag!.count(), 64)
    assert.equal(await client.models.Item!.count(), 3)
    assert.equal(await client.models.Image!.count(), 12)
    assert.equal(
      (await client.models.Item!.findOrFail('1')).attributes.price,
      '1.01',
    )
    const before = await state(client)
    await fixture.reference.installReferenceSnapshot(client, input)
    assert.deepEqual(await state(client), before)
  } finally {
    await client.close()
    await input.close()
    await fixture.close()
  }
})
