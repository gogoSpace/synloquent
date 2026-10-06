import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  CanonicalRecord,
  ClientConfiguration,
  Snapshot,
} from '../src/index.js'
import { verifySnapshotContent } from '../src/core/snapshot-content.js'
import { configuration, snapshotFor } from './fixtures.js'

const baselinePath = resolve(
  process.argv[2] ??
    'examples/react-native/node_modules/@synloquent/client/dist/core/snapshot-content.js',
)
const baseline = (await import(pathToFileURL(baselinePath).href)) as {
  verifySnapshotContent(
    snapshot: Snapshot,
    configuration: ClientConfiguration,
  ): Promise<void>
}
const records: CanonicalRecord[] = []
for (let identifier = 1; identifier <= 50; identifier++)
  records.push({
    model: 'Category',
    id: String(identifier),
    revision: '1',
    attributes: {
      id: identifier,
      title: `Category ${identifier}`,
      created_at: null,
      updated_at: null,
    },
  })
for (let identifier = 1; identifier <= 64; identifier++)
  records.push({
    model: 'Tag',
    id: String(identifier),
    revision: '1',
    attributes: {
      id: identifier,
      title: `Tag ${identifier}`,
      created_at: null,
      updated_at: null,
    },
  })
for (let identifier = 1; identifier <= 17000; identifier++)
  records.push({
    model: 'Item',
    id: String(identifier),
    revision: '1',
    attributes: {
      id: identifier,
      title: `Synthetic item ${String(identifier).padStart(5, '0')}`,
      category_id: (identifier % 50) + 1,
      active: identifier % 7 !== 0,
      price: `${identifier % 10000}.${String(identifier % 100).padStart(2, '0')}`,
      quantity: identifier % 20,
      metadata: null,
      created_at: null,
      updated_at: null,
    },
  })
for (let identifier = 1; identifier <= 100001; identifier++)
  records.push({
    model: 'Image',
    id: String(identifier),
    revision: '1',
    attributes: {
      id: identifier,
      item_id: (identifier % 17000) + 1,
      url: `image-20261002-${identifier}.jpg`,
      created_at: null,
      updated_at: null,
    },
  })
const snapshot = snapshotFor(records)
const settings: ClientConfiguration = {
  ...configuration(),
  digestChunks: async (source) => {
    const hashing = createHash('sha256')
    for await (const chunk of source) {
      assert.ok(Buffer.byteLength(chunk, 'utf8') <= 4096)
      hashing.update(chunk)
    }
    return hashing.digest('hex')
  },
}
const results: {
  candidate: string
  milliseconds: number
  cpuMicroseconds: number
}[] = []
try {
  for (let repeat = 0; repeat < 3; repeat++)
    for (const [candidate, implementation] of [
      ['packed-baseline', baseline.verifySnapshotContent],
      ['bounded-sync-pieces-ascii', verifySnapshotContent],
    ] as const) {
      const cpuBefore = process.cpuUsage()
      const started = performance.now()
      await implementation(snapshot, settings)
      const cpu = process.cpuUsage(cpuBefore)
      results.push({
        candidate,
        milliseconds: performance.now() - started,
        cpuMicroseconds: cpu.user + cpu.system,
      })
    }
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        recordCount: records.length,
        byteSize: snapshot.byteSize,
        hash: snapshot.hash,
        baselineSource: baselinePath,
        baselineSourceHash: createHash('sha256')
          .update(await readFile(baselinePath))
          .digest('hex'),
        candidateSourceHash: createHash('sha256')
          .update(
            await readFile('packages/client/src/core/snapshot-content.ts'),
          )
          .digest('hex'),
        results,
        limits:
          'Node diagnostic only. Exact same document, hash and bounded chunks. Native timing requires repeating the packed SDK witness.',
      },
      null,
      2,
    ),
  )
} finally {
  await settings.database.close()
}
