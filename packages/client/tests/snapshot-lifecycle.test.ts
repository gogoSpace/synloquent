import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSynloquent, SynloquentError } from '../src/index.js'
import type { ClientConfiguration, DigestLifecycle } from '../src/index.js'
import { configuration, item, snapshotFor } from './fixtures.js'

function pendingDigest() {
  let begin = (): void => {}
  let release = (): void => {}
  let finish = (): void => {}
  let lifecycle: DigestLifecycle | undefined
  let cancelled = 0
  const started = new Promise<void>((resolve) => {
    begin = resolve
  })
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const digestChunks: NonNullable<ClientConfiguration['digestChunks']> = async (
    chunks,
    token,
  ) => {
    lifecycle = token
    const unsubscribe = token?.subscribe(() => {
      cancelled++
    })
    begin()
    try {
      await barrier
      const hashing = createHash('sha256')
      for await (const chunk of chunks) hashing.update(chunk)
      return hashing.digest('hex')
    } finally {
      unsubscribe?.()
      finish()
    }
  }
  return {
    digestChunks,
    started,
    finished,
    release: () => release(),
    cancelled: () => cancelled,
    lifecycle: () => lifecycle,
  }
}
const hasCode = (code: string) => (error: unknown) =>
  error instanceof SynloquentError && error.code === code

test(
  'C51 C55 pending digest close cancels before queue and a late provider cannot publish or hold database shutdown',
  { timeout: 1000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'synloquent-digest-close-'))
    const filename = join(directory, 'catalog.sqlite')
    const provider = pendingDigest()
    let client = await createSynloquent({
      ...configuration(filename),
      digestChunks: provider.digestChunks,
    })
    try {
      await client.storage.write((executor, changed) =>
        client.storage.ingest(
          item('1', { name: 'Existing generation' }),
          executor,
          changed,
        ),
      )
      const installation = client.sync.installSnapshot(
        snapshotFor([item('2', { name: 'Must never activate' })]),
      )
      const rejected = assert.rejects(installation, hasCode('closed_database'))
      await provider.started
      await client.close()
      await rejected
      assert.equal(provider.cancelled(), 1)
      assert.equal(provider.lifecycle()?.cancelled, true)
      provider.release()
      await provider.finished
      client = await createSynloquent(configuration(filename))
      assert.equal(
        (await client.models.Item!.findOrFail('1')).attributes.name,
        'Existing generation',
      )
      assert.equal(await client.models.Item!.find('2'), null)
      assert.equal(await client.storage.metadata('cursor:default'), null)
    } finally {
      provider.release()
      await client.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  'C55 C56 session switch cancels pending digest and rejects its late canonical generation',
  { timeout: 1000 },
  async () => {
    const provider = pendingDigest()
    const client = await createSynloquent({
      ...configuration(),
      digestChunks: provider.digestChunks,
    })
    try {
      const original = { ...client.storage.session }
      await client.storage.write((executor, changed) =>
        client.storage.ingest(
          item('1', { name: 'Original account' }),
          executor,
          changed,
        ),
      )
      const installation = client.sync.installSnapshot(
        snapshotFor([item('2', { name: 'Late account data' })]),
      )
      const rejected = assert.rejects(installation, hasCode('session_changed'))
      await provider.started
      await client.setSession({ ...original, accountId: 'actor-2' })
      await rejected
      assert.equal(provider.cancelled(), 1)
      assert.equal((await client.models.Item!.get()).length, 0)
      provider.release()
      await provider.finished
      await client.setSession(original)
      assert.equal(
        (await client.models.Item!.findOrFail('1')).attributes.name,
        'Original account',
      )
      assert.equal(await client.models.Item!.find('2'), null)
      assert.equal(await client.storage.metadata('cursor:default'), null)
    } finally {
      provider.release()
      await client.close()
    }
  },
)

test(
  'C55 newer verification supersedes a stuck digest and preserves the exact latest snapshot generation',
  { timeout: 1000 },
  async () => {
    const provider = pendingDigest()
    let calls = 0
    const client = await createSynloquent({
      ...configuration(),
      digestChunks: async (source, lifecycle) => {
        calls++
        if (calls === 1) return provider.digestChunks(source, lifecycle)
        const hashing = createHash('sha256')
        for await (const chunk of source) hashing.update(chunk)
        return hashing.digest('hex')
      },
    })
    try {
      const previous = client.sync.installSnapshot(
        snapshotFor([item('1', { name: 'Stuck previous generation' })]),
      )
      const rejected = assert.rejects(previous, hasCode('session_changed'))
      await provider.started
      await client.sync.installSnapshot({
        ...snapshotFor([item('2', { name: 'Latest generation' })]),
        generation: 'snapshot-2',
        cursor: 'cursor-2',
      })
      await rejected
      assert.equal(provider.cancelled(), 1)
      provider.release()
      await provider.finished
      assert.equal(
        (await client.models.Item!.findOrFail('2')).attributes.name,
        'Latest generation',
      )
      assert.equal(await client.models.Item!.find('1'), null)
      assert.equal(await client.storage.metadata('cursor:default'), 'cursor-2')
    } finally {
      provider.release()
      await client.close()
    }
  },
)
