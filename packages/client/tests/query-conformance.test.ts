import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSynloquent, SynloquentError } from '../src/index.js'
import { configuration, item, snapshotFor } from './fixtures.js'
import { testTransport } from './transport-fixture.js'

test('C09 projection and distinct precede pagination, C02 find respects filters and soft-delete scope', async () => {
  const client = await createSynloquent(configuration())
  try {
    await client.storage.write(async (executor, changed) => {
      for (const record of [
        item('1', { name: 'Repeated', active: false }),
        item('2', { name: 'Repeated', active: true }),
        item('3', { name: 'Other', active: true }),
      ])
        await client.storage.ingest(record, executor, changed)
    })
    assert.equal(
      await client.models.Item!.where('active', true).find('1'),
      null,
    )
    const selected = await client.models.Item!.select('name').findOrFail('1')
    assert.deepEqual(Object.keys(selected.toJSON()).sort(), ['id', 'name'])
    assert.equal(Object.hasOwn(selected.attributes, 'price'), false)
    const distinct = await client.models
      .Item!.where('active', true)
      .select('name')
      .distinct()
      .orderBy('name')
      .limit(2)
      .get()
    assert.deepEqual(distinct.map((model) => model.attributes.name).all(), [
      'Other',
      'Repeated',
    ])
    const deleted = await client.models.Item!.findOrFail('3')
    await deleted.delete()
    assert.equal(await client.models.Item!.find('3'), null)
    assert.equal(
      (await client.models.Item!.onlyTrashed().findOrFail('3')).attributes.name,
      'Other',
    )
  } finally {
    await client.close()
  }
})

test('C16 C52 partial scalar results require opt-in, metadata survives collection transforms and decimals stay exact', async () => {
  const client = await createSynloquent(configuration())
  try {
    await client.models.Item!.create({
      name: 'Huge',
      price: '100000000000000000000.01',
    })
    await client.models.Item!.create({ name: 'Small', price: '0.02' })
    await assert.rejects(
      client.models.Item!.count(),
      (error) =>
        error instanceof SynloquentError && error.code === 'incomplete_dataset',
    )
    await assert.rejects(client.models.Item!.exists(), /partial dataset/)
    assert.equal(await client.models.Item!.allowPartial().count(), 2)
    assert.equal(
      (await client.models.Item!.get()).map((model) => model.id).completeness,
      'partial',
    )
    assert.equal(
      await client.models.Item!.allowPartial().sum('price'),
      '100000000000000000000.03',
    )
    assert.equal(
      await client.models.Item!.allowPartial().avg('price'),
      '50000000000000000000.02',
    )
    assert.deepEqual(await client.models.Item!.aggregateResult('count'), {
      value: 2,
      completeness: 'partial',
    })
  } finally {
    await client.close()
  }
})

test('C19 chunkById and lazyById keep keyset position across deletion between chunks', async () => {
  const client = await createSynloquent(configuration())
  try {
    await client.storage.write(async (executor, changed) => {
      for (let identity = 1; identity <= 5; identity++)
        await client.storage.ingest(
          item(String(identity), { name: `Item ${identity}` }),
          executor,
          changed,
        )
    })
    const seen: string[] = []
    await client.models.Item!.chunkById(2, async (chunk, page) => {
      seen.push(...chunk.map((model) => String(model.id)).all())
      if (page === 1) await chunk.first()!.forceDelete()
    })
    assert.deepEqual(seen, ['1', '2', '3', '4', '5'])
  } finally {
    await client.close()
  }
})

test('C21 C22 declared joins, scalar correlated subqueries, existence filters and unions use SQLite', async () => {
  const client = await createSynloquent(configuration())
  try {
    await client.storage.write(async (executor, changed) => {
      await client.storage.ingest(
        item('1', { name: 'Parent' }),
        executor,
        changed,
      )
      await client.storage.ingest(
        item('2', { name: 'Empty' }),
        executor,
        changed,
      )
      await client.storage.ingest(
        {
          model: 'Image',
          id: '8',
          revision: '1',
          attributes: { id: '8', item_id: '1', url: 'photo.jpg' },
        },
        executor,
        changed,
      )
    })
    assert.equal(
      (
        await client.models
          .Item!.join('Image', 'image', 'id', 'item_id')
          .whereJoined('image', 'url', '=', 'photo.jpg')
          .get()
      ).length,
      1,
    )
    assert.equal(
      (
        await client.models
          .Item!.leftJoin('Image', 'image', 'id', 'item_id')
          .get()
      ).length,
      2,
    )
    const inner = client.models.Image!.select('url').where('url', 'photo.jpg')
    const projected = await client.models
      .Item!.selectSub(inner, 'photo', [
        { innerField: 'item_id', outerField: 'id' },
      ])
      .where('name', 'Parent')
      .firstOrFail()
    assert.equal(projected.projections.photo, 'photo.jpg')
    assert.equal(
      (
        await client.models
          .Item!.whereExists(inner, [
            { innerField: 'item_id', outerField: 'id' },
          ])
          .get()
      ).length,
      1,
    )
    assert.equal(
      (
        await client.models
          .Item!.whereNotExists(inner, [
            { innerField: 'item_id', outerField: 'id' },
          ])
          .get()
      ).length,
      1,
    )
    const union = client.models
      .Item!.where('name', 'Parent')
      .union(client.models.Item!.where('name', 'Empty'))
    assert.equal((await union.get()).length, 2)
    assert.equal(
      (await union.unionAll(client.models.Item!.where('name', 'Parent')).get())
        .length,
      3,
    )
    await assert.rejects(
      client.models.Item!.join('Secret', 'secret', 'id', 'id').get(),
      (error) =>
        error instanceof SynloquentError && error.code === 'unknown_model',
    )
  } finally {
    await client.close()
  }
})

test('C13 portable scalar JSON membership and declared paths, C17 grouping/having and C39 relation aggregates', async () => {
  const original = configuration()
  const definition = original.schema.models.Item!
  const client = await createSynloquent({
    ...original,
    schema: {
      ...original.schema,
      models: {
        ...original.schema.models,
        Item: {
          ...definition,
          fields: {
            ...definition.fields,
            metadata: {
              type: 'json',
              nullable: true,
              readable: true,
              writable: true,
            },
          },
        },
      },
    },
  })
  try {
    await client.storage.write(async (executor, changed) => {
      await client.storage.ingest(
        item('1', {
          name: 'Parent',
          metadata: { featured: true, category: 'outdoor' },
          active: true,
        }),
        executor,
        changed,
      )
      await client.storage.ingest(
        item('2', {
          name: 'Second',
          metadata: ['red', 1, false],
          active: true,
        }),
        executor,
        changed,
      )
      await client.storage.ingest(
        item('3', { name: 'Third', metadata: [true, 'blue'], active: false }),
        executor,
        changed,
      )
      await client.storage.ingest(
        {
          model: 'Image',
          id: '8',
          revision: '1',
          attributes: { id: '8', item_id: '1', url: 'one.jpg' },
        },
        executor,
        changed,
      )
      await client.storage.ingest(
        {
          model: 'Image',
          id: '9',
          revision: '1',
          attributes: { id: '9', item_id: '1', url: 'two.jpg' },
        },
        executor,
        changed,
      )
      await client.storage.setMetadata(
        'scope',
        JSON.stringify({ completeness: 'complete' }),
        executor,
      )
    })
    assert.equal(
      (await client.models.Item!.whereJsonContains('metadata', 'red').get())
        .length,
      1,
    )
    assert.equal(
      (await client.models.Item!.whereJsonContains('metadata', true).get())
        .length,
      1,
    )
    assert.equal(
      (
        await client.models
          .Item!.whereJsonPath('metadata', '$.featured', true)
          .get()
      ).length,
      1,
    )
    await assert.rejects(
      client.models
        .Item!.whereJsonContains('metadata', { featured: true })
        .get(),
      /scalar values only/,
    )
    const groups = await client.models
      .Item!.groupBy('active')
      .having('$aggregate', '>', 1)
      .aggregateGroups('count')
    assert.deepEqual(groups.groups, [{ keys: { active: true }, value: 2 }])
    const parent = await client.models
      .Item!.withCount('images')
      .withExists('images')
      .withSum('images', 'id')
      .withMin('images', 'id')
      .withMax('images', 'id')
      .withAvg('images', 'id')
      .where('id', '1')
      .firstOrFail()
    assert.deepEqual(parent.aggregates, {
      images_count: 2,
      images_exists: true,
      images_sum_id: 17,
      images_min_id: '8',
      images_max_id: '9',
      images_avg_id: 8.5,
    })
    await parent.loadSum('images', 'id')
    await parent.loadMin('images', 'id')
    await parent.loadMax('images', 'id')
    await parent.loadAvg('images', 'id')
    await parent.loadExists('images')
    assert.equal(parent.aggregates.images_exists, true)
  } finally {
    await client.close()
  }
})

test('C16 C17 grouped canonical integer and decimal sums averages and having remain exact beyond JavaScript safe range', async () => {
  const client = await createSynloquent(configuration())
  try {
    await client.storage.write(async (executor, changed) => {
      for (const record of [
        item('1', {
          active: true,
          count: '18446744073709551610',
          price: '100000000000000000000.01',
        }),
        item('2', { active: true, count: 4, price: '0.02' }),
        item('3', { active: false, count: 7, price: '1.00' }),
      ])
        await client.storage.ingest(record, executor, changed)
      await client.storage.setMetadata(
        'scope',
        JSON.stringify({ completeness: 'complete' }),
        executor,
      )
    })
    const grouped = client.models.Item!.groupBy('active')
    assert.deepEqual((await grouped.aggregateGroups('sum', 'count')).groups, [
      { keys: { active: false }, value: 7 },
      { keys: { active: true }, value: '18446744073709551614' },
    ])
    assert.deepEqual((await grouped.aggregateGroups('avg', 'count')).groups, [
      { keys: { active: false }, value: 7 },
      { keys: { active: true }, value: '9223372036854775807' },
    ])
    assert.deepEqual((await grouped.aggregateGroups('sum', 'price')).groups, [
      { keys: { active: false }, value: '1.00' },
      { keys: { active: true }, value: '100000000000000000000.03' },
    ])
    assert.deepEqual((await grouped.aggregateGroups('avg', 'price')).groups, [
      { keys: { active: false }, value: '1.00' },
      { keys: { active: true }, value: '50000000000000000000.02' },
    ])
    assert.deepEqual(
      (
        await grouped
          .having('$aggregate', '>', '18446744073709551613')
          .aggregateGroups('sum', 'count')
      ).groups,
      [{ keys: { active: true }, value: '18446744073709551614' }],
    )
    assert.deepEqual(
      (
        await grouped
          .having('active', '=', true)
          .aggregateGroups('min', 'count')
      ).groups,
      [{ keys: { active: true }, value: 4 }],
    )
    assert.deepEqual((await grouped.aggregateGroups('max', 'count')).groups, [
      { keys: { active: false }, value: 7 },
      { keys: { active: true }, value: '18446744073709551610' },
    ])
    assert.deepEqual(
      (await grouped.orderByDesc('active').limit(1).aggregateGroups('count'))
        .groups,
      [{ keys: { active: true }, value: 2 }],
    )
    assert.deepEqual(
      (await grouped.orderByDesc('active').offset(1).aggregateGroups('count'))
        .groups,
      [{ keys: { active: false }, value: 1 }],
    )
  } finally {
    await client.close()
  }
})

test('C16 C17 remote grouped aggregate rejects late sessions schema drift and partial membership and retains remote result scope', async () => {
  const server = testTransport()
  let begin = (): void => {}
  let release = (): void => {}
  const started = new Promise<void>((resolve) => {
    begin = resolve
  })
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const complete = {
    records: [],
    related: [],
    relationSets: [],
    completeness: 'complete' as const,
    scope: snapshotFor([]).scope,
    aggregate: {
      value: '18446744073709551614',
      groups: [{ keys: { active: true }, value: '18446744073709551614' }],
    },
  }
  server.transport.query = async () => {
    begin()
    await barrier
    return complete
  }
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  try {
    const pending = client.models
      .Item!.remote()
      .groupBy('active')
      .aggregateGroups('sum', 'count')
    const rejected = assert.rejects(
      pending,
      (error) =>
        error instanceof SynloquentError && error.code === 'session_changed',
    )
    await started
    await client.setSession({ ...client.storage.session, accountId: 'actor-2' })
    release()
    await rejected
    server.transport.query = async () => ({
      ...complete,
      scope: { ...complete.scope, schemaFingerprint: 'other-schema' },
    })
    await assert.rejects(
      client.models
        .Item!.remote()
        .groupBy('active')
        .aggregateGroups('sum', 'count'),
      (error) =>
        error instanceof SynloquentError && error.code === 'schema_mismatch',
    )
    server.transport.query = async () => ({
      ...complete,
      completeness: 'partial',
      scope: { ...complete.scope, completeness: 'partial' },
    })
    await assert.rejects(
      client.models
        .Item!.remote()
        .groupBy('active')
        .aggregateGroups('sum', 'count'),
      (error) =>
        error instanceof SynloquentError && error.code === 'incomplete_dataset',
    )
    assert.deepEqual(
      await client.models
        .Item!.remote()
        .allowPartial()
        .groupBy('active')
        .aggregateGroups('sum', 'count'),
      { groups: complete.aggregate.groups, completeness: 'partial' },
    )
    server.transport.query = async () => complete
    assert.deepEqual(
      await client.models.Item!.remote().aggregateResult('sum', 'count'),
      { value: '18446744073709551614', completeness: 'complete' },
    )
    assert.equal(await client.models.Item!.completeness(), 'partial')
  } finally {
    release()
    await client.close()
  }
})
