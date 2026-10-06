import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSynloquent, SynloquentError } from '../src/index.js'
import { configuration, manifest, item, snapshotFor } from './fixtures.js'
import { testTransport } from './transport-fixture.js'

test('C03 C04 C05 C53 draft fill/save/change history, defaults, replicate and timestamp touch persist separately from canonical', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synloquent-durability-'))
  const filename = join(directory, 'draft.sqlite')
  let client = await createSynloquent({
    ...configuration(filename),
    schema: {
      ...manifest,
      models: {
        ...manifest.models,
        Item: {
          ...manifest.models.Item!,
          timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
          fields: {
            ...manifest.models.Item!.fields,
            created_at: {
              type: 'datetime',
              nullable: true,
              readable: true,
              writable: false,
            },
            updated_at: {
              type: 'datetime',
              nullable: true,
              readable: true,
              writable: false,
            },
          },
        },
      },
    },
  })
  try {
    const draft = client.models.Item!.new({ name: 'Uncommitted draft' })
    assert.equal(draft.exists, false)
    assert.equal(draft.isDirty('name'), true)
    assert.equal(draft.attributes.active, true)
    assert.equal(draft.attributes.price, '0.00')
    assert.equal((await client.models.Item!.get()).length, 0)
    draft.forceFill({ name: 'Saved draft' })
    assert.throws(
      () => draft.forceFill({ id: 999 }),
      (error) =>
        error instanceof SynloquentError && error.code === 'forbidden_field',
    )
    await draft.save()
    assert.equal(draft.isClean(), true)
    assert.equal(draft.getOriginal('name'), 'Saved draft')
    assert.equal(draft.wasChanged('name'), true)
    assert.equal(draft.getChanges().name, 'Saved draft')
    assert.equal(draft.attributes.created_at, '2026-10-02T12:00:00.000Z')
    assert.equal(draft.canonicalRecord(), null)
    const identity = draft.localIdentity
    const copy = draft.replicate(['name'])
    assert.equal(copy.exists, false)
    assert.equal(copy.attributes.name, undefined)
    assert.equal(copy.attributes.created_at, undefined)
    assert.equal(copy.attributes.price, '0.00')
    await draft.touch()
    await client.close()
    client = await createSynloquent(configuration(filename))
    const restored = await client.models.Item!.findOrFail(identity)
    assert.equal(restored.attributes.name, 'Saved draft')
    assert.equal(restored.syncState, 'pending')
    assert.equal(restored.getOriginal('name'), 'Saved draft')
    assert.equal(restored.isClean(), true)
    assert.equal((await restored.fresh())?.localIdentity, identity)
    await restored.refresh()
    assert.deepEqual(restored.getChanges(), {})
  } finally {
    await client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('C23 C24 firstOrNew/firstOrCreate/updateOrCreate and atomic unique upsert/bulk mutation retain durable event mode', async () => {
  const schema = {
    ...manifest,
    models: {
      ...manifest.models,
      Item: { ...manifest.models.Item!, unique: [['name']] },
    },
  }
  const client = await createSynloquent({ ...configuration(), schema })
  try {
    await client.storage.write((executor) =>
      client.storage.setMetadata(
        'scope',
        JSON.stringify({ completeness: 'complete' }),
        executor,
      ),
    )
    const fresh = await client.models.Item!.firstOrNew(
      { name: 'Unique' },
      { count: 2 },
    )
    assert.equal(fresh.exists, false)
    assert.equal((await client.models.Item!.get()).length, 0)
    const created = await client.models.Item!.firstOrCreate(
      { name: 'Unique' },
      { count: 2 },
    )
    const replay = await client.models.Item!.firstOrCreate(
      { name: 'Unique' },
      { count: 99 },
    )
    assert.equal(replay.localIdentity, created.localIdentity)
    assert.equal(replay.attributes.count, 2)
    await client.models.Item!.updateOrCreate({ name: 'Unique' }, { count: 3 })
    assert.equal(
      (await client.models.Item!.findOrFail(created.localIdentity)).attributes
        .count,
      3,
    )
    const inserted = await client.models.Item!.insert([
      { name: 'Bulk one' },
      { name: 'Bulk two' },
    ])
    assert.equal(inserted.length, 2)
    await assert.rejects(
      client.models.Item!.insert([{ name: 'Rolled back' }, { name: 'Unique' }]),
      /UNIQUE/,
    )
    assert.equal(
      (await client.models.Item!.where('name', 'Rolled back').get()).length,
      0,
    )
    const upserted = await client.models.Item!.upsert(
      [
        { name: 'Bulk one', count: 7 },
        { name: 'Bulk three', count: 8 },
      ],
      ['name'],
      ['count'],
    )
    assert.equal(upserted.length, 2)
    assert.equal(
      await client.models
        .Item!.where('name', 'like', 'Bulk%')
        .update({ active: false }),
      3,
    )
    assert.equal(await client.models.Item!.where('active', false).delete(), 3)
    const entries = await client.storage.read((executor) =>
      client.storage.pending(executor),
    )
    const bulk = entries.filter((entry) => entry.operation.eventMode === 'bulk')
    assert.ok(bulk.length >= 10)
    const groups = new Map<string, number>()
    for (const entry of bulk) {
      assert.ok(entry.operation.atomicGroup)
      groups.set(
        entry.operation.atomicGroup!,
        (groups.get(entry.operation.atomicGroup!) ?? 0) + 1,
      )
    }
    assert.equal([...groups.values()].includes(3), true)
    await assert.rejects(
      client.models.Item!.upsert([{ name: 'Invalid' }], ['count']),
      /unique constraint/,
    )
    assert.equal((await client.models.Item!.onlyTrashed().get()).length, 3)
    assert.equal(await client.models.Item!.onlyTrashed().restore(), 3)
    assert.equal(
      await client.models.Item!.where('name', 'Bulk three').forceDelete(),
      1,
    )
  } finally {
    await client.close()
  }
})

test('C06 C08 casts reject invalid finite/date/enum input and readable serialization excludes hidden values', async () => {
  const field = { nullable: false, readable: true, writable: true }
  const schema = {
    ...manifest,
    models: {
      ...manifest.models,
      Item: {
        ...manifest.models.Item!,
        fields: {
          ...manifest.models.Item!.fields,
          rating: { ...field, type: 'float' as const, precision: 2 },
          acquired_on: { ...field, type: 'date' as const, nullable: true },
          observed_at: { ...field, type: 'datetime' as const, nullable: true },
          metadata: { ...field, type: 'json' as const, nullable: true },
          status: {
            ...field,
            type: 'enum' as const,
            enum: ['draft', 'active'],
          },
          private_note: { ...field, type: 'string' as const, readable: false },
        },
      },
    },
  }
  const client = await createSynloquent({ ...configuration(), schema })
  try {
    const draft = client.models.Item!.new({
      name: 'Casts',
      count: '18446744073709551614',
      rating: 1.25,
      acquired_on: '2024-02-29',
      observed_at: '2026-10-02T12:00:00.123456Z',
      metadata: { flags: [null, false, 1, 'one'] },
      status: 'draft',
      private_note: 'Hidden',
    })
    assert.equal(draft.attributes.count, '18446744073709551614')
    assert.equal(draft.toJSON().private_note, undefined)
    assert.equal(draft.attributes.private_note, undefined)
    assert.equal(draft.toJSON().status, 'draft')
    for (const patch of [
      { acquired_on: '2023-02-29' },
      { observed_at: '2026-02-30T12:00:00Z' },
      { observed_at: '2026-10-02T24:00:00Z' },
      { rating: Number.POSITIVE_INFINITY },
      { status: 'unknown' },
      { metadata: { invalid: Number.NaN } },
      { count: 9007199254740992 },
      { count: '0106' },
      { count: '-0106' },
      { count: '+106' },
      { count: '-0' },
      { price: 1.25 },
    ])
      assert.throws(
        () => draft.fill(patch),
        (error) =>
          error instanceof SynloquentError &&
          error.code === 'validation_failed',
      )
    draft.fill({ count: '0' })
    assert.equal(draft.attributes.count, '0')
    draft.fill({ count: 0 })
    assert.equal(draft.attributes.count, 0)
    await draft.save()
    assert.equal(
      (await client.models.Item!.findOrFail(draft.localIdentity)).attributes
        .private_note,
      undefined,
    )
    await client.storage.write((executor, changed) =>
      client.storage.ingest(
        item('4', { name: 'Canonical' }),
        executor,
        changed,
      ),
    )
    const selected = await client.models
      .Item!.select('name')
      .addSelect('price')
      .findOrFail(4)
    assert.deepEqual(Object.keys(selected.toJSON()).sort(), [
      'id',
      'name',
      'price',
    ])
  } finally {
    await client.close()
  }
})

test('C06 C27 C55 canonical integer zero rejects signed string zero before snapshot or durable operation identity', async () => {
  const server = testTransport()
  server.records.set('Item:0', item('0', { name: 'Canonical zero' }))
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  const invalid = (error: unknown) =>
    error instanceof SynloquentError && error.code === 'validation_failed'
  try {
    await client.sync.installSnapshot(
      snapshotFor([item('0', { name: 'Canonical zero' })]),
    )
    const generation = client.storage.owner.generation
    await assert.rejects(
      client.sync.installSnapshot(
        snapshotFor([item('-0', { name: 'Invalid signed zero' })]),
      ),
      invalid,
    )
    assert.equal(client.storage.owner.generation, generation)
    assert.equal(
      (await client.models.Item!.findOrFail('0')).attributes.name,
      'Canonical zero',
    )
    await assert.rejects(
      client.storage.write((executor, changed) =>
        client.storage.ingest({ ...item('0', {}), id: '1' }, executor, changed),
      ),
      (error) =>
        error instanceof SynloquentError && error.code === 'schema_mismatch',
    )
    assert.equal(await client.models.Item!.find('1'), null)
    const operation = {
      operationId: 'zero-update',
      model: 'Item',
      localIdentity: 'c:0',
      action: 'update' as const,
      id: '-0',
      expectedRevision: '1',
      values: { name: 'Confirmed zero' },
      dependsOn: [],
    }
    await assert.rejects(
      client.sync.atomicGroup('zero-group', [operation]),
      invalid,
    )
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      0,
    )
    await client.sync.atomicGroup('zero-group', [{ ...operation, id: '0' }])
    await client.sync.flush()
    assert.equal(
      (await client.models.Item!.findOrFail('0')).attributes.name,
      'Confirmed zero',
    )
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      )[0]?.status,
      'accepted',
    )
  } finally {
    await client.close()
  }
})
