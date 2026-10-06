import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSynloquent, SynloquentError } from '../src/index.js'
import { configuration } from './fixtures.js'
import { testTransport } from './transport-fixture.js'

for (const phase of ['before-commit', 'after-commit'])
  test(`C26 C53 durable process death ${phase} preserves data and outbox atomically`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'synloquent-process-recovery-'),
    )
    const filename = join(directory, 'recovery.sqlite')
    const child = fork(
      new URL('./fixtures/recovery-child.ts', import.meta.url),
      [filename, phase],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    )
    let diagnostic = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      diagnostic += chunk.toString()
    })
    try {
      const ready = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => {
          throw new Error(
            `Child exited before transaction barrier. ${diagnostic}`,
          )
        }),
      ])
      assert.equal(ready[0], 'ready')
      const exited = once(child, 'exit')
      assert.equal(child.kill('SIGKILL'), true)
      await exited
      const client = await createSynloquent(configuration(filename))
      try {
        assert.equal(
          (await client.models.Item!.get()).length,
          phase === 'before-commit' ? 0 : 1,
        )
        assert.equal(
          (
            await client.storage.read((executor) =>
              client.storage.pending(executor),
            )
          ).length,
          phase === 'before-commit' ? 0 : 1,
        )
        assert.equal(
          (
            await client.storage.read((executor) =>
              executor.execute('PRAGMA integrity_check'),
            )
          ).rows[0]?.integrity_check,
          'ok',
        )
      } finally {
        await client.close()
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      await rm(directory, { recursive: true, force: true })
    }
  })

test('C01 C55 C57 lost create response then authoritative-alias snapshot and immutable replay keep one stable parent and child', async () => {
  const server = testTransport()
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  try {
    const parent = await client.models.Item!.create({ name: 'Parent' })
    const child = await parent.relation('images').create({ url: 'offline.jpg' })
    const parentIdentity = parent.localIdentity
    const childIdentity = child.localIdentity
    server.loseNextResponse()
    await assert.rejects(client.sync.flush(), /response lost/)
    const snapshot = await server.transport.snapshot(
      client.sync.envelope('snapshot', { dataset: 'default' }),
    )
    await client.sync.installSnapshot(snapshot)
    assert.equal((await client.models.Item!.get()).length, 1)
    assert.equal(
      (await client.models.Item!.findOrFail(parentIdentity)).localIdentity,
      parentIdentity,
    )
    client.sync.resumeAuthentication()
    await client.sync.flush()
    assert.equal((await client.models.Item!.get()).length, 1)
    assert.equal((await client.models.Image!.get()).length, 1)
    const canonicalParent = await client.models.Item!.findOrFail(parentIdentity)
    assert.equal(
      (await client.models.Image!.findOrFail(childIdentity)).attributes.item_id,
      canonicalParent.id,
    )
    assert.equal(server.receipts.size, 2)
  } finally {
    await client.close()
  }
})

test('C53 C55 pending soft/hard lifecycle overlays survive canonical resnapshot without resurrecting entities', async () => {
  const server = testTransport()
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  try {
    const parent = await client.models.Item!.create({ name: 'Lifecycle' })
    const child = await parent.relation('images').create({ url: 'image.jpg' })
    await client.sync.flush()
    await parent.refresh()
    await child.refresh()
    await parent.delete()
    await child.delete()
    await client.sync.resnapshot()
    assert.equal((await client.models.Item!.get()).length, 0)
    assert.equal((await client.models.Item!.onlyTrashed().get()).length, 1)
    assert.equal((await client.models.Image!.get()).length, 0)
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).filter((entry) => entry.status === 'pending').length,
      2,
    )
    const deleted = await client.models.Item!.onlyTrashed().firstOrFail()
    await deleted.restore()
    await client.sync.resnapshot()
    assert.equal((await client.models.Item!.get()).length, 1)
    assert.equal((await client.models.Image!.get()).length, 0)
  } finally {
    await client.close()
  }
})

test('C57 cancellation distinguishes unattempted intent from ambiguous attempted server writes', async () => {
  const server = testTransport()
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  try {
    const draft = await client.models.Item!.create({ name: 'Unsent' })
    await client.sync.cancel(draft.lastOperationId!)
    assert.equal(await client.sync.status(draft.lastOperationId!), 'cancelled')
    assert.equal((await client.models.Item!.get()).length, 0)
    const attempted = await client.models.Item!.create({
      name: 'May exist remotely',
    })
    server.loseNextResponse()
    await assert.rejects(client.sync.flush(), /response lost/)
    await assert.rejects(
      client.sync.cancel(attempted.lastOperationId!),
      (error) =>
        error instanceof SynloquentError &&
        error.code === 'operation_attempted',
    )
    assert.equal(
      await client.sync.status(attempted.lastOperationId!),
      'pending',
    )
  } finally {
    await client.close()
  }
})
