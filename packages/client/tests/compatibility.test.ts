import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { SynloquentClient } from '../src/core/client.js'
import { quoteIdentifier } from '../src/core/database.js'
import { createSynloquent, SynloquentError } from '../src/index.js'
import type { Manifest, WireValue } from '../src/index.js'
import { configuration, item, manifest, snapshotFor } from './fixtures.js'
import { testTransport } from './transport-fixture.js'

test('C54 compatible online field backfill is atomic, retains pending edits and boots offline from cached manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synloquent-schema-'))
  const filename = join(directory, 'schema.sqlite')
  const server = testTransport()
  const next: Manifest = {
    ...manifest,
    fingerprint: 'fixture-v2',
    schemaVersion: 2,
    capabilities: ['query.v1'],
    models: {
      ...manifest.models,
      Item: {
        ...manifest.models.Item!,
        fields: {
          ...manifest.models.Item!.fields,
          rank: {
            type: 'integer',
            nullable: true,
            readable: true,
            writable: true,
          },
        },
        indexes: [...manifest.models.Item!.indexes!, ['rank']],
      },
    },
  }
  server.transport.manifest = async () => next
  server.transport.snapshot = async () =>
    snapshotFor(
      [
        item('1', {
          name: 'New canonical title',
          rank: '18446744073709551614',
        }),
      ],
      next,
    )
  let client = await createSynloquent(configuration(filename, server.transport))
  try {
    await client.storage.write((executor, changed) =>
      client.storage.ingest(
        item('1', { name: 'Original title' }),
        executor,
        changed,
      ),
    )
    const local = await client.models.Item!.findOrFail(1)
    await local.update({ name: 'Retained offline title' })
    const identity = local.localIdentity
    assert.equal(await client.sync.updateManifest('default'), true)
    assert.equal(client.storage.manifest.fingerprint, next.fingerprint)
    assert.equal(
      (await client.models.Item!.findOrFail(identity)).attributes.name,
      'Retained offline title',
    )
    assert.equal(
      (await client.models.Item!.where('rank', '>', '9007199254740991').get())
        .length,
      1,
    )
    assert.equal(await client.sync.updateManifest('default'), false)
    await client.close()
    client = await createSynloquent(configuration(filename))
    assert.equal(client.storage.manifest.fingerprint, next.fingerprint)
    assert.equal(
      (await client.models.Item!.findOrFail(identity)).attributes.rank,
      '18446744073709551614',
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
    await rm(directory, { recursive: true, force: true })
  }
})

function durableSchemaState(filename: string) {
  const database = new DatabaseSync(filename, { readOnly: true })
  try {
    const schema = database
      .prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name')
      .all()
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name",
      )
      .all()
    return {
      schema,
      tables: Object.fromEntries(
        tables.map(({ name }) => [
          String(name),
          database
            .prepare(`SELECT * FROM ${quoteIdentifier(String(name))}`)
            .all(),
        ]),
      ),
    }
  } finally {
    database.close()
  }
}

for (const scenario of [
  'rollback',
  'listener failure',
  'in-flight visibility',
] as const) {
  test(`C54 manifest COMMIT boundary: ${scenario}`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'synloquent-manifest-commit-'),
    )
    const filename = join(directory, 'schema.sqlite')
    const server = testTransport()
    const next: Manifest = {
      ...manifest,
      fingerprint: 'fixture-v2',
      schemaVersion: 2,
      models: {
        ...manifest.models,
        Item: {
          ...manifest.models.Item!,
          fields: {
            ...manifest.models.Item!.fields,
            rank: {
              type: 'integer',
              nullable: true,
              readable: true,
              writable: true,
            },
          },
          indexes: [...manifest.models.Item!.indexes!, ['rank']],
        },
      },
    }
    server.transport.manifest = async () => next
    server.transport.snapshot = async () =>
      snapshotFor([item('1', { name: 'New canonical title', rank: 7 })], next)
    const settings = configuration(filename, server.transport)
    const transaction = settings.database.transaction.bind(settings.database)
    let armed = false
    let releaseCommit = () => {}
    let reachCommit = () => {}
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    const atCommit = new Promise<void>((resolve) => {
      reachCommit = resolve
    })
    settings.database.transaction = (callback, mode) =>
      transaction(async (executor) => {
        const result = await callback(executor)
        if (armed && mode === 'write') {
          armed = false
          reachCommit()
          await commitGate
          if (scenario === 'rollback') {
            // DML succeeds. SQLite rejects the real COMMIT and the adapter rolls back.
            await executor.execute(
              'CREATE TABLE commit_parent (identity INTEGER PRIMARY KEY)',
            )
            await executor.execute(
              'CREATE TABLE commit_child (parent INTEGER REFERENCES commit_parent(identity) DEFERRABLE INITIALLY DEFERRED)',
            )
            await executor.execute(
              'INSERT INTO commit_child(parent) VALUES (1)',
            )
            assert.equal(
              (await executor.execute('PRAGMA foreign_key_check')).rows.length,
              1,
            )
          }
        }
        return result
      }, mode)
    let client: SynloquentClient | undefined
    try {
      client = await createSynloquent(settings)
      await client.sync.installSnapshot(
        snapshotFor([item('1', { name: 'Original title' })]),
      )
      const local = await client.models.Item!.findOrFail(1)
      await local.update({ name: 'Retained offline title' })
      const pendingCreate = await client.models.Item!.create({
        name: 'Pending create',
      })
      const originalManifest = client.storage.manifest
      const before = durableSchemaState(filename)
      const pending = await client.storage.read((executor) =>
        client!.storage.pending(executor),
      )
      const generation = client.storage.owner.generation
      let notifications = 0
      let notificationManifest: Manifest | undefined
      let notificationState: ReturnType<typeof durableSchemaState> | undefined
      const listenerFailure = new Error('Subscriber failed after COMMIT')
      client.storage.owner.subscribe(() => {
        notifications++
        notificationManifest = client!.storage.manifest
        notificationState = durableSchemaState(filename)
        if (scenario === 'listener failure') throw listenerFailure
      })
      armed = true
      const upgrade = client.sync.updateManifest('default')
      const outcome = upgrade.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      )
      await Promise.race([
        atCommit,
        outcome.then(() => {
          throw new Error('Upgrade ended before the COMMIT barrier')
        }),
      ])
      const inFlightManifest = client.storage.manifest
      const inFlightEnvelope = client.sync.envelope(
        'query',
        {},
      ).schemaFingerprint
      const inFlightDurable = durableSchemaState(filename)
      let queuedReadFinished = false
      const queuedRead = client.storage.read(async (executor) => {
        queuedReadFinished = true
        return {
          manifest: client!.storage.manifest,
          metadata: await client!.storage.metadata('manifest', executor),
        }
      })
      await Promise.resolve()
      const serialized = !queuedReadFinished
      releaseCommit()
      const result = await outcome
      const queued = await queuedRead
      const after = durableSchemaState(filename)
      const expectedManifest = scenario === 'rollback' ? originalManifest : next
      if (scenario === 'rollback') {
        assert.match(String(result.error), /FOREIGN KEY constraint failed/)
        assert.deepEqual(after, before)
        assert.equal(notifications, 0)
        assert.equal(client.storage.owner.generation, generation)
      } else {
        if (scenario === 'listener failure')
          assert.equal(result.error, listenerFailure)
        else assert.equal(result.value, true)
        assert.equal(notifications, 1)
        assert.deepEqual(notificationManifest, next)
        assert.deepEqual(notificationState, after)
        assert.equal(client.storage.owner.generation, generation + 1)
        assert.equal(
          (await client.models.Item!.where('rank', 7).get()).length,
          1,
        )
      }
      assert.deepEqual(client.storage.manifest, expectedManifest)
      assert.deepEqual(queued.manifest, expectedManifest)
      assert.deepEqual(JSON.parse(queued.metadata!), expectedManifest)
      assert.equal(serialized, true)
      assert.deepEqual(inFlightDurable, before)
      assert.equal(
        (await client.models.Item!.findOrFail(local.localIdentity)).attributes
          .name,
        'Retained offline title',
      )
      assert.equal(
        (await client.models.Item!.findOrFail(pendingCreate.localIdentity))
          .attributes.name,
        'Pending create',
      )
      assert.deepEqual(
        await client.storage.read((executor) =>
          client!.storage.pending(executor),
        ),
        pending,
      )
      await client.close()
      client = await createSynloquent(configuration(filename))
      assert.deepEqual(client.storage.manifest, expectedManifest)
      assert.deepEqual(durableSchemaState(filename), after)
      assert.equal(
        (await client.models.Item!.findOrFail(local.localIdentity)).attributes
          .name,
        'Retained offline title',
      )
      assert.equal(
        (await client.models.Item!.findOrFail(pendingCreate.localIdentity))
          .attributes.name,
        'Pending create',
      )
      assert.deepEqual(
        await client.storage.read((executor) =>
          client!.storage.pending(executor),
        ),
        pending,
      )
      if (scenario === 'in-flight visibility') {
        assert.equal(inFlightManifest, originalManifest)
        assert.equal(inFlightEnvelope, originalManifest.fingerprint)
      }
    } finally {
      releaseCommit()
      if (client) await client.close()
      else await settings.database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('C54 unknown required engine capability, malformed indexes and breaking field changes fail closed', async () => {
  for (const schema of [
    { ...manifest, capabilities: ['unregistered.executable.v9'] },
    {
      ...manifest,
      models: {
        ...manifest.models,
        Item: { ...manifest.models.Item!, indexes: [['secret_not_exported']] },
      },
    },
  ]) {
    const settings = { ...configuration(), schema }
    try {
      await assert.rejects(
        createSynloquent(settings),
        (error) =>
          error instanceof SynloquentError &&
          ['upgrade_required', 'schema_mismatch'].includes(error.code),
      )
    } finally {
      await settings.database.close()
    }
  }
  const server = testTransport()
  server.transport.manifest = async () => ({
    ...manifest,
    fingerprint: 'breaking',
    models: {
      ...manifest.models,
      Item: {
        ...manifest.models.Item!,
        fields: {
          ...manifest.models.Item!.fields,
          price: { ...manifest.models.Item!.fields.price!, precision: 3 },
        },
      },
    },
  })
  const client = await createSynloquent(
    configuration(':memory:', server.transport),
  )
  try {
    await assert.rejects(
      client.sync.updateManifest(),
      (error) =>
        error instanceof SynloquentError && error.code === 'upgrade_required',
    )
    assert.equal(client.storage.manifest.fingerprint, manifest.fingerprint)
  } finally {
    await client.close()
  }
})

test('C48 command immutable identity survives lost response/restart and enforces declared argument/result projections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synloquent-command-'))
  const filename = join(directory, 'commands.sqlite')
  const schema: Manifest = {
    ...manifest,
    commands: {
      increase: {
        arguments: {
          amount: {
            type: 'integer',
            nullable: false,
            readable: true,
            writable: true,
          },
        },
        result: {
          total: {
            type: 'integer',
            nullable: false,
            readable: true,
            writable: false,
          },
        },
      },
    },
  }
  const server = testTransport()
  const receipts = new Map<string, WireValue>()
  let effects = 0
  let lose = true
  server.transport.command = async <Result extends WireValue>(
    request: Parameters<typeof server.transport.command>[0],
  ): Promise<Result> => {
    let result = receipts.get(request.payload.operationId)
    if (!result) {
      result = { total: ++effects }
      receipts.set(request.payload.operationId, result)
    }
    if (lose) {
      lose = false
      throw new Error('Command response lost after durable effect')
    }
    return JSON.parse(JSON.stringify(result)) as Result
  }
  let client = await createSynloquent({
    ...configuration(filename, server.transport),
    schema,
  })
  try {
    await assert.rejects(
      client.sync.command('increase', { amount: 2 }, 'stable-command'),
      /response lost/,
    )
    await client.close()
    client = await createSynloquent({
      ...configuration(filename, server.transport),
      schema,
    })
    assert.deepEqual(
      await client.sync.command('increase', { amount: 2 }, 'stable-command'),
      { total: 1 },
    )
    assert.deepEqual(
      await client.sync.command('increase', { amount: 2 }, 'stable-command'),
      { total: 1 },
    )
    assert.equal(effects, 1)
    await assert.rejects(
      client.sync.command('increase', { amount: 3 }, 'stable-command'),
      (error) =>
        error instanceof SynloquentError &&
        error.code === 'idempotency_mismatch',
    )
    await assert.rejects(
      client.sync.command('unknown', {}, 'unknown'),
      (error) =>
        error instanceof SynloquentError &&
        error.code === 'forbidden_operation',
    )
    await assert.rejects(
      client.sync.command('increase', {}, 'missing'),
      /Missing command argument/,
    )
    await assert.rejects(
      client.sync.command('increase', { amount: 1, secret: true }, 'extra'),
      /Unknown command argument/,
    )
    server.transport.command = async <
      Result extends WireValue,
    >(): Promise<Result> => JSON.parse('{}') as Result
    await assert.rejects(
      client.sync.command('increase', { amount: 1 }, 'missing-result'),
      (error) =>
        error instanceof SynloquentError && error.code === 'schema_mismatch',
    )
  } finally {
    await client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('C46 C49 C50 registered remote scopes validate transport mode and unsupported local server execution is explicit', async () => {
  const schema: Manifest = {
    ...manifest,
    scopes: {
      priced: {
        model: 'Item',
        arguments: {
          minimum: {
            type: 'decimal',
            precision: 2,
            nullable: false,
            readable: true,
            writable: true,
          },
        },
      },
    },
  }
  const server = testTransport()
  let requested = false
  server.transport.query = async (request) => {
    requested = true
    assert.deepEqual(request.payload.scopes, [
      { name: 'priced', arguments: { minimum: '2.00' } },
    ])
    return {
      records: [item('1', { price: '3.00' })],
      related: [],
      relationSets: [],
      completeness: 'complete',
      scope: snapshotFor([]).scope,
    }
  }
  const client = await createSynloquent({
    ...configuration(':memory:', server.transport),
    schema,
  })
  try {
    const scoped = client.models.Item!.scope('priced', { minimum: '2.00' })
    await assert.rejects(
      scoped.get(),
      (error) =>
        error instanceof SynloquentError && error.code === 'unsupported_query',
    )
    assert.equal((await scoped.remote().get()).length, 1)
    assert.equal(requested, true)
    assert.throws(
      () => client.models.Item!.lockForUpdate(),
      (error) =>
        error instanceof SynloquentError && error.code === 'unsupported_query',
    )
    assert.throws(
      () => client.models.Item!.sharedLock(),
      (error) =>
        error instanceof SynloquentError && error.code === 'unsupported_query',
    )
    assert.throws(
      () =>
        client.models.Item!.whereRaw('price > CAST(? AS numeric)', ['2.00']),
      (error) =>
        error instanceof SynloquentError && error.code === 'unsupported_query',
    )
    assert.throws(
      () =>
        client.models.Item!.selectRaw('json_extract(metadata, ?)', [
          '$.private',
        ]),
      (error) =>
        error instanceof SynloquentError && error.code === 'unsupported_query',
    )
    assert.throws(
      () => client.models.Item!.scope('unregistered', {}),
      (error) =>
        error instanceof SynloquentError &&
        error.code === 'forbidden_operation',
    )
  } finally {
    await client.close()
  }
})

test('C01 C05 C07 actual generated custom/UUID/ULID identities and materialized projections retain declared offline availability', async () => {
  const schema = JSON.parse(
    await readFile(
      new URL('../../../protocol/fixtures/manifest.json', import.meta.url),
      'utf8',
    ),
  ) as Manifest
  const client = await createSynloquent({ ...configuration(), schema })
  try {
    for (const [model, definition] of Object.entries(schema.models))
      if (!definition.incrementing) {
        const attributes = Object.fromEntries(
          Object.entries(definition.fields)
            .filter(
              ([field, exported]) =>
                field !== definition.primaryKey &&
                exported.writable &&
                !exported.nullable &&
                exported.default === undefined,
            )
            .map(([field]) => [field, 'Fixture']),
        )
        if (definition.fields[definition.primaryKey]?.writable)
          attributes[definition.primaryKey] = `custom-${model}`
        const created = await client.models[model]!.create(attributes)
        assert.equal(created.localIdentity.startsWith('identity-'), true)
        assert.equal(
          String(created.id),
          attributes[definition.primaryKey] ?? created.localIdentity,
        )
      }
    const draft = client.models.Item!.new({ title: 'Offline append' })
    assert.equal(draft.attributes.display_label, undefined)
    assert.throws(
      () => draft.fill({ display_label: 'Execute PHP locally' }),
      (error) =>
        error instanceof SynloquentError && error.code === 'forbidden_field',
    )
    await client.storage.write((executor, changed) =>
      client.storage.ingest(
        {
          model: 'Item',
          id: '999',
          revision: '1',
          attributes: {
            id: 999,
            title: 'Server append',
            active: true,
            price: '1.25',
            quantity: 1,
            metadata: null,
            labels: [],
            category_id: null,
            display_label: 'Server append [1.25]',
            created_at: null,
            updated_at: null,
          },
        },
        executor,
        changed,
      ),
    )
    assert.equal(
      (await client.models.Item!.findOrFail(999)).attributes.display_label,
      'Server append [1.25]',
    )
  } finally {
    await client.close()
  }
})
