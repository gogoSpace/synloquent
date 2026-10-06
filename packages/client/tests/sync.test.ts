import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createSynloquent as createClient,
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
import { testTransport } from './transport-fixture.js'

test('C01 C53 C57 lost response retries immutable intent and integer aliases atomically remap parent/child', async () => {
  const server = testTransport()
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  try {
    const parent = await client.models.Item!.create({ name: 'Parent' })
    const child = await parent.relation('images').create({ url: 'child.jpg' })
    const identity = parent.localIdentity
    server.loseNextResponse()
    await assert.rejects(client.sync.flush(), /response lost/)
    parent.fill({ name: 'Edited after attempt' })
    await parent.save()
    client.sync.resumeAuthentication()
    await client.sync.flush()
    assert.equal(server.records.size, 2)
    const refreshed = await client.models.Item!.findOrFail(identity)
    assert.equal(refreshed.localIdentity, identity)
    assert.equal(refreshed.syncState, 'synced')
    assert.equal(refreshed.attributes.name, 'Edited after attempt')
    assert.equal(
      (await client.models.Image!.findOrFail(child.localIdentity)).attributes
        .item_id,
      refreshed.id,
    )
    assert.equal(
      (
        await client.models
          .Item!.with('images')
          .findOrFail(refreshed.id as string)
      ).relation('images').current?.length,
      1,
    )
    assert.equal(server.receipts.size, 3)
  } finally {
    await client.close()
  }
})

test('C53 C57 canonical pulls preserve unacknowledged proposal and conflict resolution is explicit', async () => {
  const server = testTransport()
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  try {
    const model = await client.models.Item!.create({ name: 'Initial' })
    await client.sync.flush()
    await model.refresh()
    await model.update({ name: 'Local proposal' })
    const current = server.records.values().next().value!
    server.records.set(`Item:${current.id}`, {
      ...current,
      revision: '2',
      attributes: { ...current.attributes, name: 'Remote changed', count: 5 },
    })
    await client.sync.pull()
    const pulled = await client.models.Item!.findOrFail(model.localIdentity)
    assert.equal(pulled.attributes.name, 'Local proposal')
    assert.equal(pulled.attributes.count, 5)
    await client.sync.flush()
    const conflicted = await client.models.Item!.findOrFail(model.localIdentity)
    assert.equal(conflicted.syncState, 'conflicted')
    assert.equal(conflicted.attributes.name, 'Local proposal')
    const conflict = await client.storage.read(async (executor) =>
      (await client.storage.pending(executor)).find(
        (entry) => entry.status === 'conflicted',
      )!,
    )
    await client.sync.resolveConflict(conflict.operation.operationId, 'retry')
    await client.sync.flush()
    assert.equal(
      (await client.models.Item!.findOrFail(model.localIdentity)).syncState,
      'synced',
    )
    assert.equal(
      server.records.get(`Item:${current.id}`)?.attributes.name,
      'Local proposal',
    )
  } finally {
    await client.close()
  }
})

test('C55 immutable staged snapshot rejects corruption and preserves pending local creation', async () => {
  const server = testTransport()
  server.records.set('Item:8', item('8', { name: 'Snapshot' }))
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  try {
    const draft = await client.models.Item!.create({ name: 'Offline pending' })
    const snapshot = await server.transport.snapshot(
      client.sync.envelope('snapshot', { dataset: 'default' }),
    )
    await assert.rejects(
      client.sync.installSnapshot({ ...snapshot, hash: 'corrupt' }),
      (error) =>
        error instanceof SynloquentError && error.code === 'snapshot_invalid',
    )
    assert.equal(await client.models.Item!.count(), 1)
    await client.sync.installSnapshot(snapshot)
    assert.equal(await client.models.Item!.count(), 2)
    assert.equal(
      (await client.models.Item!.findOrFail(draft.localIdentity)).attributes
        .name,
      'Offline pending',
    )
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      1,
    )
    assert.throws(
      () => draft.attributes,
      (error) =>
        error instanceof SynloquentError && error.code === 'session_changed',
    )
  } finally {
    await client.close()
  }
})

test('C56 logout invalidates cached models and refuses a late push response', async () => {
  const server = testTransport()
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const original = server.transport.push
  server.transport.push = async (request) => {
    started!()
    await barrier
    return original(request)
  }
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  try {
    const model = await client.models.Item!.create({ name: 'Old account' })
    const sending = client.sync.flush()
    await ready
    await client.setSession({ ...client.storage.session, accountId: 'actor-2' })
    assert.throws(
      () => model.attributes,
      (error) =>
        error instanceof SynloquentError && error.code === 'session_changed',
    )
    release!()
    await assert.rejects(
      sending,
      (error) =>
        error instanceof SynloquentError && error.code === 'session_changed',
    )
    assert.equal(await client.models.Item!.allowPartial().count(), 0)
    await client.setSession({ ...client.storage.session, accountId: 'actor-1' })
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      )[0]?.status,
      'pending',
    )
  } finally {
    release?.()
    await client.close()
  }
})

test('C51 query subscriptions keep stable snapshots and dispose all listeners', async () => {
  const client = await createSynloquent(configuration())
  try {
    const subscription = client.observe(client.models.Item!)
    await subscription.refresh()
    const snapshot = subscription.getSnapshot()
    assert.equal(subscription.getSnapshot(), snapshot)
    let changed = 0
    const unsubscribe = subscription.subscribe(() => {
      changed += 1
    })
    await client.models.Item!.create({ name: 'Reactive' })
    await subscription.refresh()
    assert.equal(subscription.getSnapshot().data.length, 1)
    assert.ok(changed > 0)
    unsubscribe()
    subscription.dispose()
    assert.equal(client.storage.owner.listenerCount, 0)
    assert.throws(() => subscription.subscribe(() => {}), /disposed/)
  } finally {
    await client.close()
  }
})

test('C27 causal remote atomic group queues complete topologically ordered durable intent and C57 confirmed create', async () => {
  const server = testTransport()
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  try {
    await client.sync.atomicGroup('family-group', [
      {
        operationId: 'child-operation',
        model: 'Image',
        localIdentity: 'child-local',
        action: 'create',
        values: {
          item_id: { $ref: { model: 'Item', localIdentity: 'parent-local' } },
          url: 'group.jpg',
        },
        dependsOn: ['parent-operation'],
      },
      {
        operationId: 'parent-operation',
        model: 'Item',
        localIdentity: 'parent-local',
        action: 'create',
        values: { name: 'Atomic parent' },
        dependsOn: [],
      },
    ])
    const queue = await client.storage.read((executor) =>
      client.storage.pending(executor),
    )
    assert.deepEqual(
      queue.map((entry) => entry.operation.operationId),
      ['parent-operation', 'child-operation'],
    )
    assert.equal(
      queue.every((entry) => entry.operation.atomicGroup === 'family-group'),
      true,
    )
    await client.sync.flush()
    assert.equal(server.records.size, 2)
    const confirmed = await client.models.Item!.createConfirmed({
      name: 'Confirmed create',
    })
    assert.equal(
      await client.sync.status(confirmed.lastOperationId!),
      'accepted',
    )
    await assert.rejects(
      client.sync.atomicGroup('cycle', [
        {
          operationId: 'a',
          model: 'Item',
          localIdentity: 'a',
          action: 'create',
          values: { name: 'A' },
          dependsOn: ['b'],
        },
        {
          operationId: 'b',
          model: 'Item',
          localIdentity: 'b',
          action: 'create',
          values: { name: 'B' },
          dependsOn: ['a'],
        },
      ]),
      /cycle/,
    )
  } finally {
    await client.close()
  }
})
