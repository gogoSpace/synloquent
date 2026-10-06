import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createSynloquent, SynloquentError } from '../src/index.js'
import { configuration, item, snapshotFor } from './fixtures.js'
import { utf8Length } from '../src/core/snapshot-content.js'
import { testTransport } from './transport-fixture.js'

test('C55 bounded streaming canonical digest preserves exact Unicode UTF-8 bytes and rejects incomplete digest consumers', async () => {
  let chunks = 0
  let maximumUnits = 0
  let yields = 0
  const client = await createSynloquent({
    ...configuration(),
    schedule: (callback) => {
      yields++
      const timer = setTimeout(callback, 0)
      return () => clearTimeout(timer)
    },
    digestChunks: async (source) => {
      const hashing = createHash('sha256')
      for await (const chunk of source) {
        chunks++
        maximumUnits = Math.max(maximumUnits, utf8Length(chunk))
        hashing.update(chunk)
        if (chunks % 32 === 0) {
          yields++
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }
      return hashing.digest('hex')
    },
  })
  try {
    const records = Array.from({ length: 100 }, (_, index) =>
      item(String(index + 1), { name: `${index} ${'ž😀'.repeat(3000)}` }),
    )
    const snapshot = snapshotFor(records)
    await client.sync.installSnapshot(snapshot)
    assert.ok(chunks > records.length)
    assert.ok(maximumUnits <= 4096)
    assert.ok(yields > 0)
    assert.equal(await client.models.Item!.count(), 100)
    const before = client.storage.owner.generation
    await assert.rejects(
      client.sync.installSnapshot({
        ...snapshot,
        byteSize: snapshot.byteSize - 1,
      }),
      (error) =>
        error instanceof SynloquentError && error.code === 'snapshot_invalid',
    )
    assert.equal(client.storage.owner.generation, before)
    assert.equal(await client.models.Item!.count(), 100)
  } finally {
    await client.close()
  }
  const incomplete = await createSynloquent({
    ...configuration(),
    digestChunks: async () => snapshotFor([]).hash,
  })
  try {
    await assert.rejects(
      incomplete.sync.installSnapshot(snapshotFor([])),
      (error) =>
        error instanceof SynloquentError && error.code === 'snapshot_invalid',
    )
  } finally {
    await incomplete.close()
  }
  assert.equal(utf8Length('😀ž'), 6)
})

test('C55 snapshot replacement clears absent canonical pivot sets while replaying retained pending proposals', async () => {
  const client = await createSynloquent(configuration())
  try {
    const records = [
      item('1', { name: 'Pivot parent' }),
      {
        model: 'Tag',
        id: '2',
        revision: '1',
        attributes: { id: 2, label: 'Retained tag' },
      },
    ]
    await client.sync.installSnapshot(
      snapshotFor(records, undefined, [
        {
          model: 'Item',
          relation: 'tags',
          parentId: '1',
          revision: 'r1',
          completeness: 'complete',
          targets: [{ id: '2', attributes: { position: 1, featured: false } }],
        },
      ]),
    )
    let parent = await client.models.Item!.findOrFail(1)
    assert.equal((await parent.relation('tags').get()).length, 1)
    await parent.relation('tags').attach([2], { position: 3 })
    await client.sync.installSnapshot(snapshotFor(records))
    parent = await client.models.Item!.findOrFail(1)
    const members = await parent.relation('tags').get()
    assert.equal(members.length, 1)
    assert.equal(
      (members.first() as { pivot?: { position: number } }).pivot?.position,
      3,
    )
    const pending = await client.storage.read((executor) =>
      client.storage.pending(executor),
    )
    await client.sync.cancel(pending[0]!.operation.operationId)
    assert.equal((await parent.relation('tags').get()).length, 0)
  } finally {
    await client.close()
  }
})

test('C55 snapshot failed constraints and duplicate identity roll back data, cursor and generation together', async () => {
  const client = await createSynloquent(configuration())
  try {
    await client.sync.installSnapshot(
      snapshotFor([item('1', { name: 'Active generation' })]),
    )
    const generation = client.storage.owner.generation
    const cursor = await client.storage.metadata('cursor:default')
    await assert.rejects(
      client.sync.installSnapshot(snapshotFor([item('2', {}), item('2', {})])),
      /duplicate record/,
    )
    assert.equal(client.storage.owner.generation, generation)
    assert.equal(await client.storage.metadata('cursor:default'), cursor)
    assert.deepEqual((await client.models.Item!.pluck('name')).all(), [
      'Active generation',
    ])
    await assert.rejects(
      client.sync.installSnapshot({ ...snapshotFor([]), generation: '' }),
      /identity/,
    )
    await assert.rejects(
      client.sync.installSnapshot({
        ...snapshotFor([]),
        scope: { ...snapshotFor([]).scope, schemaFingerprint: 'other' },
      }),
      /identity/,
    )
  } finally {
    await client.close()
  }
})

test('C55 retention expiry requests an immutable snapshot and resumes from its authoritative cursor', async () => {
  const server = testTransport()
  server.records.set('Item:1', item('1', { name: 'Retention snapshot' }))
  const client = await createSynloquent(
    configuration(':memory:', {
      ...server.transport,
      pull: async () => {
        throw new SynloquentError('cursor_expired', 'Fixture retention expired')
      },
    }),
  )
  try {
    await client.sync.pull()
    assert.equal(
      (await client.models.Item!.findOrFail(1)).attributes.name,
      'Retention snapshot',
    )
    assert.equal(await client.storage.metadata('cursor:default'), '1')
  } finally {
    await client.close()
  }
})

test('C55 downloaded immutable document enters the same verified snapshot activation boundary', async () => {
  const server = testTransport()
  let downloads = 0
  const document = {
    ...snapshotFor([item('7', { name: 'Authenticated download' })]),
    downloadUrl: 'https://fixture.invalid/authorized/immutable-snapshot-7',
  }
  server.transport.snapshot = async (request) => {
    assert.equal(request.session.accountId, 'actor-1')
    assert.equal(request.payload.dataset, 'default')
    downloads += 1
    return document
  }
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  try {
    await client.sync.resnapshot('default')
    assert.equal(downloads, 1)
    assert.equal(
      (await client.models.Item!.findOrFail('7')).attributes.name,
      'Authenticated download',
    )
    assert.equal(
      await client.storage.metadata('cursor:default'),
      document.cursor,
    )
    await assert.rejects(
      client.sync.installSnapshot({
        ...document,
        records: [item('7', { name: 'Changed after download' })],
      }),
      (error) =>
        error instanceof SynloquentError && error.code === 'snapshot_invalid',
    )
    assert.equal(
      (await client.models.Item!.findOrFail('7')).attributes.name,
      'Authenticated download',
    )
  } finally {
    await client.close()
  }
})
