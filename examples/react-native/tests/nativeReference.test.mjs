import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setImmediate, clearImmediate } from 'node:timers'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import { TextEncoder } from 'node:util'
import console from 'node:console'
import typescript from 'typescript'

const { process } = globalThis
const publicPackagePath = resolve(
  'examples/react-native/node_modules/@synloquent/client/dist/index.js',
)
const publicExports = await import(pathToFileURL(publicPackagePath).href)
const sourceHashes = {}
const tasks = new Set()
const clients = []
const observations = []

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value))
    return '[' + value.map(canonicalJson).join(',') + ']'
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
      .join(',') +
    '}'
  )
}
const digest = async (content) =>
  createHash('sha256').update(content).digest('hex')
const digestChunks = async (chunks) => {
  const hash = createHash('sha256')
  for await (const chunk of chunks) hash.update(chunk)
  return hash.digest('hex')
}
function schedule(callback) {
  const task = setImmediate(() => {
    tasks.delete(task)
    callback()
  })
  tasks.add(task)
  return () => {
    clearImmediate(task)
    tasks.delete(task)
  }
}
const platform = {
  canonicalJson,
  digest,
  digestChunks,
  encodeUtf8: (content) => new TextEncoder().encode(content),
  nativeClock: { now: () => performance.now() },
  yieldToApplication: () =>
    new Promise((resolveYield) => schedule(resolveYield)),
  setApplicationWorkPhase() {},
}
function loadSource(path, dependencies = {}) {
  const source = readFileSync(path, 'utf8')
  sourceHashes[path] = createHash('sha256').update(source).digest('hex')
  const context = createContext({ exports: {}, DatabaseSync })
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText
  const require = (name) => {
    if (name === '@synloquent/client') return publicExports
    if (name === './platform') return platform
    if (name in dependencies) return dependencies[name]
    throw new Error('Unexpected helper runtime dependency ' + name)
  }
  new Script('(function(require, exports) {' + compiled + '\n})', {
    filename: path,
  }).runInContext(context)(require, context.exports)
  return context.exports
}
const helpers = loadSource('examples/react-native/src/nativeReference.ts')
const { backendSchema } = loadSource(
  'examples/react-native/backend.generated.ts',
)
const { openTestDatabase } = loadSource('packages/client/tests/sqlite.ts', {
  'node:sqlite': { DatabaseSync },
  '../src/core/errors.js': { SynloquentError: publicExports.SynloquentError },
})
const session = {
  accountId: '1',
  tenantId: '1',
  deviceId: 'test-reference',
  deviceEpoch: 'epoch-1',
  generation: 0,
}

async function fixture() {
  const records = []
  const relationSets = []
  for (let category = 1; category <= 50; category += 1)
    records.push({
      model: 'Category',
      id: String(category),
      revision: '1',
      attributes: {
        id: category,
        title: 'Category ' + category,
        created_at: null,
        updated_at: null,
      },
    })
  for (let tag = 1; tag <= 64; tag += 1)
    records.push({
      model: 'Tag',
      id: String(tag),
      revision: '1',
      attributes: {
        id: tag,
        title: 'Tag ' + tag,
        created_at: null,
        updated_at: null,
      },
    })
  for (let item = 1; item <= 100; item += 1) {
    records.push({
      model: 'Item',
      id: String(item),
      revision: '1',
      attributes: {
        id: item,
        title: 'Synthetic item ' + String(item).padStart(5, '0'),
        category_id: (item % 50) + 1,
        active: true,
        price: '1.00',
        quantity: item % 20,
        metadata: null,
        created_at: null,
        updated_at: null,
      },
    })
    relationSets.push({
      model: 'Item',
      parentId: String(item),
      relation: 'tags',
      revision: '1',
      completeness: 'complete',
      targets: [0, 1, 2].map((position) => ({
        id: String(((item + position) % 64) + 1),
        attributes: { position },
      })),
    })
    for (let offset = 0; offset < 6; offset += 1) {
      const image = item - 1 + 17000 * offset
      if (image === 0) continue
      records.push({
        model: 'Image',
        id: String(image),
        revision: '1',
        attributes: {
          id: image,
          item_id: item,
          url: 'image-' + image + '.jpg',
          created_at: null,
          updated_at: null,
        },
      })
    }
  }
  return {
    records,
    relationSets,
    ...(await helpers.snapshotContent({ records, relationSets })),
    schemaFingerprint: backendSchema.fingerprint,
    dataset: 'catalog',
    generation: 'public-witness-fixture',
    cursor: 'fixture-cursor',
    scope: {
      dataset: 'catalog',
      schemaFingerprint: backendSchema.fingerprint,
      authorizationGeneration: 'fixture-auth',
      projectionGeneration: 'fixture-projection',
      completeness: 'complete',
    },
  }
}
async function clientFixture(snapshot, reference = false) {
  let identity = 0
  const client = await publicExports.createSynloquent({
    schema: backendSchema,
    database: openTestDatabase(),
    session,
    generateIdentity: () =>
      '00000000-0000-4000-8000-' + String(++identity).padStart(12, '0'),
    now: () => '2026-10-02T00:00:00.000Z',
    digest,
    digestChunks,
    schedule,
  })
  clients.push(client)
  const expected = await helpers.preparePendingCatalog(client, snapshot)
  if (reference) await helpers.installReferenceSnapshot(client, snapshot)
  else await client.sync.installSnapshot(snapshot)
  return { client, expected }
}
async function durableRows(client) {
  return client.storage.read(async (executor) => ({
    outbox: (
      await executor.execute(
        'SELECT * FROM syn_outbox WHERE partition=? ORDER BY sequence',
        [client.storage.partition],
      )
    ).rows,
    metadata: (
      await executor.execute(
        'SELECT * FROM syn_metadata WHERE partition=? ORDER BY key',
        [client.storage.partition],
      )
    ).rows,
    deleted: (
      await executor.execute(
        'SELECT _canonical,_proposal,_visible,_deleted,_state FROM syn_model_Item WHERE _partition=? AND _server_identity=?',
        [client.storage.partition, '3'],
      )
    ).rows,
    children: (
      await executor.execute(
        'SELECT _server_identity,_deleted FROM syn_model_Image WHERE _partition=? AND item_id=? ORDER BY _server_identity',
        [client.storage.partition, '3'],
      )
    ).rows,
  }))
}

try {
  const snapshot = await fixture()
  const clientTarget = await clientFixture(snapshot)
  const before = canonicalJson(await durableRows(clientTarget.client))
  const clientWitness = await helpers.verifyPendingCatalog(
    clientTarget.client,
    clientTarget.expected,
  )
  assert.equal(canonicalJson(await durableRows(clientTarget.client)), before)
  assert.equal(clientWitness.actualCatalog.relationSets, 100)
  assert.equal(clientWitness.actualCatalog.pivotRows, 300)
  assert.equal(clientWitness.actualCatalog.canonicalPivotRows, 300)
  const publicWitness = clientWitness.pendingDeletePublicWitness
  assert.deepEqual(Array.from(publicWitness.hiddenPublicState.tagIds), [])
  assert.equal(publicWitness.hiddenPublicState.inverseCount, 0)
  assert.equal(publicWitness.hiddenPublicState.inverseWithCount, 0)
  assert.equal(publicWitness.hiddenPublicState.inverseWithSum, 0)
  assert.equal(publicWitness.restoredPublicState.imageCount, 6)
  assert.deepEqual(Array.from(publicWitness.restoredPublicState.tagIds), [
    '4',
    '5',
    '6',
  ])
  assert.equal(publicWitness.restoredPublicState.inverseCount, 1)
  assert.equal(publicWitness.restoredPublicState.inverseWithCount, 1)
  assert.equal(publicWitness.restoredPublicState.deletionStatus, 'cancelled')
  assert.equal(publicWitness.rollbackSentinelObserved, true)
  assert.equal(publicWitness.beforeCatalogHash, publicWitness.afterCatalogHash)
  assert.equal(
    canonicalJson(publicWitness.beforeCancellation),
    canonicalJson(publicWitness.afterCancellation),
  )
  observations.push(
    'actual-public-clientTarget-hidden-cancel-restored-sentinel-rollback',
  )

  const reference = await clientFixture(snapshot, true)
  const referenceWitness = await helpers.verifyPendingCatalog(
    reference.client,
    reference.expected,
  )
  assert.equal(
    canonicalJson(referenceWitness.actualCatalog),
    canonicalJson(clientWitness.actualCatalog),
  )
  assert.equal(
    canonicalJson(referenceWitness.pendingDeletePublicWitness),
    canonicalJson(clientWitness.pendingDeletePublicWitness),
  )
  observations.push('actual-public-reference-identical-data-and-public-witness')
  for (let repetition = 0; repetition < 2; repetition += 1) {
    await clientTarget.client.sync.installSnapshot({
      ...snapshot,
      generation: 'repeat-' + repetition,
    })
    const witness = await helpers.verifyPendingCatalog(
      clientTarget.client,
      clientTarget.expected,
    )
    assert.equal(
      canonicalJson(witness.actualCatalog),
      canonicalJson(clientWitness.actualCatalog),
    )
    assert.equal(
      canonicalJson(witness.pendingDeletePublicWitness.hiddenPublicState),
      canonicalJson(publicWitness.hiddenPublicState),
    )
    assert.equal(
      canonicalJson(witness.pendingDeletePublicWitness.restoredPublicState),
      canonicalJson(publicWitness.restoredPublicState),
    )
    assert.equal(
      canonicalJson(witness.pendingDeletePublicWitness.beforeCancellation),
      canonicalJson(witness.pendingDeletePublicWitness.afterCancellation),
    )
  }
  observations.push('two-actual-public-repeat-witnesses-retain-original-state')

  const originalGet = publicExports.Relation.prototype.get
  const leakedTag = await clientTarget.client.models.Tag.findOrFail('4')
  publicExports.Relation.prototype.get = async function () {
    const real = await originalGet.call(this)
    return this.parent.modelName === 'Item' &&
      String(this.parent.id) === '3' &&
      this.name === 'tags'
      ? new publicExports.Collection([leakedTag])
      : real
  }
  try {
    const baselineArgument = process.argv.find((value) =>
      value.startsWith('--baseline-source='),
    )
    if (baselineArgument) {
      const original = loadSource(
        baselineArgument.slice('--baseline-source='.length),
      )
      const baselineResult = await original.verifyPendingCatalog(
        clientTarget.client,
        clientTarget.expected,
      )
      assert.equal(baselineResult.pendingPreservation.pendingDeleteHidden, true)
      observations.push(
        'original-helper-falsely-passes-public-deleted-relation-leak',
      )
    }
    await assert.rejects(
      helpers.verifyPendingCatalog(clientTarget.client, clientTarget.expected),
      /leaked Item3 through public relations or aggregates/,
    )
  } finally {
    publicExports.Relation.prototype.get = originalGet
  }
  observations.push('reject-real-public-relation-result-leak')

  const originalFirst = publicExports.Query.prototype.firstOrFail
  publicExports.Query.prototype.firstOrFail = async function () {
    const model = await originalFirst.call(this)
    if (
      this.options.model === 'Tag' &&
      this.options.relationAggregates?.some(
        (aggregate) => aggregate.relation === 'items',
      )
    )
      model.setAggregate('items_count', 1)
    return model
  }
  try {
    await assert.rejects(
      helpers.verifyPendingCatalog(clientTarget.client, clientTarget.expected),
      /leaked Item3 through public relations or aggregates/,
    )
  } finally {
    publicExports.Query.prototype.firstOrFail = originalFirst
  }
  observations.push('reject-real-public-withcount-result-leak')

  publicExports.Relation.prototype.get = async function () {
    const real = await originalGet.call(this)
    return this.parent.modelName === 'Tag' &&
      String(this.parent.id) === '4' &&
      this.name === 'items' &&
      real.items.length === 1
      ? new publicExports.Collection()
      : real
  }
  const beforeRestorationFailure = canonicalJson(
    await durableRows(clientTarget.client),
  )
  try {
    await assert.rejects(
      helpers.verifyPendingCatalog(clientTarget.client, clientTarget.expected),
      /did not restore public Item3 relations/,
    )
  } finally {
    publicExports.Relation.prototype.get = originalGet
  }
  assert.equal(
    canonicalJson(await durableRows(clientTarget.client)),
    beforeRestorationFailure,
  )
  observations.push('reject-real-public-restoration-failure-and-rollback')

  for (const kind of ['metadata', 'outbox', 'catalog']) {
    const target = await clientFixture(snapshot)
    const transaction = target.client.transaction.bind(target.client)
    target.client.transaction = async (callback) => {
      try {
        return await transaction(callback)
      } catch (failure) {
        await target.client.storage.write(async (executor) => {
          if (kind === 'metadata')
            await target.client.storage.setMetadata(
              'unexpected-after-rollback',
              'mutation',
              executor,
            )
          else if (kind === 'outbox')
            await executor.execute(
              'UPDATE syn_outbox SET attempts=attempts+1 WHERE partition=? AND operation_id=?',
              [
                target.client.storage.partition,
                target.expected.deletionOperationId,
              ],
            )
          else
            await executor.execute(
              "UPDATE syn_model_Item SET _canonical=json_set(_canonical,'$.title','Unexpected catalog mutation') WHERE _partition=? AND _server_identity='4'",
              [target.client.storage.partition],
            )
        })
        throw failure
      }
    }
    await assert.rejects(
      helpers.verifyPendingCatalog(target.client, target.expected),
      /Cancellation rollback changed/,
    )
    observations.push('reject-after-rollback-' + kind + '-mutation')
  }

  const statusTarget = await clientFixture(snapshot)
  await statusTarget.client.storage.write((executor) =>
    executor.execute(
      "UPDATE syn_outbox SET status='sending' WHERE partition=? AND operation_id=?",
      [
        statusTarget.client.storage.partition,
        statusTarget.expected.deletionOperationId,
      ],
    ),
  )
  await assert.rejects(
    helpers.verifyPendingCatalog(statusTarget.client, statusTarget.expected),
    /Import changed pending operation status or content/,
  )
  observations.push('reject-import-outbox-status-change')
  console.log(
    JSON.stringify({
      observations,
      sourceHashes,
      installedPublicPackagePath: publicPackagePath,
      schemaFingerprint: backendSchema.fingerprint,
      fixtureRecords: snapshot.records.length,
      actualCatalog: clientWitness.actualCatalog,
      publicWitness,
      nativePerformanceClaim: false,
    }),
  )
} finally {
  await Promise.all(clients.map((client) => client.close()))
  await new Promise((resolveCleanup) => setImmediate(resolveCleanup))
  for (const task of tasks) clearImmediate(task)
}
