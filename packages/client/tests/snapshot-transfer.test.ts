import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSynloquent, SynloquentError } from '../src/index.js'
import { createMemoryBudgetPolicy } from '../src/core/memory-budget.js'
import { canonicalJson } from '../src/core/values.js'
import { utf8Length } from '../src/core/snapshot-content.js'
import type {
  CanonicalRecord,
  ClientConfiguration,
  RelationSet,
  SnapshotPartsDescriptor,
  SnapshotPartIdentity,
  SnapshotTransferPart,
  SnapshotPartsConfirmation,
} from '../src/core/types.js'
import { configuration, item, manifest, snapshotFor } from './fixtures.js'
import { testTransport } from './transport-fixture.js'

function planFor(
  records: readonly CanonicalRecord[],
  relationSets: readonly RelationSet[] = [],
  rowsPerPart = 2,
) {
  const snapshot = {
    ...snapshotFor(records, undefined, relationSets),
    generation: 'bounded-2',
    cursor: 'bounded-cursor-2',
  }
  const parts: SnapshotTransferPart[] = []
  for (const section of ['records', 'relationSets'] as const) {
    const rows = section === 'records' ? records : relationSets
    for (
      let firstIndex = 0;
      firstIndex < rows.length;
      firstIndex += rowsPerPart
    ) {
      const chunk = rows.slice(firstIndex, firstIndex + rowsPerPart)
      const document = {
        format: 'canonical-parts-v1' as const,
        ordinal: parts.length,
        section,
        firstIndex,
        rowCount: chunk.length,
        rows: chunk,
      }
      const rawDocument = canonicalJson(document)
      parts.push({
        ...document,
        rows:
          section === 'records'
            ? (chunk as CanonicalRecord[])
            : (chunk as RelationSet[]),
        rawDocument,
        rawRows: canonicalJson(chunk),
        hash: createHash('sha256').update(rawDocument).digest('hex'),
        byteSize: utf8Length(rawDocument),
      })
    }
  }
  function identity(ordinal: number): SnapshotPartIdentity {
    const part = parts[ordinal]!
    return {
      ordinal,
      downloadUrl: `https://fixture.invalid/parts/${ordinal}`,
      continuation: `continuation-${ordinal}`,
      hash: part.hash,
      byteSize: part.byteSize,
    }
  }
  const metadata = {
    schemaFingerprint: snapshot.schemaFingerprint,
    dataset: snapshot.dataset,
    generation: snapshot.generation,
    cursor: snapshot.cursor,
    hash: snapshot.hash,
    byteSize: snapshot.byteSize,
    scope: snapshot.scope,
  }
  const descriptor: SnapshotPartsDescriptor = {
    ...metadata,
    format: 'canonical-parts-v1',
    status: 'ready',
    partCount: parts.length,
    recordCount: records.length,
    relationSetCount: relationSets.length,
    maximumPartBytes: 65536,
    maximumRowBytes: 65536,
    partRowLimit: 256,
    ...(parts.length
      ? { firstPart: identity(0) }
      : { confirmationToken: 'confirmed-empty' }),
  }
  return {
    parts,
    descriptor,
    identity,
    confirmation: { ...metadata, confirmed: true } as SnapshotPartsConfirmation,
  }
}

function transferFixture(
  plan = planFor([item('1', {}), item('2', {}), item('3', {})]),
  bundleParts = 16,
) {
  let prepares = 0
  let confirmations = 0
  let closedIterators = 0
  const requestedOrdinals: number[] = []
  let beforePart: ((ordinal: number) => void | Promise<void>) | undefined
  let confirm: (() => void | Promise<void>) | undefined
  const transport = {
    ...testTransport().transport,
    snapshot: async () => {
      throw new Error('Legacy fallback is forbidden in this control')
    },
    snapshotParts: async () => {
      prepares++
      return plan.descriptor
    },
    snapshotPartBatch: async (
      request: Parameters<
        NonNullable<
          import('../src/core/types.js').Transport['snapshotPartBatch']
        >
      >[0],
    ) => {
      assert.equal(request.kind, 'snapshot')
      const start = request.payload.part.ordinal
      requestedOrdinals.push(start)
      const end = Math.min(plan.parts.length, start + bundleParts)
      return {
        parts: (async function* () {
          try {
            for (let index = start; index < end; index++) {
              await beforePart?.(index)
              yield plan.parts[index]!
            }
          } finally {
            closedIterators++
          }
        })(),
        ...(end < plan.parts.length
          ? { nextPart: plan.identity(end) }
          : { confirmationToken: 'final-confirmation' }),
      }
    },
    confirmSnapshotParts: async () => {
      confirmations++
      await confirm?.()
      return plan.confirmation
    },
  }
  return {
    plan,
    transport,
    requestedOrdinals,
    get prepares() {
      return prepares
    },
    get confirmations() {
      return confirmations
    },
    get closedIterators() {
      return closedIterators
    },
    onBeforePart(callback?: typeof beforePart) {
      beforePart = callback
    },
    onConfirm(callback?: typeof confirm) {
      confirm = callback
    },
    configuration(
      filename = ':memory:',
      overrides: Partial<ClientConfiguration> = {},
    ): ClientConfiguration {
      return {
        ...configuration(filename, transport),
        digestChunks: async (chunks) => {
          const hashing = createHash('sha256')
          for await (const chunk of chunks) hashing.update(chunk)
          return hashing.digest('hex')
        },
        ...overrides,
      }
    },
  }
}
function hasCode(code: string) {
  return (failure: unknown) =>
    failure instanceof SynloquentError && failure.code === code
}
async function stageCount(
  client: Awaited<ReturnType<typeof createSynloquent>>,
) {
  return client.storage.read(async (executor) =>
    (
      await executor.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'syn_snapshot_rows'",
      )
    ).rows.length
      ? Number(
          (
            await executor.execute(
              'SELECT COUNT(*) AS count FROM syn_snapshot_rows',
            )
          ).rows[0]?.count,
        )
      : 0,
  )
}

test('bounded complete catalog activates once with relations cursor scope and original digest', async () => {
  const plan = planFor(
    [
      item('1', { name: 'ž😀' }),
      item('2', {}),
      {
        model: 'Tag',
        id: '3',
        revision: '1',
        attributes: { id: 3, label: 'Tag' },
      },
    ],
    [
      {
        model: 'Item',
        relation: 'tags',
        parentId: '1',
        revision: '1',
        completeness: 'complete',
        targets: [{ id: '3', attributes: { position: 2, featured: false } }],
      },
    ],
    1,
  )
  const fixture = transferFixture(plan, 2)
  const client = await createSynloquent(fixture.configuration())
  try {
    await client.sync.resnapshot()
    assert.equal(client.storage.owner.generation, 1)
    assert.equal(await client.models.Item!.count(), 2)
    const parent = await client.models.Item!.findOrFail(1)
    assert.equal(parent.attributes.name, 'ž😀')
    assert.equal((await parent.relation('tags').get()).length, 1)
    assert.equal(
      await client.storage.metadata('cursor:default'),
      'bounded-cursor-2',
    )
    assert.equal(fixture.prepares, 1)
    assert.equal(fixture.confirmations, 1)
    assert.deepEqual(fixture.requestedOrdinals, [0, 2])
    assert.equal(await stageCount(client), 0)
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

test('private staged rows never change active data or publish before final activation', async () => {
  const fixture = transferFixture()
  const client = await createSynloquent(fixture.configuration())
  await client.sync.installSnapshot(
    snapshotFor([item('9', { name: 'Active' })]),
  )
  let publications = 0
  const unsubscribe = client.storage.owner.subscribe(() => publications++)
  fixture.onBeforePart(async () => {
    assert.equal(
      (await client.models.Item!.findOrFail(9)).attributes.name,
      'Active',
    )
    assert.equal(publications, 0)
  })
  try {
    await client.sync.resnapshot()
    assert.equal(publications, 1)
    assert.equal(await client.models.Item!.count(), 3)
  } finally {
    unsubscribe()
    await client.close()
  }
})

test('interrupted bundle commits complete parts and resumes one original bundle idempotently', async () => {
  const fixture = transferFixture(
    planFor([item('1', {}), item('2', {}), item('3', {})], [], 1),
  )
  const client = await createSynloquent(fixture.configuration())
  fixture.onBeforePart((ordinal) => {
    if (ordinal === 1) throw new Error('Network interrupted')
  })
  try {
    await assert.rejects(client.sync.resnapshot(), /Network interrupted/)
    assert.equal(await stageCount(client), 1)
    assert.equal(await client.models.Item!.allowPartial().count(), 0)
    assert.equal(client.storage.owner.generation, 0)
    fixture.onBeforePart()
    await client.sync.resnapshot()
    assert.equal(fixture.prepares, 1)
    assert.deepEqual(fixture.requestedOrdinals, [0, 0])
    assert.equal(await client.models.Item!.count(), 3)
    assert.equal(fixture.closedIterators, 2)
  } finally {
    await client.close()
  }
})

test('actual SQLite restart rechecks durable parts and resumes without preparing a new generation', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'synloquent-snapshot-transfer-'),
  )
  const filename = join(directory, 'resume.sqlite')
  const fixture = transferFixture(
    planFor([item('1', {}), item('2', {})], [], 1),
  )
  let client = await createSynloquent(fixture.configuration(filename))
  try {
    fixture.onBeforePart((ordinal) => {
      if (ordinal === 1) throw new Error('Disconnected')
    })
    await assert.rejects(client.sync.resnapshot(), /Disconnected/)
    await client.close()
    client = await createSynloquent(fixture.configuration(filename))
    fixture.onBeforePart()
    await client.sync.resnapshot()
    assert.equal(fixture.prepares, 1)
    assert.equal(await client.models.Item!.count(), 2)
  } finally {
    await client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('typed rows cannot contradict original wire bytes despite a valid wire hash', async () => {
  const fixture = transferFixture()
  fixture.plan.parts[0] = {
    ...fixture.plan.parts[0]!,
    rows: [item('1', { name: 'Forged' }), item('2', {})],
  }
  const client = await createSynloquent(fixture.configuration())
  try {
    await assert.rejects(client.sync.resnapshot(), hasCode('snapshot_invalid'))
    assert.equal(await client.models.Item!.allowPartial().count(), 0)
    assert.equal(fixture.confirmations, 0)
  } finally {
    await client.close()
  }
})

test('sole durable payload and original framing tampering are both rejected before publication', async () => {
  for (const statement of [
    "UPDATE syn_snapshot_rows SET payload = replace(payload,'Default','Changed') WHERE part_ordinal = 0",
    `UPDATE syn_snapshot_parts SET raw_prefix = replace(raw_prefix,'"firstIndex":0','"firstIndex":1') WHERE ordinal = 0`,
  ]) {
    const fixture = transferFixture(
      planFor([item('1', {}), item('2', {})], [], 1),
    )
    const client = await createSynloquent(fixture.configuration())
    fixture.onBeforePart((ordinal) => {
      if (ordinal === 1) throw new Error('Interrupted')
    })
    try {
      await assert.rejects(client.sync.resnapshot(), /Interrupted/)
      await client.storage.write((executor) => executor.execute(statement))
      fixture.onBeforePart()
      await assert.rejects(
        client.sync.resnapshot(),
        hasCode('snapshot_invalid'),
      )
      assert.equal(client.storage.owner.generation, 0)
      assert.equal(await client.models.Item!.allowPartial().count(), 0)
      assert.equal(await stageCount(client), 0)
    } finally {
      await client.close()
    }
  }
})

test('global catalog hash mismatch cannot confirm or activate valid individual parts', async () => {
  const fixture = transferFixture()
  fixture.plan.descriptor = { ...fixture.plan.descriptor, hash: '0'.repeat(64) }
  const client = await createSynloquent(fixture.configuration())
  try {
    await assert.rejects(client.sync.resnapshot(), hasCode('snapshot_invalid'))
    assert.equal(fixture.confirmations, 0)
    assert.equal(await client.models.Item!.allowPartial().count(), 0)
  } finally {
    await client.close()
  }
})

test('duplicate identities across parts fail private SQL membership without active replacement', async () => {
  const fixture = transferFixture(
    planFor([item('1', {}), item('1', {})], [], 1),
  )
  const client = await createSynloquent(fixture.configuration())
  try {
    await assert.rejects(client.sync.resnapshot(), /UNIQUE/)
    assert.equal(client.storage.owner.generation, 0)
    assert.equal(await client.models.Item!.allowPartial().count(), 0)
  } finally {
    await client.close()
  }
})

test('oversized single rows defer explicitly while legacy whole snapshot remains compatible', async () => {
  const large = item('1', { name: 'x'.repeat(20000) })
  const fixture = transferFixture(planFor([large]))
  const client = await createSynloquent(fixture.configuration())
  try {
    await assert.rejects(
      client.sync.resnapshot(),
      hasCode('snapshot_admission_required'),
    )
    assert.equal(await client.models.Item!.allowPartial().count(), 0)
    await client.sync.installSnapshot(snapshotFor([large]))
    assert.equal(await client.models.Item!.count(), 1)
  } finally {
    await client.close()
  }
})

test('server admission failure has no legacy fallback or active side effects', async () => {
  const fixture = transferFixture()
  fixture.plan.descriptor = {
    ...fixture.plan.descriptor,
    status: 'admission-required',
    reason: 'row-exceeds-part-budget',
  }
  const client = await createSynloquent(fixture.configuration())
  try {
    await assert.rejects(
      client.sync.resnapshot(),
      hasCode('snapshot_admission_required'),
    )
    assert.equal(fixture.requestedOrdinals.length, 0)
    assert.equal(client.storage.owner.generation, 0)
  } finally {
    await client.close()
  }
})

test('missing streaming digest fails before acquisition and incomplete consumers cannot activate', async () => {
  for (const incomplete of [false, true]) {
    const fixture = transferFixture()
    const configured = fixture.configuration()
    const { digestChunks: originalStreamingDigest, ...withoutStreaming } =
      configured
    assert.equal(typeof originalStreamingDigest, 'function')
    const client = await createSynloquent(
      incomplete
        ? {
            ...configured,
            digestChunks: async () => fixture.plan.descriptor.hash,
          }
        : withoutStreaming,
    )
    try {
      await assert.rejects(
        client.sync.resnapshot(),
        hasCode(
          incomplete ? 'snapshot_invalid' : 'snapshot_admission_required',
        ),
      )
      if (!incomplete) assert.equal(fixture.requestedOrdinals.length, 0)
      assert.equal(client.storage.owner.generation, 0)
    } finally {
      await client.close()
    }
  }
})

test('revocation at final confirmation retains original active data and pending intent', async () => {
  const fixture = transferFixture()
  const client = await createSynloquent(fixture.configuration())
  await client.sync.installSnapshot(snapshotFor([item('1', { name: 'Old' })]))
  const record = await client.models.Item!.findOrFail(1)
  await record.update({ name: 'Pending' })
  const generation = client.storage.owner.generation
  fixture.onConfirm(() => {
    throw new SynloquentError('forbidden_operation', 'Grant revoked')
  })
  try {
    await assert.rejects(
      client.sync.resnapshot(),
      hasCode('forbidden_operation'),
    )
    assert.equal(client.storage.owner.generation, generation)
    assert.equal(
      (await client.models.Item!.findOrFail(1)).attributes.name,
      'Pending',
    )
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      1,
    )
    assert.equal(await stageCount(client), 0)
  } finally {
    await client.close()
  }
})

test('confirmation metadata mismatch cannot replace the active generation', async () => {
  const fixture = transferFixture()
  fixture.plan.confirmation = {
    ...fixture.plan.confirmation,
    cursor: 'different',
  }
  const client = await createSynloquent(fixture.configuration())
  try {
    await assert.rejects(client.sync.resnapshot(), hasCode('snapshot_invalid'))
    assert.equal(client.storage.owner.generation, 0)
  } finally {
    await client.close()
  }
})

test('pressure stops subsequent part work and closes the iterator while preserving resume', async () => {
  let time = 0
  const policy = createMemoryBudgetPolicy({ nowMilliseconds: () => time })
  const fixture = transferFixture(
    planFor([item('1', {}), item('2', {})], [], 1),
  )
  const client = await createSynloquent(
    fixture.configuration(':memory:', { memoryBudget: policy }),
  )
  fixture.onBeforePart((ordinal) => {
    if (ordinal === 1)
      policy.observe({
        observedAtMilliseconds: time,
        validity: 'unavailable',
        pressure: 'critical',
      })
  })
  try {
    await assert.rejects(
      client.sync.resnapshot(),
      hasCode('snapshot_admission_required'),
    )
    assert.equal(await stageCount(client), 1)
    assert.equal(fixture.closedIterators, 1)
    assert.equal(fixture.requestedOrdinals.length, 1)
    fixture.onBeforePart()
    for (time = 0; time <= 30000; time += 5000)
      policy.observe({
        observedAtMilliseconds: time,
        validity: 'valid',
        pressure: 'normal',
        systemAvailableBytes: 128 * 1024 ** 2,
      })
    time = 30000
    await client.sync.resnapshot()
    assert.equal(await client.models.Item!.count(), 2)
    assert.equal(fixture.prepares, 1)
  } finally {
    await client.close()
    policy.close()
  }
})

test('pressure before activation preserves completed staging and later activation needs no repeated fetch', async () => {
  let time = 0
  const policy = createMemoryBudgetPolicy({ nowMilliseconds: () => time })
  const fixture = transferFixture()
  const client = await createSynloquent(
    fixture.configuration(':memory:', { memoryBudget: policy }),
  )
  fixture.onConfirm(() => {
    policy.observe({
      observedAtMilliseconds: 0,
      validity: 'unavailable',
      pressure: 'warning',
    })
  })
  try {
    await assert.rejects(
      client.sync.resnapshot(),
      hasCode('snapshot_admission_required'),
    )
    assert.equal(await stageCount(client), 3)
    assert.equal(client.storage.owner.generation, 0)
    fixture.onConfirm()
    for (time = 0; time <= 30000; time += 5000)
      policy.observe({
        observedAtMilliseconds: time,
        validity: 'valid',
        pressure: 'normal',
        systemAvailableBytes: 128 * 1024 ** 2,
      })
    time = 30000
    await client.sync.resnapshot()
    assert.equal(fixture.requestedOrdinals.length, 1)
    assert.equal(await client.models.Item!.count(), 3)
  } finally {
    await client.close()
    policy.close()
  }
})

test('bounded pending replay keeps all ordered increments without a complete outbox read', async () => {
  const fixture = transferFixture()
  const client = await createSynloquent(fixture.configuration())
  await client.sync.installSnapshot(snapshotFor([item('1', {})]))
  const record = await client.models.Item!.findOrFail(1)
  for (let count = 0; count < 80; count++) await record.increment('count', 1)
  const pending = client.storage.pending
  client.storage.pending = async () => {
    throw new Error('Full outbox read is forbidden during bounded activation')
  }
  try {
    await client.sync.resnapshot()
    assert.equal((await client.models.Item!.findOrFail(1)).attributes.count, 80)
  } finally {
    client.storage.pending = pending
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      80,
    )
    await client.close()
  }
})

test('oversized pending operation defers without losing the active proposal or outbox', async () => {
  const fixture = transferFixture()
  const client = await createSynloquent(fixture.configuration())
  await client.sync.installSnapshot(snapshotFor([item('1', {})]))
  await (
    await client.models.Item!.findOrFail(1)
  ).update({ name: 'p'.repeat(20000) })
  const generation = client.storage.owner.generation
  try {
    await assert.rejects(
      client.sync.resnapshot(),
      hasCode('snapshot_admission_required'),
    )
    assert.equal(client.storage.owner.generation, generation)
    assert.equal(
      String((await client.models.Item!.findOrFail(1)).attributes.name).length,
      20000,
    )
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

test('empty bounded snapshot still checks original framing and atomically removes old membership', async () => {
  const fixture = transferFixture(planFor([]))
  const client = await createSynloquent(fixture.configuration())
  await client.sync.installSnapshot(snapshotFor([item('1', {})]))
  try {
    await client.sync.resnapshot()
    assert.equal(await client.models.Item!.allowPartial().count(), 0)
    assert.equal(fixture.requestedOrdinals.length, 0)
    assert.equal(fixture.confirmations, 1)
  } finally {
    await client.close()
  }
})

test('driver parameter capacity bounds private SQL batching as well as final record writes', async () => {
  const fixture = transferFixture(
    planFor(
      Array.from({ length: 40 }, (_, index) => item(String(index + 1), {})),
      [],
      20,
    ),
  )
  const configured = fixture.configuration()
  const base = configured.database
  let maximumParameters = 0
  const wrap = (
    executor: import('../src/core/database.js').TransactionExecutor,
  ): import('../src/core/database.js').TransactionExecutor => ({
    transaction: (callback) =>
      executor.transaction((transaction) => callback(wrap(transaction))),
    execute: (statement, parameters = []) => {
      maximumParameters = Math.max(maximumParameters, parameters.length)
      assert.ok(
        parameters.length <= 32,
        `Statement exceeded32: ${statement.slice(0, 80)}`,
      )
      return executor.execute(statement, parameters)
    },
  })
  const client = await createSynloquent({
    ...configured,
    database: {
      ...base,
      ...wrap(base),
      capabilities: { ...base.capabilities, maximumParameters: 32 },
    },
  })
  try {
    await client.sync.resnapshot()
    assert.equal(await client.models.Item!.count(), 40)
    assert.ok(maximumParameters <= 32)
  } finally {
    await client.close()
  }
})

test('late iterator completion after session replacement cannot stage or activate old data', async () => {
  const fixture = transferFixture()
  let release: () => void = () => {}
  let started: () => void = () => {}
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const readiness = new Promise<void>((resolve) => {
    started = resolve
  })
  fixture.onBeforePart(async () => {
    started()
    await waiting
  })
  const client = await createSynloquent(fixture.configuration())
  const result = client.sync.resnapshot().then(
    () => undefined,
    (failure) => failure as unknown,
  )
  try {
    await readiness
    await client.sync.setSession({
      ...client.storage.session,
      accountId: 'replacement-account',
    })
    assert.ok(hasCode('session_changed')(await result))
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(await client.models.Item!.allowPartial().count(), 0)
    assert.equal(fixture.confirmations, 0)
    assert.equal(fixture.closedIterators, 1)
  } finally {
    release()
    await client.close()
  }
})

test('failure inside final transaction rolls back all data cursor and generation and preserves resumable staging', async () => {
  const fixture = transferFixture()
  const client = await createSynloquent(fixture.configuration())
  await client.sync.installSnapshot(
    snapshotFor([item('9', { name: 'Original' })]),
  )
  const generation = client.storage.owner.generation
  const cursor = await client.storage.metadata('cursor:default')
  await client.storage.write((executor) =>
    executor.execute(
      "CREATE TRIGGER transfer_failure BEFORE INSERT ON syn_model_Item WHEN NEW._server_identity = '2' BEGIN SELECT RAISE(ABORT,'Injected activation failure'); END",
    ),
  )
  try {
    await assert.rejects(
      client.sync.resnapshot(),
      /Injected activation failure/,
    )
    assert.equal(client.storage.owner.generation, generation)
    assert.equal(await client.storage.metadata('cursor:default'), cursor)
    assert.deepEqual((await client.models.Item!.pluck('name')).all(), [
      'Original',
    ])
    assert.equal(await stageCount(client), 3)
    await client.storage.write((executor) =>
      executor.execute('DROP TRIGGER transfer_failure'),
    )
    await client.sync.resnapshot()
    assert.equal(fixture.requestedOrdinals.length, 1)
    assert.equal(await client.models.Item!.count(), 3)
  } finally {
    await client.close()
  }
})

test('an unrelated catalog cannot prevent a bounded pending hard delete with no dependents', async () => {
  const records = [
    item('1', {}),
    ...Array.from({ length: 24 }, (_, index) => ({
      model: 'Image',
      id: String(index + 1),
      revision: '1',
      attributes: { id: String(index + 1), item_id: '1', url: `${index}.jpg` },
    })),
  ]
  const fixture = transferFixture(planFor(records))
  const client = await createSynloquent(fixture.configuration())
  await client.sync.installSnapshot(snapshotFor(records))
  await (await client.models.Image!.findOrFail(1)).delete()
  const generation = client.storage.owner.generation
  try {
    await client.sync.resnapshot()
    assert.equal(client.storage.owner.generation, generation + 1)
    assert.equal(await client.models.Image!.count(), 23)
    assert.equal(
      (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).length,
      1,
    )
    assert.equal(await stageCount(client), 0)
  } finally {
    await client.close()
  }
})

test('fixed conservative and adaptive policies consume different batch budgets on the identical bounded catalog', async () => {
  const plan = planFor(
    Array.from({ length: 40 }, (_, index) => item(String(index + 1), {})),
    [],
    40,
  )
  let time = 0
  const adaptive = createMemoryBudgetPolicy({ nowMilliseconds: () => time })
  for (time = 0; time <= 30000; time += 5000)
    adaptive.observe({
      observedAtMilliseconds: time,
      validity: 'valid',
      pressure: 'normal',
      processHeadroomBytes: 128 * 1024 ** 2,
    })
  time = 30000
  const results: {
    maximumRows: number
    cursor: string | null
    count: number
  }[] = []
  try {
    for (const policy of [undefined, adaptive]) {
      const fixture = transferFixture(plan)
      const configured = fixture.configuration(
        ':memory:',
        policy ? { memoryBudget: policy } : {},
      )
      const base = configured.database
      let maximumRows = 0
      const wrap = (
        executor: import('../src/core/database.js').TransactionExecutor,
      ): import('../src/core/database.js').TransactionExecutor => ({
        transaction: (callback) =>
          executor.transaction((transaction) => callback(wrap(transaction))),
        execute: (statement, parameters = []) => {
          if (statement.startsWith('INSERT INTO "syn_model_Item"'))
            maximumRows = Math.max(maximumRows, parameters.length / 10)
          return executor.execute(statement, parameters)
        },
      })
      const client = await createSynloquent({
        ...configured,
        database: { ...base, ...wrap(base) },
      })
      try {
        await client.sync.resnapshot()
        results.push({
          maximumRows,
          cursor: await client.storage.metadata('cursor:default'),
          count: await client.models.Item!.count(),
        })
      } finally {
        await client.close()
      }
    }
    assert.ok(results[0]!.maximumRows <= 16)
    assert.ok(results[1]!.maximumRows > results[0]!.maximumRows)
    assert.ok(results[1]!.maximumRows <= 64)
    assert.equal(results[0]!.cursor, results[1]!.cursor)
    assert.equal(results[0]!.count, 40)
    assert.equal(results[1]!.count, 40)
  } finally {
    adaptive.close()
  }
})

test('superseded acquisition passes lifecycle abort and waits owned transport completion before new body work', async () => {
  const fixture = transferFixture()
  let started: () => void = () => {}
  let completed: () => void = () => {}
  const readiness = new Promise<void>((resolve) => {
    started = resolve
  })
  const completion = new Promise<void>((resolve) => {
    completed = resolve
  })
  let requests = 0
  let inFlight = 0
  let maximumInFlight = 0
  let aborts = 0
  const transport: import('../src/core/types.js').Transport = {
    ...fixture.transport,
    snapshotParts: async (_request, lifecycle) => {
      assert.ok(lifecycle)
      return fixture.plan.descriptor
    },
    snapshotPartBatch: async (_request, lifecycle) => {
      assert.ok(lifecycle)
      const first = ++requests === 1
      if (!first) await completion
      inFlight++
      maximumInFlight = Math.max(maximumInFlight, inFlight)
      let abort: () => void = () => {}
      const canceled = new Promise<void>((resolve) => {
        abort = resolve
      })
      const unsubscribe = lifecycle.subscribe(() => {
        aborts++
        abort()
      })
      return {
        confirmationToken: 'final-confirmation',
        parts: (async function* () {
          try {
            if (first) {
              started()
              await canceled
            }
            if (lifecycle.cancelled)
              throw new SynloquentError(
                'session_changed',
                'Owned request aborted',
              )
            for (const part of fixture.plan.parts) yield part
          } finally {
            unsubscribe()
            inFlight--
            if (first) completed()
          }
        })(),
      }
    },
    confirmSnapshotParts: async (_request, lifecycle) => {
      assert.ok(lifecycle)
      assert.equal(lifecycle.cancelled, false)
      return fixture.plan.confirmation
    },
  }
  const client = await createSynloquent({
    ...fixture.configuration(),
    transport,
  })
  const first = client.sync.resnapshot().then(
    () => undefined,
    (failure) => failure as unknown,
  )
  try {
    await readiness
    await client.sync.resnapshot()
    assert.ok(hasCode('session_changed')(await first))
    assert.equal(aborts, 1)
    assert.equal(inFlight, 0)
    assert.equal(maximumInFlight, 1)
    assert.equal(await client.models.Item!.count(), 3)
  } finally {
    await client.close()
  }
})

test('pending final confirmation remains cancelable by session replacement and cleans its subscription', async () => {
  const fixture = transferFixture()
  let started: () => void = () => {}
  const readiness = new Promise<void>((resolve) => {
    started = resolve
  })
  let listeners = 0
  let aborts = 0
  const transport: import('../src/core/types.js').Transport = {
    ...fixture.transport,
    confirmSnapshotParts: async (_request, lifecycle) => {
      assert.ok(lifecycle)
      let abort: () => void = () => {}
      const canceled = new Promise<void>((resolve) => {
        abort = resolve
      })
      listeners++
      const unsubscribe = lifecycle.subscribe(() => {
        aborts++
        abort()
      })
      try {
        started()
        await canceled
        throw new SynloquentError('session_changed', 'Confirmation aborted')
      } finally {
        unsubscribe()
        listeners--
      }
    },
  }
  const client = await createSynloquent({
    ...fixture.configuration(),
    transport,
  })
  const result = client.sync.resnapshot().then(
    () => undefined,
    (failure) => failure as unknown,
  )
  try {
    await readiness
    await client.sync.setSession({
      ...client.storage.session,
      accountId: 'new-account',
    })
    assert.ok(hasCode('session_changed')(await result))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(aborts, 1)
    assert.equal(listeners, 0)
    assert.equal(await client.models.Item!.allowPartial().count(), 0)
  } finally {
    await client.close()
  }
})

test('legal oversized server admission preserves typed defer and the ready part ceiling', async () => {
  for (const status of ['admission-required', 'ready'] as const) {
    const fixture = transferFixture()
    fixture.plan.descriptor = {
      ...fixture.plan.descriptor,
      status,
      reason: 'row-exceeds-part-budget',
      maximumRowBytes: 70000,
    }
    const phases: string[] = []
    const client = await createSynloquent(
      fixture.configuration(':memory:', {
        observeSnapshotPhase: (event) =>
          phases.push(`${event.phase}:${event.state}`),
      }),
    )
    try {
      await assert.rejects(
        client.sync.resnapshot(),
        hasCode(
          status === 'ready'
            ? 'snapshot_invalid'
            : 'snapshot_admission_required',
        ),
      )
      assert.deepEqual(phases, ['validation:begin', 'validation:end'])
      assert.equal(fixture.requestedOrdinals.length, 0)
      assert.equal(client.storage.owner.generation, 0)
    } finally {
      await client.close()
    }
  }
})

test('bounded success emits each original real phase once and removes its private schema', async () => {
  const fixture = transferFixture()
  const phases: string[] = []
  const client = await createSynloquent(
    fixture.configuration(':memory:', {
      observeSnapshotPhase: (event) =>
        phases.push(`${event.phase}:${event.state}`),
    }),
  )
  try {
    const schemaBefore = await client.storage.read((executor) =>
      executor.execute(
        "SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'syn_%' ORDER BY type,name",
      ),
    )
    await client.sync.resnapshot()
    for (const phase of [
      'validation',
      'digest',
      'staging',
      'records',
      'relationSets',
      'integrity',
      'commit',
    ]) {
      assert.equal(
        phases.filter((value) => value === `${phase}:begin`).length,
        1,
      )
      assert.equal(phases.filter((value) => value === `${phase}:end`).length, 1)
    }
    const schemaAfter = await client.storage.read((executor) =>
      executor.execute(
        "SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'syn_%' ORDER BY type,name",
      ),
    )
    assert.deepEqual(schemaAfter.rows, schemaBefore.rows)
    await client.sync.resnapshot()
    assert.equal(client.storage.owner.generation, 2)
  } finally {
    await client.close()
  }
})

test('only an actually oversized dependency closure defers and rolls back private activation', async () => {
  const records = [
    item('1', {}),
    ...Array.from({ length: 140 }, (_, index) => ({
      model: 'Image',
      id: String(index + 1),
      revision: '1',
      attributes: { id: String(index + 1), item_id: '1', url: `${index}.jpg` },
    })),
  ]
  const schema = {
    ...manifest,
    models: {
      ...manifest.models,
      Image: {
        ...manifest.models.Image!,
        relations: {
          item: {
            ...manifest.models.Image!.relations.item!,
            onDelete: 'cascade' as const,
          },
        },
      },
    },
  }
  const fixture = transferFixture(planFor(records))
  const client = await createSynloquent(
    fixture.configuration(':memory:', { schema }),
  )
  await client.sync.installSnapshot(snapshotFor(records, schema))
  await (await client.models.Item!.findOrFail(1)).forceDelete()
  const generation = client.storage.owner.generation
  try {
    await assert.rejects(
      client.sync.resnapshot(),
      hasCode('snapshot_admission_required'),
    )
    assert.equal(client.storage.owner.generation, generation)
    assert.equal(await stageCount(client), records.length)
    assert.equal(await client.models.Item!.count(), 0)
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

test('single-copy staging preserves Unicode, escaped root keys and all original whitespace on resume', async () => {
  const name = 'Příliš 😀 "rows": [nested-looking text]'
  const plan = planFor([item('1', { name }), item('2', {}), item('3', {})])
  const first = plan.parts[0]!
  const originalRows =
    '[\n  ' +
    canonicalJson(first.rows[0]) +
    ' \t,\r\n ' +
    canonicalJson(first.rows[1]) +
    '\n]'
  const rawDocument =
    '{ \n "format" : "canonical-parts-v1", "\\u0072ows" \t: ' +
    originalRows +
    ' , "ordinal":0,"section":"records","rowCount":2,"firstIndex":0 }\n'
  plan.parts[0] = {
    ...first,
    rawRows: originalRows,
    rawDocument,
    hash: createHash('sha256').update(rawDocument).digest('hex'),
    byteSize: utf8Length(rawDocument),
  }
  const content =
    '{"records":[' +
    plan.parts.map((part) => part.rawRows.slice(1, -1)).join(',') +
    '],"relationSets":[]}'
  const hash = createHash('sha256').update(content).digest('hex')
  plan.descriptor = {
    ...plan.descriptor,
    hash,
    byteSize: utf8Length(content),
    firstPart: plan.identity(0),
  }
  plan.confirmation = {
    ...plan.confirmation,
    hash,
    byteSize: utf8Length(content),
  }
  const fixture = transferFixture(plan)
  fixture.onBeforePart((ordinal) => {
    if (ordinal === 1) throw new Error('Preserved partial acquisition')
  })
  const client = await createSynloquent(fixture.configuration())
  try {
    await assert.rejects(
      client.sync.resnapshot(),
      /Preserved partial acquisition/,
    )
    await client.storage.read(async (executor) => {
      const columns = await executor.execute(
        'PRAGMA table_info(syn_snapshot_parts)',
      )
      assert.equal(
        columns.rows.some(
          (row) => row.name === 'raw_document' || row.name === 'raw_rows',
        ),
        false,
      )
      const framing = (
        await executor.execute(
          'SELECT raw_prefix,raw_suffix FROM syn_snapshot_parts WHERE ordinal = 0',
        )
      ).rows[0]!
      const rows = await executor.execute(
        'SELECT payload FROM syn_snapshot_rows ORDER BY row_index',
      )
      assert.equal(rows.rows.length, 2)
      const rawRows =
        '[' + rows.rows.map((row) => String(row.payload)).join(',') + ']'
      assert.equal(rawRows, originalRows)
      assert.equal(
        String(framing.raw_prefix) + rawRows + String(framing.raw_suffix),
        rawDocument,
      )
    })
    fixture.onBeforePart()
    await client.sync.resnapshot()
    assert.equal(
      (await client.models.Item!.findOrFail(1)).attributes.name,
      name,
    )
    assert.equal(await stageCount(client), 0)
  } finally {
    await client.close()
  }
})

test('unpublished triple-copy acquisitions defer with their own legal continuation and data intact', async () => {
  const fixture = transferFixture()
  const client = await createSynloquent(fixture.configuration())
  try {
    await client.storage.write(async (executor) => {
      await executor.execute(
        'CREATE TABLE syn_snapshot_parts (raw_document TEXT NOT NULL,raw_rows TEXT NOT NULL)',
      )
      await executor.execute('INSERT INTO syn_snapshot_parts VALUES (?,?)', [
        'preserved-document',
        'preserved-rows',
      ])
      await executor.execute(
        'CREATE TABLE syn_snapshot_acquisitions (partition TEXT NOT NULL,dataset TEXT NOT NULL,session TEXT NOT NULL,next_request TEXT)',
      )
      await executor.execute(
        'INSERT INTO syn_snapshot_acquisitions VALUES (?,?,?,?)',
        [
          client.storage.partition,
          'default',
          canonicalJson(client.storage.session),
          canonicalJson(fixture.plan.identity(0)),
        ],
      )
    })
    await assert.rejects(client.sync.resnapshot(), (failure) => {
      assert.ok(failure instanceof SynloquentError)
      assert.equal(failure.code, 'snapshot_admission_required')
      assert.equal(failure.details.reason, 'unsupported-private-layout')
      assert.deepEqual(failure.details.continuation, fixture.plan.identity(0))
      return true
    })
    const preserved = await client.storage.read((executor) =>
      executor.execute('SELECT * FROM syn_snapshot_parts'),
    )
    assert.equal(preserved.rows[0]!.raw_document, 'preserved-document')
    assert.equal(preserved.rows[0]!.raw_rows, 'preserved-rows')
    assert.equal(fixture.prepares, 0)
    assert.equal(client.storage.owner.generation, 0)
  } finally {
    await client.close()
  }
})
