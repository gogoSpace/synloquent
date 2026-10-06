import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSynloquent, SynloquentError } from '../src/index.js'
import type { Manifest, PushReceipt } from '../src/index.js'
import { configuration, item, manifest, snapshotFor } from './fixtures.js'
import { testTransport } from './transport-fixture.js'

const hasCode = (code: string) => (error: unknown) =>
  error instanceof SynloquentError && error.code === code

test('C51 C52 model subscription publishes committed membership across authorization replacement and logout cleanup', async () => {
  const client = await createSynloquent(configuration())
  const subscription = client.observe(client.models.Item!.where('id', '1'))
  let notifications = 0
  const unsubscribe = subscription.subscribe(() => {
    notifications += 1
  })
  try {
    await client.sync.installSnapshot(
      snapshotFor([
        item('1', { name: 'Visible' }),
        item('2', { name: 'Other' }),
      ]),
    )
    await subscription.refresh()
    const initial = subscription.getSnapshot()
    assert.equal(initial.data.length, 1)
    assert.equal(initial.data.completeness, 'complete')
    const original = initial.data.first()!
    await assert.rejects(
      client.transaction(async (transaction) => {
        await (
          await transaction.models.Item!.findOrFail('1')
        ).update({ name: 'Rolled back' })
        throw new Error('rollback membership')
      }),
      /rollback membership/,
    )
    assert.equal(subscription.getSnapshot(), initial)
    const changed = await client.models.Item!.findOrFail('1')
    await changed.update({ name: 'Committed membership' })
    await subscription.refresh()
    assert.equal(
      subscription.getSnapshot().data.first()?.attributes.name,
      'Committed membership',
    )
    const next = snapshotFor([item('2', { name: 'Other' })])
    await client.sync.installSnapshot({
      ...next,
      generation: 'snapshot-2',
      scope: { ...next.scope, authorizationGeneration: 'auth-2' },
    })
    await subscription.refresh()
    assert.equal(subscription.getSnapshot().data.length, 0)
    assert.equal((await client.sync.recovery()).length, 1)
    assert.equal(
      JSON.parse((await client.storage.metadata('scope'))!)
        .authorizationGeneration,
      'auth-2',
    )
    assert.throws(() => original.attributes, hasCode('session_changed'))
    await client.setSession({ ...client.storage.session, accountId: 'actor-2' })
    await subscription.refresh()
    assert.equal(subscription.getSnapshot().data.length, 0)
    assert.equal(subscription.getSnapshot().data.completeness, 'partial')
    assert.ok(notifications > 0)
    unsubscribe()
    subscription.dispose()
    assert.equal(client.storage.owner.listenerCount, 0)
  } finally {
    unsubscribe()
    subscription.dispose()
    await client.close()
  }
})

test('C51 model aggregate subscription releases and reacquires owner listeners after last unsubscribe', async () => {
  const client = await createSynloquent(configuration())
  const parent = await client.models.Item!.create({ name: 'Parent' })
  const subscription = client.observe(
    client.models.Item!.where('id', parent.id).withCount('images'),
  )
  let notifications = 0
  let unsubscribe = subscription.subscribe(() => {
    notifications += 1
  })
  try {
    await subscription.refresh()
    assert.equal(
      subscription.getSnapshot().data.first()?.aggregates.images_count,
      0,
    )
    unsubscribe()
    assert.equal(client.storage.owner.listenerCount, 0)
    unsubscribe = subscription.subscribe(() => {
      notifications += 1
    })
    await parent.relation('images').create({ url: 'visible.jpg' })
    await subscription.refresh()
    assert.equal(
      subscription.getSnapshot().data.first()?.aggregates.images_count,
      1,
    )
    assert.ok(notifications > 0)
    unsubscribe()
    assert.equal(client.storage.owner.listenerCount, 0)
    subscription.dispose()
  } finally {
    unsubscribe()
    subscription.dispose()
    await client.close()
  }
})

test('C56 device and epoch partitions invalidate old instances and keep distinct durable rows', async () => {
  const client = await createSynloquent(configuration())
  try {
    const originalSession = { ...client.storage.session }
    const original = await client.models.Item!.create({ name: 'First device' })
    const originalIdentity = original.localIdentity
    await client.setSession({ ...originalSession, deviceId: 'device-2' })
    assert.equal((await client.models.Item!.get()).length, 0)
    assert.throws(() => original.attributes, hasCode('session_changed'))
    const second = await client.models.Item!.create({ name: 'Second device' })
    const secondIdentity = second.localIdentity
    await client.setSession({
      ...client.storage.session,
      deviceEpoch: 'epoch-2',
    })
    assert.equal((await client.models.Item!.get()).length, 0)
    assert.throws(() => second.attributes, hasCode('session_changed'))
    await client.setSession(originalSession)
    assert.equal(
      (await client.models.Item!.findOrFail(originalIdentity)).attributes.name,
      'First device',
    )
    assert.equal(await client.models.Item!.find(secondIdentity), null)
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      1,
    )
  } finally {
    await client.close()
  }
})

test('C53 C57 host rejection retains proposal and explicit discard restores accepted canonical base', async () => {
  const server = testTransport()
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  try {
    const model = await client.models.Item!.create({ name: 'Accepted base' })
    await model.saveConfirmed()
    await model.update({ name: 'Rejected proposal' })
    const operationId = model.lastOperationId!
    server.transport.push = async (request) => ({
      receipts: request.payload.operations.map((operation): PushReceipt => ({
        operationId: operation.operationId,
        localIdentity: operation.localIdentity,
        status: 'rejected',
        error: {
          code: 'permission_denied',
          message: 'Host policy denied change',
        },
      })),
    })
    await assert.rejects(
      client.sync.confirmed(operationId),
      (error) =>
        error instanceof SynloquentError &&
        error.code === 'validation_failed' &&
        error.details.operationId === operationId &&
        (error.details.receiptError as { code?: string }).code ===
          'permission_denied',
    )
    const rejected = await client.models.Item!.findOrFail(model.localIdentity)
    assert.equal(rejected.syncState, 'rejected')
    assert.equal(rejected.attributes.name, 'Rejected proposal')
    assert.equal(rejected.canonicalRecord()?.attributes.name, 'Accepted base')
    await client.sync.resolveConflict(operationId, 'discard')
    const discarded = await client.models.Item!.findOrFail(model.localIdentity)
    assert.equal(discarded.syncState, 'synced')
    assert.equal(discarded.attributes.name, 'Accepted base')
    assert.equal(await client.sync.status(operationId), 'cancelled')
    assert.equal(
      server.records.get(`Item:${String(discarded.id)}`)?.attributes.name,
      'Accepted base',
    )
  } finally {
    await client.close()
  }
})

test('C25 atomic delta conflict preserves exact canonical integer and retries the immutable delta action', async () => {
  const server = testTransport()
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  try {
    const model = await client.models.Item!.create({
      name: 'Delta',
      count: '18446744073709551610',
    })
    await model.saveConfirmed()
    await model.increment('count', 1)
    const identity = model.localIdentity
    const operationId = model.lastOperationId!
    let pushes = 0
    server.transport.push = async (request) => {
      assert.equal(request.payload.operations.length, 1)
      const operation = request.payload.operations[0]!
      assert.equal(operation.action, 'increment')
      assert.deepEqual(operation.values, { field: 'count', delta: 1 })
      pushes += 1
      assert.equal(operation.expectedRevision, pushes === 1 ? '1' : '2')
      const canonical = item(String(model.id), {
        name: 'Delta',
        count: pushes === 1 ? '18446744073709551614' : '18446744073709551615',
      })
      return {
        receipts: [
          {
            operationId: operation.operationId,
            localIdentity: identity,
            status:
              pushes === 1 ? ('conflicted' as const) : ('accepted' as const),
            canonical: { ...canonical, revision: pushes === 1 ? '2' : '3' },
          },
        ],
      }
    }
    await client.sync.flush()
    assert.equal(
      (await client.models.Item!.findOrFail(identity)).attributes.count,
      '18446744073709551615',
    )
    assert.equal(await client.sync.status(operationId), 'conflicted')
    await client.sync.resolveConflict(operationId, 'retry')
    await client.sync.flush()
    const result = await client.models.Item!.findOrFail(identity)
    assert.equal(result.attributes.count, '18446744073709551615')
    assert.equal(result.syncState, 'synced')
    assert.equal(pushes, 2)
  } finally {
    await client.close()
  }
})

test('C58 nullify and pending cascade deletion retain canonical base and dependent outbox across snapshot', async () => {
  const schema: Manifest = {
    ...manifest,
    models: {
      ...manifest.models,
      Item: {
        ...manifest.models.Item!,
        fields: {
          ...manifest.models.Item!.fields,
          tag_id: {
            type: 'integer',
            nullable: true,
            readable: true,
            writable: true,
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
  const records = [
    {
      model: 'Tag',
      id: '1',
      revision: '1',
      attributes: { id: '1', label: 'Nullified' },
    },
    item('1', { name: 'Parent', tag_id: '1' }),
    {
      model: 'Image',
      id: '1',
      revision: '1',
      attributes: { id: '1', item_id: '1', url: 'canonical.jpg' },
    },
  ]
  const client = await createSynloquent({ ...configuration(), schema })
  try {
    await client.sync.installSnapshot(snapshotFor(records, schema))
    await (await client.models.Tag!.findOrFail('1')).delete()
    const nullified = await client.models.Item!.findOrFail('1')
    assert.equal(nullified.attributes.tag_id, null)
    assert.equal(nullified.canonicalRecord()?.attributes.tag_id, '1')
    assert.equal(nullified.syncState, 'pending')
    const child = await client.models.Image!.findOrFail('1')
    await child.update({ url: 'retained.jpg' })
    const childOperation = child.lastOperationId!
    await nullified.forceDelete()
    assert.equal(await client.models.Image!.find('1'), null)
    assert.equal(await client.sync.status(childOperation), 'pending')
    await client.sync.installSnapshot({
      ...snapshotFor(records, schema),
      generation: 'snapshot-2',
    })
    assert.equal(await client.models.Item!.withTrashed().find('1'), null)
    assert.equal(await client.models.Image!.find('1'), null)
    const retained = await client.storage.read((executor) =>
      client.storage.findStored('Image', '1', executor),
    )
    assert.equal(retained?.proposal.url, 'retained.jpg')
    assert.equal(retained?.canonical.url, 'canonical.jpg')
    assert.equal(retained?.state, 'pending')
    assert.equal(
      (
        await client.storage.read((executor) =>
          executor.execute('PRAGMA foreign_key_check'),
        )
      ).rows.length,
      0,
    )
  } finally {
    await client.close()
  }
})

test('C51 observation keys retain remote mode and partial opt-in while actual subscriptions read the selected execution source', async () => {
  const server = testTransport()
  server.records.set('Item:1', item('1', { name: 'Remote result' }))
  server.transport.query = async (request) => ({
    records: request.payload.aggregate ? [] : [...server.records.values()],
    related: [],
    relationSets: [],
    completeness: 'partial',
    scope: snapshotFor([]).scope,
    ...(request.payload.aggregate ? { aggregate: { value: 1 } } : {}),
  })
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  const local = client.models.Item!.where('id', '1')
  const remote = local.remote()
  const partial = remote.allowPartial()
  const localObservation = client.observe(local)
  const remoteObservation = client.observe(partial)
  try {
    await client.storage.write((executor, changed) =>
      client.storage.ingest(
        item('1', { name: 'Local result' }),
        executor,
        changed,
      ),
    )
    assert.deepEqual(local.toAST(), remote.toAST())
    assert.deepEqual(remote.toAST(), partial.toAST())
    assert.notEqual(local.observationKey, remote.observationKey)
    assert.notEqual(remote.observationKey, partial.observationKey)
    assert.equal(
      local.observationKey,
      client.models.Item!.where('id', '1').observationKey,
    )
    await assert.rejects(remote.count(), hasCode('incomplete_dataset'))
    assert.equal(await partial.count(), 1)
    await localObservation.refresh()
    await remoteObservation.refresh()
    assert.equal(
      localObservation.getSnapshot().data.first()?.attributes.name,
      'Local result',
    )
    assert.equal(
      remoteObservation.getSnapshot().data.first()?.attributes.name,
      'Remote result',
    )
    assert.equal(
      remoteObservation
        .getSnapshot()
        .data.first()
        ?.localIdentity.startsWith('remote:'),
      true,
    )
    assert.equal(remoteObservation.getSnapshot().data.completeness, 'partial')
  } finally {
    localObservation.dispose()
    remoteObservation.dispose()
    await client.close()
  }
})

test('C57 unattempted dependency cancellation requires leaves first and restores a standalone physical delete', async () => {
  const client = await createSynloquent(configuration())
  try {
    await client.sync.installSnapshot(
      snapshotFor([item('1', { name: 'Retained canonical' })]),
    )
    const canonical = await client.models.Item!.findOrFail('1')
    await canonical.forceDelete()
    assert.equal(await client.models.Item!.find('1'), null)
    const deletion = canonical.lastOperationId!
    await client.sync.cancel(deletion)
    assert.equal(await client.sync.status(deletion), 'cancelled')
    assert.equal(
      (await client.models.Item!.findOrFail('1')).attributes.name,
      'Retained canonical',
    )
    assert.equal(
      (await client.models.Item!.findOrFail('1')).syncState,
      'synced',
    )
    const parent = await client.models.Item!.create({ name: 'Offline parent' })
    const child = await parent.relation('images').create({ url: 'offline.jpg' })
    await assert.rejects(
      client.sync.cancel(parent.lastOperationId!),
      hasCode('forbidden_operation'),
    )
    assert.equal(await client.sync.status(parent.lastOperationId!), 'pending')
    assert.equal(await client.sync.status(child.lastOperationId!), 'pending')
    assert.equal(
      (await client.models.Image!.findOrFail(child.localIdentity)).attributes
        .item_id,
      parent.localIdentity,
    )
    await client.sync.cancel(child.lastOperationId!)
    await client.sync.cancel(parent.lastOperationId!)
    assert.equal(await client.models.Image!.find(child.localIdentity), null)
    assert.equal(await client.models.Item!.find(parent.localIdentity), null)
    assert.equal(
      (
        await client.storage.read((executor) =>
          executor.execute('PRAGMA foreign_key_check'),
        )
      ).rows.length,
      0,
    )
  } finally {
    await client.close()
  }
})
