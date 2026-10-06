import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSynloquent, SynloquentError } from '../src/index.js'
import type {
  ModelInstance,
  Predicate,
  WireValue,
  Query,
  QueryOptions,
} from '../src/index.js'
import { configuration, item, manifest } from './fixtures.js'
import { testTransport } from './transport-fixture.js'

function projectedTransport() {
  const fixture = testTransport()
  const matches = (
    predicate: Predicate | undefined,
    attributes: Record<string, WireValue>,
  ): boolean => {
    if (!predicate) return true
    if (predicate.kind === 'group')
      return predicate.boolean === 'and'
        ? predicate.predicates.every((child) => matches(child, attributes))
        : predicate.predicates.some((child) => matches(child, attributes))
    if (predicate.kind === 'comparison' && predicate.operator === '=')
      return String(attributes[predicate.field]) === String(predicate.value)
    throw new Error('Focused transport received an undeclared predicate.')
  }
  const requests: string[][] = []
  fixture.transport.query = async (request) => {
    requests.push([...(request.payload.select ?? [])])
    return {
      records: [...fixture.records.values()]
        .filter(
          (record) =>
            record.model === request.payload.model &&
            matches(request.payload.where, record.attributes),
        )
        .map((record) => ({
          ...record,
          attributes: request.payload.select
            ? Object.fromEntries(
                Object.entries(record.attributes).filter(
                  ([field]) =>
                    request.payload.select!.includes(field) ||
                    field === manifest.models[record.model]!.primaryKey,
                ),
              )
            : record.attributes,
        })),
      related: [],
      relationSets: [],
      completeness: 'complete',
      scope: {
        dataset: 'default',
        schemaFingerprint: manifest.fingerprint,
        authorizationGeneration: 'auth-1',
        projectionGeneration: 'projection-1',
        completeness: 'complete',
      },
    }
  }
  return { ...fixture, requests }
}

test('C03 C04 C09 detached remote reads reject model and relation writes before durable state changes', async () => {
  const fixture = projectedTransport()
  fixture.records.set('Item:1', item('1', { name: 'Remote readonly' }))
  const client = await createSynloquent(
    configuration(':memory:', fixture.transport),
  )
  try {
    const remote = await client.models.Item!.remote().firstOrFail()
    const unsafe = remote as unknown as ModelInstance
    const denied = (error: unknown) =>
      error instanceof SynloquentError && error.code === 'forbidden_operation'
    assert.throws(() => unsafe.fill({ name: 'Rejected' }), denied)
    assert.throws(() => unsafe.set('name', 'Rejected'), denied)
    assert.throws(() => unsafe.forceFill({ name: 'Rejected' }), denied)
    await assert.rejects(unsafe.save(), denied)
    await assert.rejects(unsafe.update({ name: 'Rejected' }), denied)
    await assert.rejects(unsafe.saveConfirmed(), denied)
    await assert.rejects(unsafe.delete(), denied)
    await assert.rejects(unsafe.forceDelete(), denied)
    await assert.rejects(unsafe.restore(), denied)
    await assert.rejects(unsafe.touch(), denied)
    await assert.rejects(unsafe.increment('count'), denied)
    await assert.rejects(unsafe.decrement('count'), denied)
    await assert.rejects(unsafe.relation('tags').attach(['1']), denied)
    await assert.rejects(
      unsafe.relation('images').create({ url: 'rejected.jpg' }),
      denied,
    )
    await assert.rejects(
      unsafe.relation('images').createMany([{ url: 'rejected.jpg' }]),
      denied,
    )
    await assert.rejects(unsafe.relation('images').save(unsafe), denied)
    await assert.rejects(unsafe.relation('images').saveMany([unsafe]), denied)
    await assert.rejects(unsafe.relation('images').delete(), denied)
    await assert.rejects(unsafe.relation('images').associate('1'), denied)
    await assert.rejects(unsafe.relation('images').dissociate(), denied)
    await assert.rejects(
      unsafe.relation('tags').withPivot('position').attach(['1']),
      denied,
    )
    await assert.rejects(unsafe.relation('tags').detach(['1']), denied)
    await assert.rejects(unsafe.relation('tags').toggle(['1']), denied)
    await assert.rejects(
      unsafe.relation('tags').updateExistingPivot('1', { position: 2 }),
      denied,
    )
    await assert.rejects(
      unsafe
        .relation('tags')
        .sync(['1'], { expectedRelationRevision: '1', completeSet: true }),
      denied,
    )
    await assert.rejects(
      unsafe.relation('tags').syncWithoutDetaching(['1']),
      denied,
    )
    assert.equal(await client.models.Item!.find('1'), null)
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      0,
    )
    assert.equal(remote.attributes.name, 'Remote readonly')
  } finally {
    await client.close()
  }
})

test('C03 C04 C09 C43 existing projected remote firstOrNew materializes full editable canonical and preserves pending overlay alias', async () => {
  const fixture = projectedTransport()
  fixture.records.set('Item:1', item('1', { name: 'Server', price: '12.34' }))
  const client = await createSynloquent(
    configuration(':memory:', fixture.transport),
  )
  try {
    await client.storage.write((executor, changed) =>
      client.storage.ingest(
        {
          ...item('1', { name: 'Server', price: '12.34' }),
          localIdentity: 'offline-owner',
        },
        executor,
        changed,
      ),
    )
    const local = await client.models.Item!.findOrFail('offline-owner')
    await local.update({ price: '22.22' })
    const before = await client.storage.read((executor) =>
      client.storage.pending(executor),
    )
    const editable = await client.models
      .Item!.remote()
      .select('name')
      .firstOrNew({ id: '1' })
    assert.equal(editable.remoteResult, false)
    assert.equal(editable.localIdentity, 'offline-owner')
    assert.equal(editable.attributes.price, '22.22')
    assert.equal(editable.getOriginal('price'), '22.22')
    assert.equal(editable.revision, '1')
    assert.deepEqual(
      await client.storage.read((executor) => client.storage.pending(executor)),
      before,
    )
    assert.deepEqual(fixture.requests.at(-1), [])
    editable.fill({ name: 'Durable editable' })
    assert.equal(editable.isDirty('name'), true)
    await editable.saveConfirmed()
    assert.equal(editable.attributes.name, 'Durable editable')
    assert.equal(editable.syncState, 'synced')
    assert.equal(fixture.records.get('Item:1')!.attributes.price, '22.22')
  } finally {
    await client.close()
  }
})

test('C03 C04 C23 remote create absent firstOrNew firstOrCreate and updateOrCreate retain editable confirmed writes', async () => {
  const fixture = projectedTransport()
  const client = await createSynloquent(
    configuration(':memory:', fixture.transport),
  )
  try {
    const created = await client.models
      .Item!.remote()
      .create({ name: 'Created', price: '1.25' })
    assert.equal(created.remoteResult, false)
    assert.equal(created.syncState, 'synced')
    const draft = await client.models
      .Item!.remote()
      .select('name')
      .firstOrNew({ name: 'Missing' }, { price: '2.50' })
    assert.equal(draft.exists, false)
    draft.fill({ count: 2 })
    assert.equal(draft.isDirty('count'), true)
    await draft.saveConfirmed()
    assert.equal(draft.exists, true)
    const existing = await client.models
      .Item!.remote()
      .select('name')
      .firstOrCreate({ id: created.id as string })
    assert.equal(existing.remoteResult, false)
    assert.equal(existing.attributes.price, '1.25')
    const updated = await client.models
      .Item!.remote()
      .select('name')
      .updateOrCreate({ id: created.id as string }, { price: '3.75' })
    assert.equal(updated.attributes.price, '3.75')
    assert.equal(updated.syncState, 'synced')
    await assert.rejects(
      client.models.Item!.remote().firstOrNew({ id: '999' }),
      (error) =>
        error instanceof SynloquentError && error.code === 'forbidden_field',
    )
  } finally {
    await client.close()
  }
})

test('C09 C19 C53 selected views propagate through addSelect pages iterators and committed observations while writable fields remain editable', async () => {
  const client = await createSynloquent(configuration())
  try {
    await client.storage.write(async (executor, changed) => {
      await client.storage.ingest(
        item('1', { name: 'One', price: '1.25', active: true }),
        executor,
        changed,
      )
      await client.storage.ingest(
        item('2', { name: 'Two', price: '2.50', active: false }),
        executor,
        changed,
      )
      await client.storage.setMetadata(
        'scope',
        JSON.stringify({ completeness: 'complete' }),
        executor,
      )
    })
    const query = client.models
      .Item!.select('name')
      .addSelect('price')
      .where('active', true)
      .orderBy('count')
    for (const model of await query.get())
      assert.deepEqual(Object.keys(model.attributes).sort(), [
        'id',
        'name',
        'price',
      ])
    const narrowed = query.select('price')
    assert.deepEqual(
      Object.keys((await narrowed.firstOrFail()).attributes).sort(),
      ['id', 'price'],
    )
    assert.deepEqual(
      Object.keys(
        (await narrowed.simplePaginate()).data.first()!.attributes,
      ).sort(),
      ['id', 'price'],
    )
    assert.deepEqual(
      Object.keys((await narrowed.paginate()).data.first()!.attributes).sort(),
      ['id', 'price'],
    )
    assert.deepEqual(
      Object.keys(
        (await narrowed.cursorPaginate()).data.first()!.attributes,
      ).sort(),
      ['id', 'price'],
    )
    for await (const model of narrowed.lazyById(1))
      assert.deepEqual(Object.keys(model.attributes).sort(), ['id', 'price'])
    const observation = client.observe(narrowed)
    await observation.refresh()
    assert.deepEqual(
      Object.keys(observation.getSnapshot().data.first()!.attributes).sort(),
      ['id', 'price'],
    )
    observation.dispose()
    const projected = await narrowed.firstOrFail()
    projected.fill({ name: 'Writable unselected field' })
    await projected.save()
    assert.equal(
      (await client.models.Item!.findOrFail('1')).attributes.name,
      'Writable unselected field',
    )
  } finally {
    await client.close()
  }
})

test('C29 C36 projected actual Model natural owner key remains valid for association', async () => {
  const schema = {
    ...manifest,
    fingerprint: 'projected-owner',
    models: {
      ...manifest.models,
      Item: {
        ...manifest.models.Item!,
        fields: {
          ...manifest.models.Item!.fields,
          code: {
            type: 'string' as const,
            nullable: false,
            readable: true,
            writable: true,
          },
        },
        unique: [['code']],
      },
      Image: {
        ...manifest.models.Image!,
        fields: {
          ...manifest.models.Image!.fields,
          item_id: {
            type: 'string' as const,
            nullable: false,
            readable: true,
            writable: true,
          },
        },
        relations: {
          item: {
            type: 'belongsTo' as const,
            model: 'Item',
            foreignKey: 'item_id',
            ownerKey: 'code',
          },
        },
      },
    },
  }
  const client = await createSynloquent({ ...configuration(), schema })
  try {
    await client.storage.write((executor, changed) =>
      client.storage.ingest(
        item('1', { name: 'Projected owner', code: 'natural:owner' }),
        executor,
        changed,
      ),
    )
    const owner = await client.models.Item!.select('name').findOrFail('1')
    const child = client.models.Image!.new({ url: 'photo.jpg' })
    assert.equal(Object.hasOwn(owner.attributes, 'code'), false)
    await child.relation('item').associate(owner)
    assert.equal(child.attributes.item_id, 'natural:owner')
    await child.save()
    assert.equal(
      (await client.models.Image!.whereBelongsTo(owner, 'item').get()).first()!
        .localIdentity,
      child.localIdentity,
    )
    assert.equal((await child.relation('item').get()).first()!.id, '1')
    await assert.rejects(
      child
        .relation('item')
        .associate({ id: '1', attributes: { name: 'Missing owner' } }),
      /owner key/,
    )
  } finally {
    await client.close()
  }
})

test('C23 C24 projected remote bulk helpers materialize full rows and preserve unselected canonical values', async () => {
  const fixture = projectedTransport()
  fixture.records.set(
    'Item:7',
    item('7', { name: 'Existing', price: '12.34', count: 1 }),
  )
  const schema = {
    ...manifest,
    models: {
      ...manifest.models,
      Item: { ...manifest.models.Item!, unique: [['name']] },
    },
  }
  const client = await createSynloquent({
    ...configuration(':memory:', fixture.transport),
    schema,
  })
  try {
    const query = client.models.Item!.remote().select('name')
    const inserted = await query.insert([{ name: 'Inserted', price: '2.50' }])
    assert.equal(inserted.first()!.remoteResult, false)
    assert.equal(inserted.first()!.syncState, 'synced')
    assert.equal(
      (await client.models.Item!.findOrFail(String(inserted.first()!.id)))
        .attributes.price,
      '2.50',
    )
    const upserted = await query
      .where('name', 'Existing')
      .upsert([{ name: 'Existing', count: 2 }], ['name'], ['count'])
    assert.equal(upserted.first()!.attributes.price, '12.34')
    assert.equal(upserted.first()!.syncState, 'synced')
    assert.equal(fixture.records.get('Item:7')!.attributes.count, 2)
    assert.equal(fixture.records.get('Item:7')!.attributes.price, '12.34')
    assert.equal(await query.where('name', 'Existing').update({ count: 3 }), 1)
    assert.equal(fixture.records.get('Item:7')!.attributes.count, 3)
    assert.equal(
      (await client.models.Item!.findOrFail('7')).attributes.price,
      '12.34',
    )
    const writes = await client.storage.read((executor) =>
      client.storage.pending(executor),
    )
    assert.equal(
      writes
        .filter((entry) => entry.operation.action === 'update')
        .every((entry) => entry.operation.eventMode === 'bulk'),
      true,
    )
    assert.equal(
      fixture.requests.every((fields) => fields.length === 0),
      true,
    )
  } finally {
    await client.close()
  }
})

test('C23 C56 remote materialization rejects a late session and invalid native fields without publishing rows or outbox', async () => {
  const fixture = projectedTransport()
  fixture.records.set('Item:1', item('1', { name: 'Old actor' }))
  const client = await createSynloquent(
    configuration(':memory:', fixture.transport),
  )
  try {
    const originalQuery = fixture.transport.query
    let deliver: (() => void) | undefined
    let entered: (() => void) | undefined
    const requested = new Promise<void>((resolve) => {
      entered = resolve
    })
    const responseReady = new Promise<void>((resolve) => {
      deliver = resolve
    })
    fixture.transport.query = async (request) => {
      entered!()
      await responseReady
      return originalQuery(request)
    }
    const late = client.models.Item!.remote().firstOrNew({ id: '1' })
    await requested
    await client.setSession({ ...client.storage.session, accountId: 'actor-2' })
    deliver!()
    await assert.rejects(
      late,
      (error) =>
        error instanceof SynloquentError && error.code === 'session_changed',
    )
    assert.equal(await client.models.Item!.find('1'), null)
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      0,
    )
    fixture.transport.query = originalQuery
    fixture.records.set(
      'Item:1',
      item('1', { name: 'Invalid field', count: 'not-integer' }),
    )
    await assert.rejects(
      client.models.Item!.remote().firstOrNew({ id: '1' }),
      (error) =>
        error instanceof SynloquentError && error.code === 'validation_failed',
    )
    assert.equal(await client.models.Item!.find('1'), null)
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      0,
    )
  } finally {
    await client.close()
  }
})

test('C23 C58 remote editable materialization preserves actual missing-owner foreign key rejection and rolls back publication', async () => {
  const fixture = projectedTransport()
  fixture.records.set('Image:1', {
    model: 'Image',
    id: '1',
    revision: '1',
    attributes: { id: 1, item_id: 999, url: 'missing-owner.jpg' },
  })
  const schema = {
    ...manifest,
    models: {
      ...manifest.models,
      Image: {
        ...manifest.models.Image!,
        relations: {
          item: {
            ...manifest.models.Image!.relations.item!,
            onDelete: 'restrict' as const,
            onUpdate: 'restrict' as const,
          },
        },
      },
    },
  }
  const client = await createSynloquent({
    ...configuration(':memory:', fixture.transport),
    schema,
  })
  let publications = 0
  const stop = client.storage.owner.subscribe(() => {
    publications++
  })
  try {
    const read = await client.models.Image!.remote().select('url').firstOrFail()
    assert.equal(read.attributes.url, 'missing-owner.jpg')
    await assert.rejects(
      client.models.Image!.remote().firstOrNew({ id: '1' }),
      /FOREIGN KEY/,
    )
    assert.equal(await client.models.Image!.find('1'), null)
    assert.equal(await client.models.Item!.find('999'), null)
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      0,
    )
    assert.equal(publications, 0)
    fixture.records.set(
      'Item:999',
      item('999', { name: 'Explicitly materialized owner' }),
    )
    const owner = await client.models.Item!.remote().firstOrNew({ id: '999' })
    assert.equal(owner.remoteResult, false)
    const editable = await client.models
      .Image!.remote()
      .select('url')
      .firstOrNew({ id: '1' })
    assert.equal(editable.remoteResult, false)
    assert.equal(editable.attributes.item_id, 999)
    editable.fill({ url: 'editable.jpg' })
    await editable.saveConfirmed()
    assert.equal(fixture.records.get('Image:1')!.attributes.url, 'editable.jpg')
  } finally {
    stop()
    await client.close()
  }
})

test('C23 C51 C56 editable materialization rechecks the session after waiting in the owner write queue', async () => {
  const fixture = projectedTransport()
  fixture.records.set(
    'Item:1',
    item('1', { name: 'Previous session canonical' }),
  )
  const client = await createSynloquent(
    configuration(':memory:', fixture.transport),
  )
  let releaseRead: (() => void) | undefined
  let readEntered: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  const holderEntered = new Promise<void>((resolve) => {
    readEntered = resolve
  })
  const holder = client.storage.read(async () => {
    readEntered!()
    await held
  })
  await holderEntered
  let deliverQuery: (() => void) | undefined
  let queryEntered: (() => void) | undefined
  const queryRequested = new Promise<void>((resolve) => {
    queryEntered = resolve
  })
  const responseHeld = new Promise<void>((resolve) => {
    deliverQuery = resolve
  })
  const originalQuery = fixture.transport.query
  fixture.transport.query = async (request) => {
    queryEntered!()
    await responseHeld
    return originalQuery(request)
  }
  let writeQueued: (() => void) | undefined
  const materializationQueued = new Promise<void>((resolve) => {
    writeQueued = resolve
  })
  const originalWrite = client.storage.owner.write.bind(client.storage.owner)
  client.storage.owner.write = async (callback) => {
    writeQueued!()
    return originalWrite(callback)
  }
  let entityPublications = 0
  const stop = client.storage.owner.subscribe((changed) => {
    if (changed.has('Item')) entityPublications++
  })
  try {
    const editable = client.models.Item!.remote().firstOrNew({ id: '1' })
    await queryRequested
    const changedSession = client.setSession({
      ...client.storage.session,
      accountId: 'actor-2',
    })
    deliverQuery!()
    await materializationQueued
    releaseRead!()
    await holder
    await changedSession
    await assert.rejects(
      editable,
      (error) =>
        error instanceof SynloquentError && error.code === 'session_changed',
    )
    assert.equal(await client.models.Item!.find('1'), null)
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      0,
    )
    const rows = await client.storage.read((executor) =>
      executor.execute('SELECT _local_identity FROM syn_model_Item'),
    )
    assert.deepEqual(rows.rows, [])
    assert.equal(entityPublications, 0)
  } finally {
    releaseRead!()
    client.storage.owner.write = originalWrite
    stop()
    await client.close()
  }
})

test('C35 detached supplied constraint builders deny direct fluent and nested intent before rows outbox or publication', async () => {
  const fixture = projectedTransport()
  fixture.records.set(
    'Item:1',
    item('1', { name: 'Detached constraint owner' }),
  )
  const client = await createSynloquent(
    configuration(':memory:', fixture.transport),
  )
  const denied = (error: unknown) =>
    error instanceof SynloquentError && error.code === 'forbidden_operation'
  let publications = 0
  const stop = client.storage.owner.subscribe(() => {
    publications++
  })
  try {
    const parent = await client.models.Item!.remote().firstOrFail()
    const callbacks: {
      relation: string
      callback: (query: Query) => { readonly options: QueryOptions }
    }[] = [
      {
        relation: 'tags',
        callback(query) {
          void query.create({ label: 'Direct' })
          return query
        },
      },
      {
        relation: 'tags',
        callback(query) {
          void query.where('label', 'Chained').create({ label: 'Chained' })
          return query
        },
      },
      {
        relation: 'tags',
        callback(query) {
          return query.whereGroup((nested) => {
            void nested.create({ label: 'Nested' })
            return nested
          })
        },
      },
      {
        relation: 'tags',
        callback(query) {
          return query.when(true, (nested) => {
            void nested.insert([{ label: 'Conditional' }])
            return nested
          })
        },
      },
      {
        relation: 'tags',
        callback(query) {
          return {
            get options() {
              void query.create({ label: 'Getter' })
              return { model: 'Tag' }
            },
          }
        },
      },
      {
        relation: 'tags',
        callback(query) {
          void query.storage
          return query
        },
      },
      {
        relation: 'tags',
        callback(query) {
          void query.get()
          return query
        },
      },
      {
        relation: 'tags',
        callback(query) {
          void query.remote().firstOrNew({ label: 'Remote helper' })
          return query
        },
      },
      {
        relation: 'images',
        callback(query) {
          return query.withConstrained('item', (nested) => {
            void nested.create({ name: 'Eager callback' })
            return nested
          })
        },
      },
      {
        relation: 'images',
        callback(query) {
          return query.whereHas('item', (nested) => {
            void nested.delete()
            return nested
          })
        },
      },
    ]
    for (const attempt of callbacks) {
      assert.throws(
        () =>
          parent
            .relation(attempt.relation)
            .constrain((provided) =>
              attempt.callback(provided as unknown as Query),
            ),
        denied,
      )
      assert.equal((await client.models.Tag!.get()).length, 0)
      assert.equal((await client.models.Image!.get()).length, 0)
      assert.equal(
        (
          await client.storage.read((executor) =>
            client.storage.pending(executor),
          )
        ).length,
        0,
      )
      assert.equal(publications, 0)
    }
    let escaped: (() => QueryOptions) | undefined
    parent.relation('tags').constrain((provided) => {
      escaped = () => provided.where('label', 'After session').toAST()
      return provided
    })
    await client.setSession({ ...client.storage.session, accountId: 'actor-2' })
    assert.throws(
      escaped!,
      (error) =>
        error instanceof SynloquentError && error.code === 'session_changed',
    )
  } finally {
    stop()
    await client.close()
  }
})

test('C35 legal detached constraint AST and nested callbacks retain remote relation reads aggregates and readonly children', async () => {
  const fixture = projectedTransport()
  const parent = item('1', { name: 'Detached legal owner' })
  fixture.records.set('Item:1', parent)
  let observed: QueryOptions | undefined
  fixture.transport.query = async (request) => {
    observed = request.payload.include?.tags
    return {
      records: [parent],
      related: observed
        ? [
            {
              model: 'Tag',
              id: '5',
              revision: '1',
              attributes: { id: 5, label: 'Allowed' },
            },
          ]
        : [],
      relationSets: observed
        ? [
            {
              model: 'Item',
              relation: 'tags',
              parentId: '1',
              revision: '1',
              completeness: 'complete',
              targets: [
                { id: '5', attributes: { position: 1, featured: false } },
              ],
            },
          ]
        : [],
      completeness: 'complete',
      scope: {
        dataset: 'default',
        schemaFingerprint: manifest.fingerprint,
        authorizationGeneration: 'auth-1',
        projectionGeneration: 'projection-1',
        completeness: 'complete',
      },
    }
  }
  const client = await createSynloquent(
    configuration(':memory:', fixture.transport),
  )
  try {
    const remote = await client.models.Item!.remote().firstOrFail()
    const relation = remote.relation('tags').constrain((provided) =>
      provided
        .whereGroup((nested) => nested.where('label', 'Allowed'))
        .when(true, (nested) => nested.select('label').addSelect('id'))
        .orderBy('label')
        .limit(3),
    )
    assert.equal(await relation.count(), 1)
    assert.equal(await relation.exists(), true)
    assert.equal(await relation.min('label'), 'Allowed')
    const related = await relation.withPivot('position').first()
    assert.equal(related!.attributes.label, 'Allowed')
    assert.equal(related!.remoteResult, true)
    assert.throws(
      () => (related as unknown as ModelInstance).fill({ label: 'Blocked' }),
      (error) =>
        error instanceof SynloquentError &&
        error.code === 'forbidden_operation',
    )
    assert.equal(observed!.limit, 3)
    assert.deepEqual(observed!.select, ['label', 'id'])
    assert.deepEqual(observed!.where, {
      kind: 'comparison',
      field: 'label',
      operator: '=',
      value: 'Allowed',
    })
    assert.equal((await client.models.Tag!.get()).length, 0)
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      0,
    )
  } finally {
    await client.close()
  }
})

test('C35 local relation supplied query retains existing editable callback behavior', async () => {
  const client = await createSynloquent(configuration())
  try {
    await client.storage.write((executor, changed) =>
      client.storage.ingest(
        item('1', { name: 'Local constraint owner' }),
        executor,
        changed,
      ),
    )
    const parent = await client.models.Item!.findOrFail('1')
    let created: Promise<ModelInstance> | undefined
    parent.relation('tags').constrain((provided) => {
      created = provided.create({ label: 'Local callback write' })
      return provided.where('label', 'Local callback write')
    })
    await created
    assert.equal(
      (await client.models.Tag!.get()).first()!.attributes.label,
      'Local callback write',
    )
    const entries = await client.storage.read((executor) =>
      client.storage.pending(executor),
    )
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.operation.model, 'Tag')
    assert.equal(entries[0]!.operation.action, 'create')
  } finally {
    await client.close()
  }
})
