import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseOwner } from '../src/core/database.js'
import { SynloquentError } from '../src/core/errors.js'
import type { ErrorCode } from '../src/core/errors.js'
import type { DigestLifecycle } from '../src/core/types.js'
import { createSynloquent } from '../src/index.js'
import { configuration, item, snapshotFor } from './fixtures.js'
import { openTestDatabase } from './sqlite.js'

function deferred<Result>() {
  let resolve: (value: Result) => void = () => {}
  let reject: (failure: unknown) => void = () => {}
  const promise = new Promise<Result>((fulfill, fail) => {
    resolve = fulfill
    reject = fail
  })
  return { promise, resolve, reject }
}

function observe<Result>(promise: Promise<Result>) {
  return promise.then<
    PromiseSettledResult<Result>,
    PromiseSettledResult<Result>
  >(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  )
}

function assertFailure(
  result: PromiseSettledResult<unknown>,
  code: ErrorCode,
): SynloquentError {
  assert.equal(result.status, 'rejected')
  assert.ok(result.status === 'rejected')
  assert.ok(result.reason instanceof SynloquentError)
  assert.equal(result.reason.code, code)
  return result.reason
}

function pendingVerification(
  owner: DatabaseOwner,
  onStart: (lifecycle: DigestLifecycle) => void = () => {},
) {
  const started = deferred<void>()
  const provider = deferred<string>()
  let lifecycle: DigestLifecycle | undefined
  const result = observe(
    owner.verifyDigest((current) => {
      lifecycle = current
      onStart(current)
      started.resolve()
      return provider.promise
    }),
  )
  return {
    result,
    provider,
    started: started.promise,
    lifecycle() {
      assert.ok(lifecycle)
      return lifecycle
    },
  }
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

test('completed digest keeps its lifecycle invalidatable when newer verification begins', async () => {
  const owner = new DatabaseOwner(openTestDatabase())
  let completedListenerCalls = 0
  let afterSettlementCalls = 0
  try {
    const first = await owner.verifyDigest(async (lifecycle) => {
      lifecycle.subscribe(() => completedListenerCalls++)
      return lifecycle
    })
    assert.equal(first.cancelled, false)
    first.subscribe(() => afterSettlementCalls++)
    const latest = await owner.verifyDigest(async (lifecycle) => lifecycle)
    assert.equal(first.cancelled, true)
    assert.equal(latest.cancelled, false)
    assert.equal(completedListenerCalls, 0)
    assert.equal(afterSettlementCalls, 1)
    await owner.verifyDigest(async () => 'third')
    assert.equal(latest.cancelled, true)
    assert.equal(afterSettlementCalls, 1)
  } finally {
    await owner.close()
  }
})

test('completed verification becomes stale before its queued replacement can write', async () => {
  const owner = new DatabaseOwner(openTestDatabase())
  const releaseQueue = deferred<void>()
  const queueStarted = deferred<void>()
  let replacementEntered = false
  try {
    await owner.write(async (executor) => {
      await executor.execute('CREATE TABLE digest_witness (value TEXT)')
    })
    const current = await owner.verifyDigest(async (lifecycle) => lifecycle)
    const blocking = owner.read(async () => {
      queueStarted.resolve()
      await releaseQueue.promise
    })
    await queueStarted.promise
    const installation = observe(
      owner.replace(async (executor, changed) => {
        replacementEntered = true
        if (current.cancelled)
          throw new SynloquentError('session_changed', 'Digest is stale.')
        await executor.execute('INSERT INTO digest_witness VALUES (?)', ['old'])
        changed.add('digest_witness')
      }),
    )
    await owner.verifyDigest(async () => 'new digest')
    releaseQueue.resolve()
    await blocking
    assertFailure(await installation, 'session_changed')
    assert.equal(replacementEntered, true)
    assert.equal(owner.generation, 0)
    const witness = await owner.read((executor) =>
      executor.execute('SELECT * FROM digest_witness'),
    )
    assert.deepEqual(witness.rows, [])
  } finally {
    releaseQueue.resolve()
    await owner.close()
  }
})

test('newer snapshot invalidates an already verified queued installation and only publishes latest data', async () => {
  const client = await createSynloquent(configuration())
  const releaseQueue = deferred<void>()
  const queueStarted = deferred<void>()
  const firstQueued = deferred<void>()
  const secondQueued = deferred<void>()
  const owner = client.storage.owner
  const replace = owner.replace.bind(owner)
  let replacementCalls = 0
  let publications = 0
  let stagingCalls = 0
  const unsubscribe = owner.subscribe(() => publications++)
  owner.replace = (callback) => {
    replacementCalls++
    if (replacementCalls === 1) firstQueued.resolve()
    if (replacementCalls === 2) secondQueued.resolve()
    return replace(async (executor, changed) => {
      const originalExecute = executor.execute.bind(executor)
      return callback(
        {
          ...executor,
          execute(statement, parameters) {
            if (statement.startsWith('CREATE TEMP TABLE')) stagingCalls++
            return originalExecute(statement, parameters)
          },
        },
        changed,
      )
    })
  }
  try {
    const blocking = owner.read(async () => {
      queueStarted.resolve()
      await releaseQueue.promise
    })
    await queueStarted.promise
    const previous = observe(
      client.sync.installSnapshot({
        ...snapshotFor([item('1', { name: 'Previous verified snapshot' })]),
        generation: 'previous-generation',
        cursor: 'previous-cursor',
      }),
    )
    await firstQueued.promise
    const latest = client.sync.installSnapshot({
      ...snapshotFor([item('2', { name: 'Latest verified snapshot' })]),
      generation: 'latest-generation',
      cursor: 'latest-cursor',
    })
    await secondQueued.promise
    releaseQueue.resolve()
    await blocking
    assertFailure(await previous, 'session_changed')
    await latest
    assert.equal(await client.models.Item!.find('1'), null)
    assert.equal(
      (await client.models.Item!.findOrFail('2')).attributes.name,
      'Latest verified snapshot',
    )
    assert.equal(
      await client.storage.metadata('cursor:default'),
      'latest-cursor',
    )
    assert.equal(
      await client.storage.metadata('snapshotGeneration'),
      'latest-generation',
    )
    assert.equal(publications, 1)
    assert.equal(owner.generation, 1)
    assert.equal(stagingCalls, 1)
  } finally {
    releaseQueue.resolve()
    owner.replace = replace
    unsubscribe()
    await client.close()
  }
})

test('superseding before dispatch skips the old provider callback', async () => {
  const owner = new DatabaseOwner(openTestDatabase())
  let previousCalls = 0
  try {
    const previous = observe(
      owner.verifyDigest(async () => {
        previousCalls++
        return 'obsolete'
      }),
    )
    assert.equal(await owner.verifyDigest(async () => 'latest'), 'latest')
    assertFailure(await previous, 'session_changed')
    assert.equal(previousCalls, 0)
  } finally {
    await owner.close()
  }
})

for (const settlement of ['success', 'rejection'] as const) {
  test(`pending replacement rejects once and handles late provider ${settlement}`, async () => {
    const owner = new DatabaseOwner(openTestDatabase())
    let cancellationCalls = 0
    const previous = pendingVerification(owner, (lifecycle) => {
      lifecycle.subscribe(() => cancellationCalls++)
    })
    try {
      await previous.started
      assert.equal(await owner.verifyDigest(async () => 'latest'), 'latest')
      const failure = assertFailure(await previous.result, 'session_changed')
      assert.equal(previous.lifecycle().cancelled, true)
      if (settlement === 'success') previous.provider.resolve('late result')
      else previous.provider.reject(new Error('late provider failure'))
      await nextTurn()
      assert.equal(
        assertFailure(await previous.result, 'session_changed'),
        failure,
      )
      assert.equal(cancellationCalls, 1)
      assert.equal(
        await owner.read(async () => 'owner remains usable'),
        'owner remains usable',
      )
    } finally {
      previous.provider.resolve('cleanup')
      await owner.close()
    }
  })

  test(`close finishes without awaiting late provider ${settlement}`, async () => {
    const owner = new DatabaseOwner(openTestDatabase())
    let cancellationCalls = 0
    const pending = pendingVerification(owner, (lifecycle) => {
      lifecycle.subscribe(() => cancellationCalls++)
    })
    try {
      await pending.started
      await owner.close()
      assertFailure(await pending.result, 'closed_database')
      assert.equal(pending.lifecycle().cancelled, true)
      assert.equal(cancellationCalls, 1)
      if (settlement === 'success') pending.provider.resolve('late result')
      else pending.provider.reject(new Error('late close failure'))
      await nextTurn()
      assert.equal(cancellationCalls, 1)
    } finally {
      pending.provider.resolve('cleanup')
      await owner.close()
    }
  })
}

test('provider rejection keeps exact error identity and its lifecycle can still be superseded', async () => {
  const owner = new DatabaseOwner(openTestDatabase())
  const pending = pendingVerification(owner)
  const failure = new Error('owned provider failure')
  let notifications = 0
  try {
    await pending.started
    pending.provider.reject(failure)
    const result = await pending.result
    assert.ok(result.status === 'rejected')
    assert.equal(result.reason, failure)
    pending.lifecycle().subscribe(() => notifications++)
    await owner.verifyDigest(async () => 'recovered')
    assert.equal(pending.lifecycle().cancelled, true)
    assert.equal(notifications, 1)
  } finally {
    await owner.close()
  }
})

test('synchronous callback failure is preserved by identity and does not poison the queue', async () => {
  const owner = new DatabaseOwner(openTestDatabase())
  const failure = new Error('synchronous digest failure')
  try {
    const result = await observe(
      owner.verifyDigest(() => {
        throw failure
      }),
    )
    assert.ok(result.status === 'rejected')
    assert.equal(result.reason, failure)
    assert.equal(await owner.write(async () => 'usable'), 'usable')
  } finally {
    await owner.close()
  }
})

test('replace cancels a pending digest before transaction work and publishes the new generation', async () => {
  const owner = new DatabaseOwner(openTestDatabase())
  const events: string[] = []
  const pending = pendingVerification(owner, (lifecycle) => {
    lifecycle.subscribe(() => events.push('cancelled'))
  })
  const unsubscribe = owner.subscribe((tables, generation) => {
    assert.deepEqual([...tables], ['replacement'])
    assert.equal(generation, 1)
    events.push('published')
  })
  try {
    await pending.started
    await owner.replace(async (_executor, changed) => {
      assert.equal(pending.lifecycle().cancelled, true)
      events.push('transaction')
      changed.add('replacement')
    })
    assertFailure(await pending.result, 'session_changed')
    assert.deepEqual(events, ['cancelled', 'transaction', 'published'])
  } finally {
    unsubscribe()
    pending.provider.resolve('late replacement')
    await owner.close()
  }
})

test('unsubscribe duplicate listeners removal reentrancy and listener failure preserve notification order', async () => {
  const owner = new DatabaseOwner(openTestDatabase())
  const observations: string[] = []
  const pending = pendingVerification(owner, (lifecycle) => {
    const unsubscribe = lifecycle.subscribe(() => observations.push('removed'))
    unsubscribe()
    unsubscribe()
    const duplicate = () => observations.push('duplicate')
    let removeFollowing = () => {}
    lifecycle.subscribe(() => {
      observations.push('first')
      removeFollowing()
      lifecycle.subscribe(() => observations.push('reentrant'))()
    })
    removeFollowing = lifecycle.subscribe(() => observations.push('following'))
    lifecycle.subscribe(() => {
      observations.push('throwing')
      throw new Error('ignored listener failure')
    })
    lifecycle.subscribe(duplicate)
    lifecycle.subscribe(duplicate)
  })
  try {
    await pending.started
    await owner.verifyDigest(async () => 'latest')
    assertFailure(await pending.result, 'session_changed')
    assert.deepEqual(observations, [
      'first',
      'reentrant',
      'throwing',
      'duplicate',
    ])
    const failure = new Error('immediate subscription failure')
    assert.throws(
      () =>
        pending.lifecycle().subscribe(() => {
          throw failure
        }),
      (actual) => actual === failure,
    )
  } finally {
    pending.provider.resolve('late listeners')
    await owner.close()
  }
})

test('cancellation listener may start another verification without cancelling the outer newer operation', async () => {
  const owner = new DatabaseOwner(openTestDatabase())
  let nested: Promise<string> | undefined
  const pending = pendingVerification(owner, (lifecycle) => {
    lifecycle.subscribe(() => {
      nested = owner.verifyDigest(async () => 'nested')
    })
  })
  try {
    await pending.started
    assert.equal(await owner.verifyDigest(async () => 'outer'), 'outer')
    assert.equal(await nested, 'nested')
    assertFailure(await pending.result, 'session_changed')
  } finally {
    pending.provider.resolve('late reentrant')
    await owner.close()
  }
})

test('concurrent and reentrant close cancel a never settling provider and close the adapter once', async () => {
  const database = openTestDatabase()
  let adapterCloseCalls = 0
  const owner = new DatabaseOwner({
    ...database,
    async close() {
      adapterCloseCalls++
      await database.close()
    },
  })
  let reentrantClose: Promise<void> | undefined
  const pending = pendingVerification(owner, (lifecycle) => {
    lifecycle.subscribe(() => {
      reentrantClose = owner.close()
    })
  })
  await pending.started
  await Promise.all([owner.close(), owner.close()])
  await reentrantClose
  assertFailure(await pending.result, 'closed_database')
  assert.equal(adapterCloseCalls, 1)
  assert.equal(owner.generation, 1)
  assert.equal(owner.listenerCount, 0)
  await owner.close()
  assert.equal(adapterCloseCalls, 1)
})

for (const firstAction of ['close', 'supersede'] as const) {
  test(`first cancellation reason wins when ${firstAction} races later cancellation`, async () => {
    const owner = new DatabaseOwner(openTestDatabase())
    const pending = pendingVerification(owner)
    try {
      await pending.started
      if (firstAction === 'close') {
        const closing = owner.close()
        const newer = observe(owner.verifyDigest(async () => 'blocked'))
        await closing
        assertFailure(await pending.result, 'closed_database')
        assertFailure(await newer, 'closed_database')
      } else {
        const newer = observe(owner.verifyDigest(async () => 'replaced'))
        await owner.close()
        assertFailure(await pending.result, 'session_changed')
        assertFailure(await newer, 'closed_database')
      }
    } finally {
      pending.provider.reject(new Error('late priority rejection'))
      await nextTurn()
      await owner.close()
    }
  })
}

test('closing owner rejects verification before queued reads finish and completed lifecycle is cancelled', async () => {
  const owner = new DatabaseOwner(openTestDatabase())
  const queued = deferred<void>()
  const started = deferred<void>()
  let callbackCalls = 0
  try {
    const lifecycle = await owner.verifyDigest(async (current) => current)
    const reading = owner.read(async () => {
      started.resolve()
      await queued.promise
    })
    await started.promise
    const closing = owner.close()
    assert.equal(lifecycle.cancelled, true)
    assertFailure(
      await observe(
        owner.verifyDigest(async () => {
          callbackCalls++
          return 'blocked'
        }),
      ),
      'closed_database',
    )
    assert.equal(callbackCalls, 0)
    queued.resolve()
    await reading
    await closing
    assertFailure(
      await observe(owner.verifyDigest(async () => 'still blocked')),
      'closed_database',
    )
  } finally {
    queued.resolve()
    await owner.close()
  }
})
