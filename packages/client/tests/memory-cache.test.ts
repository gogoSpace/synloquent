import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSynloquent } from '../src/index.js'
import { DatabaseOwner } from '../src/core/database.js'
import { createMemoryBudgetPolicy } from '../src/core/memory-budget.js'
import type {
  MemoryBudgetPolicy,
  MemoryWorkBudget,
} from '../src/core/memory-budget.js'
import {
  memoryCacheForOwner,
  RecoverableMemoryCache,
  recoverableCacheLimits,
} from '../src/core/memory-cache.js'
import { configuration, item } from './fixtures.js'
import { openTestDatabase } from './sqlite.js'

function controlledBudget(
  maximumCacheEntries: number,
  maximumCacheBytes: number,
) {
  const actual = createMemoryBudgetPolicy({ nowMilliseconds: () => 0 })
  let budget = { ...actual.current(), maximumCacheEntries, maximumCacheBytes }
  const policy: MemoryBudgetPolicy = {
    current: () => budget,
    observe: () => budget,
    close() {},
  }
  return {
    policy,
    setBudget(update: Partial<MemoryWorkBudget>) {
      budget = { ...budget, ...update }
    },
  }
}

test('cache enforces entry and byte limits with least-recently-used eviction', () => {
  const control = controlledBudget(2, 100)
  const cache = new RecoverableMemoryCache(control.policy)
  const first = {},
    second = {},
    third = {}
  assert.equal(cache.set(first, 'first', 40), true)
  assert.equal(cache.set(second, 'second', 40), true)
  assert.equal(cache.get(first), 'first')
  assert.equal(cache.set(third, 'third', 50), true)
  assert.equal(cache.get(second), undefined)
  assert.equal(cache.get(first), 'first')
  assert.equal(cache.retainedBytes, 90)
  assert.equal(cache.size, 2)
  cache.close()
})

test('oversize and invalid weights are rejected without retaining a prior entry', () => {
  const control = controlledBudget(2, 100)
  const cache = new RecoverableMemoryCache(control.policy)
  const key = {}
  for (const weight of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    101,
  ]) {
    assert.equal(cache.set(key, 'old', 10), true)
    assert.equal(cache.set(key, 'oversized', weight), false)
    assert.equal(cache.get(key), undefined)
    assert.equal(cache.retainedBytes, 0)
  }
  cache.close()
})

test('caller supplied ceilings cannot exceed fixed recoverable cache limits', () => {
  const control = controlledBudget(1000, Number.MAX_SAFE_INTEGER)
  const cache = new RecoverableMemoryCache(control.policy)
  for (let index = 0; index < 1000; index += 1) cache.set({}, index, 1)
  assert.equal(cache.size, recoverableCacheLimits.maximumEntries)
  assert.equal(
    cache.set({}, 'too large', recoverableCacheLimits.maximumBytes + 1),
    false,
  )
  cache.close()
})

test('invalid ceilings and unavailable policy fail closed', () => {
  const control = controlledBudget(10, 1000)
  const cache = new RecoverableMemoryCache(control.policy)
  cache.set({}, 'value', 10)
  control.setBudget({ maximumCacheEntries: NaN })
  cache.reduceToCurrentBudget()
  assert.equal(cache.size, 0)
  assert.equal(cache.set({}, 'value', 10), false)
  const throwing = new RecoverableMemoryCache({
    ...control.policy,
    current() {
      throw new Error('unavailable')
    },
  })
  assert.equal(throwing.set({}, 'value', 10), false)
  cache.close()
  throwing.close()
})

test('pressure reduction releases only bounded registry references and leaves caller values untouched', () => {
  const policy = createMemoryBudgetPolicy({
    nowMilliseconds: () => 0,
    onCacheBudgetReduced: () => cache?.reduceToCurrentBudget(),
  })
  const cache = new RecoverableMemoryCache(policy)
  let graphReads = 0
  const caller = {
    get nested() {
      graphReads += 1
      throw new Error('must not walk')
    },
  }
  for (let index = 0; index < 64; index += 1) cache.set({}, caller, 10)
  assert.equal(cache.size, 64)
  policy.observe({
    observedAtMilliseconds: 0,
    validity: 'unavailable',
    pressure: 'critical',
  })
  assert.equal(cache.size, 0)
  assert.equal(cache.retainedBytes, 0)
  assert.equal(graphReads, 0)
  assert.ok(Object.getOwnPropertyDescriptor(caller, 'nested')?.get)
  cache.close()
})

test('clear and close are idempotent and cannot reopen retention', () => {
  const cache = new RecoverableMemoryCache()
  const key = {}
  cache.set(key, 'caller', 10)
  cache.clear()
  cache.clear()
  assert.equal(cache.retainedBytes, 0)
  cache.set(key, 'caller', 10)
  cache.close()
  cache.close()
  assert.equal(cache.get(key), undefined)
  assert.equal(cache.set(key, 'new', 10), false)
})

test('cache is shared per owner without subscriptions and explicit lifecycle clearing preserves legacy writes', async () => {
  const owner = new DatabaseOwner(openTestDatabase())
  const other = new DatabaseOwner(openTestDatabase())
  const cache = memoryCacheForOwner(owner)
  const key = {}
  try {
    assert.equal(memoryCacheForOwner(owner), cache)
    assert.notEqual(memoryCacheForOwner(other), cache)
    assert.equal(owner.listenerCount, 0)
    cache.set(key, 'committed', 10)
    await assert.rejects(
      owner.write(async (_executor, changed) => {
        changed.add('items')
        throw new Error('rollback')
      }),
    )
    assert.equal(cache.get(key), 'committed')
    await owner.write(async (_executor, changed) => {
      assert.equal(cache.get(key), 'committed')
      changed.add('items')
    })
    assert.equal(cache.get(key), 'committed')
    cache.clear()
    assert.equal(cache.get(key), undefined)
    cache.set(key, 'next', 10)
    await owner.replace(async () => {})
    assert.equal(cache.get(key), undefined)
    cache.set(key, 'closing', 10)
    await owner.close()
    assert.equal(cache.get(key), undefined)
    assert.equal(owner.listenerCount, 0)
  } finally {
    cache.close()
    memoryCacheForOwner(other).close()
    await owner.close()
    await other.close()
  }
})

async function relationFixture(
  imageCount: number,
  url = 'image',
  withPolicy = true,
) {
  const policy = createMemoryBudgetPolicy({
    nowMilliseconds: () => 0,
    onCacheBudgetReduced: () => cache?.reduceToCurrentBudget(),
  })
  const client = await createSynloquent({
    ...configuration(),
    ...(withPolicy ? { memoryBudget: policy } : {}),
  })
  const cache = client.storage.memoryCache
  await client.storage.write(async (executor, changed) => {
    await client.storage.ingest(item('1', { name: 'Owner' }), executor, changed)
    for (let index = 1; index <= imageCount; index += 1)
      await client.storage.ingest(
        {
          model: 'Image',
          id: String(index),
          revision: '1',
          attributes: { id: String(index), item_id: 1, url },
        },
        executor,
        changed,
      )
  })
  const parent = await client.models.Item!.findOrFail('1')
  return { client, parent, policy, cache: client.storage.memoryCache }
}

test('direct relation result is complete while optional retention can be promptly evicted and rebuilt', async () => {
  const fixture = await relationFixture(3)
  try {
    const relation = fixture.parent.relation('images')
    const caller = await relation.get()
    assert.equal(caller.length, 3)
    assert.equal(relation.current?.length, 3)
    assert.equal(fixture.cache.size, 1)
    assert.equal(fixture.client.storage.owner.listenerCount, 0)
    fixture.policy.observe({
      observedAtMilliseconds: 0,
      validity: 'unavailable',
      pressure: 'warning',
    })
    assert.equal(fixture.cache.size, 0)
    assert.equal(relation.current, undefined)
    assert.equal(caller.length, 3)
    assert.equal((await relation.get()).length, 3)
    assert.equal(relation.current, undefined)
    relation.clear()
    assert.equal(relation.loaded, false)
  } finally {
    await fixture.client.close()
  }
})

test('oversize collection remains complete for get, count and extrema without registry retention', async () => {
  const fixture = await relationFixture(2, 'x'.repeat(100_000))
  try {
    const relation = fixture.parent.relation('images')
    assert.equal((await relation.get()).length, 2)
    assert.equal(relation.current, undefined)
    assert.equal(fixture.cache.size, 0)
    assert.equal(await relation.count(), 2)
    assert.equal(await relation.min('id'), '1')
    assert.equal(await relation.max('id'), '2')
    assert.equal(await relation.sum('id'), 3)
    assert.equal(await relation.avg('id'), 1.5)
  } finally {
    await fixture.client.close()
  }
})

test('eager oversize caller result remains loaded and complete across pressure', async () => {
  const fixture = await relationFixture(2, 'x'.repeat(100_000))
  try {
    const parent = await fixture.client.models
      .Item!.with('images')
      .findOrFail('1')
    const eager = parent.relation('images').current!
    assert.equal(eager.length, 2)
    assert.equal(fixture.cache.size, 0)
    fixture.policy.observe({
      observedAtMilliseconds: 0,
      validity: 'unavailable',
      pressure: 'critical',
    })
    assert.equal(parent.relation('images').current, eager)
    assert.deepEqual(await parent.loadCount('images'), { images: 2 })
    parent.relation('images').clear()
    assert.equal(parent.relation('images').current, undefined)
  } finally {
    await fixture.client.close()
  }
})

test('cache eviction does not erase durable pending work or complete explicit pending relations', async () => {
  const fixture = await relationFixture(1)
  try {
    const image = await fixture.client.models.Image!.findOrFail('1')
    await image.update({ url: 'pending-change' })
    const relation = fixture.parent.relation('images')
    const caller = await relation.get()
    assert.equal(caller.first()?.attributes.url, 'pending-change')
    assert.equal(caller.first()?.syncState, 'pending')
    assert.equal(fixture.cache.size, 0)
    const before = await fixture.client.storage.read((executor) =>
      fixture.client.storage.pending(executor),
    )
    fixture.policy.observe({
      observedAtMilliseconds: 0,
      validity: 'unavailable',
      pressure: 'warning',
    })
    assert.deepEqual(
      await fixture.client.storage.read((executor) =>
        fixture.client.storage.pending(executor),
      ),
      before,
    )
    assert.equal(caller.first()?.attributes.url, 'pending-change')
  } finally {
    await fixture.client.close()
  }
})

test('a grown caller model is reweighed and an oversized direct relation is released on access', async () => {
  const fixture = await relationFixture(1)
  try {
    const relation = fixture.parent.relation('images')
    const caller = await relation.get()
    caller.first()!.fill({ url: 'x'.repeat(100_000) })
    assert.equal(relation.current, undefined)
    assert.equal(fixture.cache.size, 0)
    assert.equal(caller.first()?.attributes.url, 'x'.repeat(100_000))
  } finally {
    await fixture.client.close()
  }
})

test('ordinary clients without a native policy still enforce finite cache ceilings', async () => {
  const fixture = await relationFixture(1, 'image', false)
  try {
    const relation = fixture.parent.relation('images')
    assert.equal((await relation.get()).length, 1)
    assert.ok(
      fixture.cache.retainedBytes <= recoverableCacheLimits.maximumBytes,
    )
    assert.ok(fixture.cache.size <= recoverableCacheLimits.maximumEntries)
    await fixture.client.storage.transaction(async (storage) => {
      assert.equal(storage.memoryCache, fixture.cache)
    })
  } finally {
    await fixture.client.close()
  }
})

test('nested eager caller data remains complete without entering optional cache retention', async () => {
  const fixture = await relationFixture(2)
  try {
    const relation = fixture.parent
      .relation('images')
      .constrain((query) => query.with('item'))
    const caller = await relation.get()
    assert.equal(caller.length, 2)
    assert.equal(caller.first()?.relation('item').current?.first()?.id, '1')
    assert.equal(relation.current, undefined)
    assert.equal(fixture.cache.size, 0)
    fixture.policy.observe({
      observedAtMilliseconds: 0,
      validity: 'unavailable',
      pressure: 'critical',
    })
    assert.equal(caller.first()?.relation('item').current?.first()?.id, '1')
  } finally {
    await fixture.client.close()
  }
})

test('account replacement and close release optional cache ownership without touching prior caller collections', async () => {
  const fixture = await relationFixture(2)
  try {
    const relation = fixture.parent.relation('images')
    const caller = await relation.get()
    assert.equal(fixture.cache.size, 1)
    await fixture.client.setSession({
      ...fixture.client.storage.session,
      accountId: 'another-account',
    })
    assert.equal(fixture.cache.size, 0)
    assert.equal(caller.length, 2)
    assert.throws(() => relation.current, { code: 'session_changed' })
    await fixture.client.close()
    assert.equal(fixture.cache.set({}, caller, 10), false)
    assert.equal(fixture.client.storage.owner.listenerCount, 0)
  } finally {
    await fixture.client.close()
  }
})
