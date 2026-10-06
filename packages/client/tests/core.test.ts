import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createSynloquent as createClient,
  Collection,
  SynloquentError,
} from '../src/index.js'
import type { ClientConfiguration } from '../src/index.js'
async function createSynloquent(configuration_: ClientConfiguration) {
  const client = await createClient(configuration_)
  await client.storage.write((executor) =>
    client.storage.setMetadata(
      'scope',
      JSON.stringify({ completeness: 'complete' }),
      executor,
    ),
  )
  return client
}

import { configuration, item } from './fixtures.js'

test('C01-C06 durable CRUD, exact decimal ordering, stable identities and casts survive reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synloquent-client-'))
  const filename = join(directory, 'store.sqlite')
  try {
    let client = await createSynloquent(configuration(filename))
    const model = await client.models.Item!.create({
      name: 'Alpha',
      price: '10000000000000000000.12',
    })
    const identity = model.localIdentity
    assert.equal(model.isClean(), true)
    model.fill({ name: 'Beta' })
    assert.equal(model.isDirty('name'), true)
    assert.equal(model.getOriginal('name'), 'Alpha')
    await model.save()
    assert.equal(model.wasChanged('name'), true)
    assert.equal(model.syncState, 'pending')
    await client.models.Item!.create({ name: 'Gamma', price: '-2.03' })
    await client.models.Item!.create({ name: 'Delta', price: '9.20' })
    assert.deepEqual(
      (await client.models.Item!.orderBy('price').pluck('name')).all(),
      ['Gamma', 'Delta', 'Beta'],
    )
    await assert.rejects(
      client.models.Item!.create({ active: 'false' }),
      (error) =>
        error instanceof SynloquentError && error.code === 'validation_failed',
    )
    await client.close()
    client = await createSynloquent(configuration(filename))
    assert.equal(
      (await client.models.Item!.findOrFail(identity)).attributes.name,
      'Beta',
    )
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      4,
    )
    await client.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('C26 atomic rollback and nested savepoint preserve data/outbox and publish after commit', async () => {
  const client = await createSynloquent(configuration())
  try {
    let notifications = 0
    const unsubscribe = client.storage.owner.subscribe(() => {
      notifications += 1
    })
    await assert.rejects(
      client.transaction(async (transaction) => {
        await transaction.models.Item!.create({ name: 'Rolled back' })
        throw new Error('fault after write')
      }),
    )
    assert.equal(await client.models.Item!.count(), 0)
    assert.equal(notifications, 0)
    await client.transaction(async (transaction) => {
      await transaction.models.Item!.create({ name: 'Kept' })
      await assert.rejects(
        transaction.transaction(async (nested) => {
          await nested.models.Item!.create({ name: 'Nested rollback' })
          throw new Error('nested fault')
        }),
      )
      await transaction.models.Item!.create({ name: 'Also kept' })
    })
    assert.equal(await client.models.Item!.count(), 2)
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      2,
    )
    assert.equal(notifications, 1)
    unsubscribe()
  } finally {
    await client.close()
  }
})

test('C02 C09-C20 SQL builders have branch safety, null predicates, ordering and iteration', async () => {
  const client = await createSynloquent(configuration())
  try {
    await client.storage.write(async (executor, changed) => {
      for (const record of [
        item('1', { name: 'Alpha', price: '2.01', count: 1 }),
        item('2', { name: 'Beta', price: '2.02', count: 2 }),
        item('3', { name: 'Gamma', count: 3 }),
      ])
        await client.storage.ingest(record, executor, changed)
    })
    const base = client.models.Item!
    assert.equal((await base.findOrFail(2)).attributes.name, 'Beta')
    assert.equal(await base.where('count', '>', 1).count(), 2)
    assert.equal(await base.whereIn('name', ['Alpha', 'Gamma']).count(), 2)
    assert.equal(await base.whereNotIn('name', []).count(), 3)
    assert.equal(await base.whereNull('deleted_at').count(), 3)
    assert.equal(await base.whereNotNull('deleted_at').count(), 0)
    assert.equal(await base.whereBetween('count', [1, 2]).count(), 2)
    assert.equal(await base.whereNotBetween('count', [1, 2]).count(), 1)
    assert.equal(await base.where('name', 'like', 'A%').count(), 1)
    assert.equal(
      await base
        .whereGroup((query) => query.where('count', 1).orWhere('count', 3))
        .count(),
      2,
    )
    assert.equal(
      await base.whereNot((query) => query.where('count', 1)).count(),
      2,
    )
    assert.equal(await base.whereColumn('count', '>=', 'count').count(), 3)
    assert.equal(await base.count(), 3)
    assert.equal(await base.where('count', 1).exists(), true)
    assert.equal(await base.where('count', 9).doesntExist(), true)
    assert.equal(await base.sum('count'), 6)
    assert.equal(await base.avg('count'), 2)
    assert.equal(await base.max('count'), 3)
    assert.equal(await base.min('count'), 1)
    assert.equal(
      (await base.reorder('count', 'desc').skip(1).take(1).firstOrFail())
        .attributes.name,
      'Beta',
    )
    assert.equal((await base.paginate(2)).hasMore, true)
    assert.equal((await base.simplePaginate(2)).data.length, 2)
    assert.equal((await base.cursorPaginate(2)).nextCursor !== null, true)
    const names: string[] = []
    for await (const model of base.lazyById(2))
      names.push(String(model.attributes.name))
    assert.deepEqual(names, ['Alpha', 'Beta', 'Gamma'])
    let chunks = 0
    await base.chunkById(2, async () => {
      chunks += 1
    })
    assert.equal(chunks, 2)
    assert.equal(
      await base.when(true, (query) => query.where('count', 2)).count(),
      1,
    )
    assert.equal(
      await base.unless(false, (query) => query.where('count', 3)).count(),
      1,
    )
  } finally {
    await client.close()
  }
})

test('C28 C29 C30 C35-C43 offline parent-child and ordered pivots query through SQLite', async () => {
  const client = await createSynloquent(configuration())
  try {
    const parent = await client.models.Item!.create({ name: 'Parent' })
    const image = await parent.relation('images').create({ url: 'image.jpg' })
    assert.equal(image.attributes.item_id, parent.localIdentity)
    await image.relation('item').associate(parent)
    await image.save()
    const tag = await client.models.Tag!.create({ label: 'Tag' })
    await parent.relation('tags').attach([tag], { position: 2, featured: true })
    const loaded = await client.models
      .Item!.with('images', 'tags')
      .findOrFail(parent.localIdentity)
    assert.equal(loaded.relation('images').current?.length, 1)
    assert.equal(loaded.relation('tags').current?.length, 1)
    assert.equal(await client.models.Item!.has('images').count(), 1)
    assert.equal(
      await client.models
        .Item!.whereHas('images', (query) => query.where('url', 'image.jpg'))
        .count(),
      1,
    )
    assert.equal(await client.models.Item!.doesntHave('tags').count(), 0)
    await parent.relation('tags').updateExistingPivot(tag, { position: 1 })
    assert.equal(
      (await parent.relation('tags').wherePivot('position', 1).get()).length,
      1,
    )
    await parent.relation('tags').toggle([tag])
    assert.equal((await parent.relation('tags').get()).length, 0)
    await parent.relation('tags').syncWithoutDetaching([tag])
    await parent.relation('tags').detach([tag])
    assert.equal((await parent.relation('tags').get()).length, 0)
    const queue = await client.storage.read((executor) =>
      client.storage.pending(executor),
    )
    assert.deepEqual(
      queue.find((entry) => entry.operation.model === 'Image')?.operation.values
        .item_id,
      { $ref: { model: 'Item', localIdentity: parent.localIdentity } },
    )
  } finally {
    await client.close()
  }
})

test('C44 soft-delete restore and C45 collection methods retain expected meaning', async () => {
  const client = await createSynloquent(configuration())
  try {
    const model = await client.models.Item!.create({ name: 'Soft' })
    await model.delete()
    assert.equal(await client.models.Item!.count(), 0)
    assert.equal(await client.models.Item!.onlyTrashed().count(), 1)
    await model.restore()
    assert.equal(await client.models.Item!.withTrashed().count(), 1)
    const values = new Collection([
      { id: 1, group: 'a' },
      { id: 2, group: 'a' },
      { id: 3, group: 'b' },
    ])
    assert.deepEqual(values.map((value) => value.id).all(), [1, 2, 3])
    assert.equal(values.filter((value) => value.id > 1).length, 2)
    assert.equal(values.reject((value) => value.id > 1).length, 1)
    assert.deepEqual(values.pluck('id').all(), [1, 2, 3])
    assert.equal(values.keyBy('id').get(2)?.group, 'a')
    assert.equal(values.groupBy('group').get('a')?.length, 2)
    assert.equal(values.unique('group').length, 2)
    assert.equal(
      values.sort((left, right) => right.id - left.id).first()?.id,
      3,
    )
    assert.equal(values.chunk(2).length, 2)
  } finally {
    await client.close()
  }
})
