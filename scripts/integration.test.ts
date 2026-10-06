import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:net'
import { Ajv2020 } from 'ajv/dist/2020.js'
import {
  createSynloquent,
  isErrorCode,
  Query,
  SynloquentError,
} from '@synloquent/client'
import type {
  Attributes,
  Envelope,
  Manifest,
  QueryOptions,
  Session,
  Transport,
  WireValue,
} from '@synloquent/client'
import { NodeDatabase } from './node-database.js'
import type {
  BackendCommands,
  BackendModels,
  BackendScopes,
} from '../protocol/fixtures/backend.generated.js'
import {
  portableMutationScenarios,
  portableReadScenarios,
} from '../packages/client/tests/capability-scenarios.js'

const repository = resolve(import.meta.dirname, '..')
const host = join(repository, 'examples/laravel')
const session: Session = {
  accountId: '1',
  tenantId: '1',
  deviceId: 'integration-device',
  deviceEpoch: 'integration-epoch',
  generation: 0,
}
const validator = new Ajv2020({ strict: true, allErrors: true })
for (const filename of readdirSync(join(repository, 'protocol/schemas')).filter(
  (name) => name.endsWith('.json'),
))
  validator.addSchema(
    JSON.parse(
      readFileSync(join(repository, 'protocol/schemas', filename), 'utf8'),
    ),
  )
const validate = (schema: string, value: unknown): void => {
  const check = validator.getSchema(
    `https://synloquent.local/protocol/1/${schema}.schema.json`,
  )
  assert.ok(check)
  assert.ok(check(value), JSON.stringify(check.errors))
}
const envelope = <Payload>(
  kind: string,
  payload: Payload,
  fingerprint: string,
): Envelope<Payload> => ({
  protocolVersion: 1,
  requestId: randomUUID(),
  kind,
  schemaFingerprint: fingerprint,
  session,
  payload,
})

function transportFor(url: string, actor = '1'): Transport {
  async function request<Result>(
    requestEnvelope: Envelope<unknown>,
    responseSchema?: string,
  ): Promise<Result> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer synthetic-actor-${actor}`,
        'X-Synloquent-Device': requestEnvelope.session.deviceId,
        'X-Synloquent-Device-Epoch': requestEnvelope.session.deviceEpoch,
      },
      body: JSON.stringify(requestEnvelope),
    })
    const result = (await response.json()) as {
      requestId?: string
      payload?: Result
      error?: {
        code: string
        message: string
        details?: Record<string, unknown>
      }
    }
    if (!response.ok || result.error) {
      const wireCode = result.error?.code
      const failure = new SynloquentError(
        isErrorCode(wireCode) ? wireCode : 'schema_mismatch',
        result.error?.message ?? `HTTP ${response.status}`,
        {
          ...result.error?.details,
          ...(isErrorCode(wireCode)
            ? {}
            : { wireCode: wireCode ?? 'http_error' }),
        },
      )
      Object.assign(failure, { status: response.status })
      throw failure
    }
    assert.equal(
      result.requestId,
      requestEnvelope.requestId,
      'HTTP response identity must match its exact request',
    )
    assert.ok('payload' in result)
    if (responseSchema) validate(responseSchema, result.payload)
    return result.payload as Result
  }
  return {
    manifest: (requestEnvelope) => request(requestEnvelope, 'manifest'),
    query: (requestEnvelope) => request(requestEnvelope, 'query-response'),
    push: async (requestEnvelope) => {
      const result = await request<{ receipts: unknown[] }>(requestEnvelope)
      for (const receipt of result.receipts) validate('receipt', receipt)
      return result as Awaited<ReturnType<Transport['push']>>
    },
    pull: (requestEnvelope) => request(requestEnvelope, 'pull'),
    snapshot: (requestEnvelope) => request(requestEnvelope, 'snapshot'),
    command: async <Result extends WireValue>(
      requestEnvelope: Envelope<{
        readonly name: string
        readonly operationId: string
        readonly arguments: Attributes
      }>,
    ) => (await request<{ result: Result }>(requestEnvelope)).result,
  }
}

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePort) =>
    server.listen(0, '127.0.0.1', resolvePort),
  )
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolveClose, reject) =>
    server.close((failure) => (failure ? reject(failure) : resolveClose())),
  )
  return port
}

test('real Laravel HTTP/PostgreSQL and SQLite vertical slice with lost-response recovery', async (context) => {
  const artifacts = join(repository, '.local/test-results/integration')
  mkdirSync(artifacts, { recursive: true })
  const temporary = mkdtempSync(join(artifacts, 'synloquent-http-'))
  const databaseName = `synloquent_integration_${process.pid}`
  const environment = {
    ...process.env,
    DB_DATABASE: databaseName,
    DB_CONNECTION: 'pgsql',
    DB_HOST: '127.0.0.1',
    DB_PORT: '55432',
    DB_USERNAME: 'synloquent',
    DB_PASSWORD: '',
  }
  const databaseArguments = [
    '-h',
    '127.0.0.1',
    '-p',
    '55432',
    '-U',
    'synloquent',
    databaseName,
  ]
  const created = spawnSync(
    join(process.env.SYNLOQUENT_POSTGRES_BIN ?? '', 'createdb'),
    databaseArguments,
    { encoding: 'utf8' },
  )
  assert.equal(created.status, 0, created.stderr)
  let httpServer: ReturnType<typeof spawn> | undefined
  let client:
    | Awaited<
        ReturnType<
          typeof createSynloquent<BackendModels, BackendCommands, BackendScopes>
        >
      >
    | undefined
  let serverOutput = ''
  const checks: string[] = []
  const methodWitnesses: {
    methods: readonly string[]
    target: 'local' | 'remote'
    testcase: string
    source: string
  }[] = []
  try {
    for (const arguments_ of [
      ['artisan', 'migrate', '--force'],
      ['artisan', 'synloquent:seed-example'],
    ]) {
      const result = spawnSync('php', arguments_, {
        cwd: host,
        env: environment,
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stdout + result.stderr)
    }
    const port = await availablePort()
    httpServer = spawn(
      'php',
      ['artisan', 'serve', '--host=127.0.0.1', `--port=${port}`, '--tries=1'],
      {
        cwd: host,
        env: environment,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    httpServer.stdout?.on('data', (chunk: Buffer) => {
      serverOutput += chunk.toString()
    })
    httpServer.stderr?.on('data', (chunk: Buffer) => {
      serverOutput += chunk.toString()
    })
    const url = `http://127.0.0.1:${port}/synloquent/v1/protocol`
    const transport = transportFor(url)
    let manifest: Manifest | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        manifest = await transport.manifest(envelope('manifest', {}, 'boot'))
        break
      } catch (failure) {
        if (attempt === 99 || httpServer.exitCode !== null) throw failure
        await delay(50)
      }
    }
    assert.ok(manifest)
    const filename = join(temporary, 'client.sqlite')
    let instant = Date.now()
    let loseResponse = false
    const injectedTransport: Transport = {
      ...transport,
      push: async (requestEnvelope) => {
        const response = await transport.push(requestEnvelope)
        if (loseResponse) {
          loseResponse = false
          throw new Error('Injected response loss after actual server commit')
        }
        return response
      },
    }
    const configuration = () => ({
      schema: manifest,
      database: new NodeDatabase(filename),
      transport: injectedTransport,
      session,
      generateIdentity: randomUUID,
      now: () => new Date(instant).toISOString(),
      digest: async (content: string) =>
        createHash('sha256').update(content).digest('hex'),
    })
    client = await createSynloquent<
      BackendModels,
      BackendCommands,
      BackendScopes
    >(configuration())
    const recordMethods = (
      methods: readonly string[],
      testcase: string,
      targets: readonly ('local' | 'remote')[] = ['local', 'remote'],
    ): void => {
      for (const target of targets)
        methodWitnesses.push({
          methods,
          target,
          testcase,
          source: 'scripts/integration.test.ts',
        })
    }
    await context.test(
      'initial consistent snapshot and batched relations',
      async () => {
        await client!.sync.resnapshot('catalog')
        const items = await client!.models.Item.with(
          'images',
          'category',
          'tags',
        ).get()
        assert.equal(items.length, 3)
        assert.equal(items.completeness, 'complete')
        const alpine = await client!.models.Item.findOrFail(1)
        assert.equal(alpine.title, 'Alpine stamp')
        assert.equal(alpine.price, '12.50')
        const tags = await alpine.relation('tags').get()
        assert.equal(
          tags.length,
          1,
          'Snapshot must retain real ordered pivot membership',
        )
        checks.push('snapshot-relations')
        recordMethods(
          ['C52.completeDataset', 'C55.snapshot'],
          'initial consistent snapshot and batched relations',
        )
      },
    )
    await context.test(
      'language-independent SQLite and Laravel query corpus',
      async (corpusContext) => {
        const corpus = JSON.parse(
          readFileSync(
            join(repository, 'protocol/fixtures/query-conformance.json'),
            'utf8',
          ),
        ) as {
          cases: {
            name: string
            query: QueryOptions
            identities?: string[]
            aggregate?: WireValue
            error?: string
          }[]
        }
        assert.ok(corpus.cases.length > 0)
        for (const scenario of corpus.cases)
          await corpusContext.test(scenario.name, async () => {
            validate('query', scenario.query)
            const { aggregate: declaredAggregate, ...localOptions } =
              scenario.query
            const local = new Query(client!.storage, localOptions)
            if (scenario.error) {
              const expectedError = (failure: unknown): boolean =>
                failure instanceof SynloquentError &&
                failure.code === scenario.error
              await assert.rejects(
                transport.query(
                  envelope('query', scenario.query, manifest!.fingerprint),
                ),
                expectedError,
              )
              await assert.rejects(local.get(), expectedError)
              checks.push('query-corpus:' + scenario.name)
              return
            }
            const remote = await transport.query(
              envelope('query', scenario.query, manifest!.fingerprint),
            )
            if (declaredAggregate) {
              const aggregate = declaredAggregate
              const value = (
                await local.aggregateResult(aggregate.function, aggregate.field)
              ).value
              assert.deepEqual(
                remote.aggregate?.value,
                scenario.aggregate,
                'Laravel result must satisfy independent expected value',
              )
              assert.deepEqual(
                value,
                scenario.aggregate,
                'SQLite result must satisfy independent expected value',
              )
            } else {
              assert.deepEqual(
                remote.records.map((record) => record.id),
                scenario.identities,
                'Laravel identities',
              )
              assert.deepEqual(
                (await local.get()).items.map((model) => String(model.id)),
                scenario.identities,
                'SQLite identities',
              )
            }
            checks.push('query-corpus:' + scenario.name)
          })
      },
    )
    await context.test(
      'per-method public query APIs use independent local and real HTTP oracles',
      async (methodContext) => {
        for (const target of ['local', 'remote'] as const)
          for (const scenario of portableReadScenarios) {
            const testcase = `${target} ${scenario.name}`
            await methodContext.test(testcase, async () => {
              await scenario.run(client!, target)
              methodWitnesses.push({
                methods: scenario.methods,
                target,
                testcase,
                source: 'packages/client/tests/capability-scenarios.ts',
              })
            })
          }
      },
    )
    await context.test(
      'per-method public mutation APIs retain durable and confirmed behavior',
      async (methodContext) => {
        for (const target of ['local', 'remote'] as const)
          for (const scenario of portableMutationScenarios) {
            const testcase = `${target} ${scenario.name}`
            await methodContext.test(testcase, async () => {
              await scenario.run(client!, target)
              methodWitnesses.push({
                methods: scenario.methods,
                target,
                testcase,
                source: 'packages/client/tests/capability-scenarios.ts',
              })
            })
          }
      },
    )
    await context.test(
      'offline integer parent/child and immutable attempted payload replay',
      async () => {
        let parent = await client!.models.Category.create({
          title: `Offline category ${randomUUID()}`,
        })
        let child = await client!.models.Item.create({
          category_id: parent.id,
          title: `Offline item ${randomUUID()}`,
          price: '10.01',
          active: true,
          quantity: 1,
          metadata: { offline: true },
        })
        const stableParentIdentity = parent.localIdentity
        const stableChildIdentity = child.localIdentity
        const parentTitle = parent.title
        const offlineChildTitle = child.title
        loseResponse = true
        await assert.rejects(client!.sync.flush(), /Injected response loss/)
        await client!.sync.resnapshot('catalog')
        assert.equal(
          (await client!.models.Category.where('title', parentTitle).get())
            .length,
          1,
          'Snapshot aliases must merge a committed create before its lost receipt is replayed',
        )
        assert.equal(
          (await client!.models.Item.where('title', offlineChildTitle).get())
            .length,
          1,
        )
        assert.equal(
          (
            await client!.models.Item.where(
              'title',
              offlineChildTitle,
            ).firstOrFail()
          ).localIdentity,
          stableChildIdentity,
        )
        parent = await client!.models.Category.findOrFail(stableParentIdentity)
        child = await client!.models.Item.findOrFail(stableChildIdentity)
        instant += 120000
        await client!.sync.flush()
        await parent.refresh()
        await child.refresh()
        assert.equal(parent.localIdentity, stableParentIdentity)
        assert.equal(child.localIdentity, stableChildIdentity)
        assert.match(String(parent.id), /^\d+$/)
        assert.match(String(child.id), /^\d+$/)
        assert.equal(String(child.category_id), String(parent.id))
        const serverRows = await transport.query(
          envelope(
            'query',
            {
              model: 'Item',
              where: {
                kind: 'comparison',
                field: 'title',
                operator: '=',
                value: child.title,
              },
            },
            manifest!.fingerprint,
          ),
        )
        assert.equal(
          serverRows.records.length,
          1,
          'Lost response retry must not duplicate a committed domain write',
        )
        const serverChildIdentity = String(child.id)
        const childTitle = child.title
        await client!.close()
        client = await createSynloquent<
          BackendModels,
          BackendCommands,
          BackendScopes
        >(configuration())
        const reopened =
          await client.models.Item.findOrFail(serverChildIdentity)
        assert.equal(reopened.localIdentity, stableChildIdentity)
        assert.equal(reopened.title, childTitle)
        checks.push('integer-alias-replay-restart')
        recordMethods(
          ['C57.retryUncertainty', 'C57.immutableAttempt'],
          'offline integer parent/child and immutable attempted payload replay',
        )
      },
    )
    await context.test(
      'canonical pull retains local proposal and explicit conflict resolution',
      async () => {
        const item = await client!.models.Item.findOrFail(1)
        item.fill({ title: 'Retained local proposal' })
        assert.equal(item.isDirty('title'), true)
        await item.save()
        assert.equal(item.syncState, 'pending')
        assert.equal(item.isClean(), true)
        const query: QueryOptions = {
          model: 'Item',
          where: { kind: 'comparison', field: 'id', operator: '=', value: 1 },
        }
        const current = (
          await transport.query(envelope('query', query, manifest!.fingerprint))
        ).records[0]
        assert.ok(current)
        const receipt = await transport.push(
          envelope(
            'push',
            {
              operations: [
                {
                  operationId: randomUUID(),
                  model: 'Item',
                  localIdentity: 'independent-server-item',
                  id: '1',
                  action: 'update',
                  values: { title: 'Changed on server' },
                  expectedRevision: current.revision,
                  dependsOn: [],
                },
              ],
            },
            manifest!.fingerprint,
          ),
        )
        assert.equal(receipt.receipts[0]?.status, 'accepted')
        await client!.sync.pull('catalog')
        assert.equal(
          (await client!.models.Item.findOrFail(1)).title,
          'Retained local proposal',
        )
        await client!.sync.flush()
        const proposal = await client!.models.Item.findOrFail(1)
        assert.equal(proposal.syncState, 'conflicted')
        assert.equal(proposal.title, 'Retained local proposal')
        const conflicted = await client!.storage.read(async (executor) =>
          (await client!.storage.pending(executor)).find(
            (entry) =>
              entry.status === 'conflicted' &&
              entry.operation.operationId === item.lastOperationId,
          ),
        )
        assert.ok(conflicted)
        await client!.sync.resolveConflict(
          conflicted.operation.operationId,
          'discard',
        )
        assert.equal(
          (await client!.models.Item.findOrFail(1)).title,
          'Changed on server',
        )
        checks.push('conflict-retained-proposal')
        recordMethods(
          [
            'C53.draftDirty',
            'C53.durableIntent',
            'C53.pending',
            'C53.conflicted',
            'C57.discardConflict',
          ],
          'canonical pull retains local proposal and explicit conflict resolution',
        )
      },
    )
    await context.test(
      'typed registered command replay, remote scope and confirmed atomic delta',
      async () => {
        const commandIdentity = randomUUID()
        const result = await client!.commands.increaseQuantity(
          { item_id: 1, delta: 4 },
          commandIdentity,
        )
        assert.equal(result.quantity, 5)
        assert.deepEqual(
          await client!.commands.increaseQuantity(
            { item_id: 1, delta: 4 },
            commandIdentity,
          ),
          result,
        )
        const directReplay = await transport.command(
          envelope(
            'command',
            {
              name: 'increaseQuantity',
              operationId: commandIdentity,
              arguments: { item_id: 1, delta: 4 },
            },
            manifest!.fingerprint,
          ),
        )
        assert.deepEqual(directReplay, result)
        await assert.rejects(
          client!.commands.increaseQuantity(
            { item_id: 1, delta: 5 },
            commandIdentity,
          ),
          (failure: unknown) =>
            failure instanceof SynloquentError &&
            failure.code === 'idempotency_mismatch',
        )
        const scoped = await client!.scopes
          .activePriced({ minimumPrice: '12.00' })
          .get()
        assert.deepEqual(
          scoped.items.map((model) => String(model.id)),
          ['1', '3'],
        )
        const contained = await client!.scopes
          .metadataContains({ value: { region: 'synthetic' } })
          .get()
        assert.deepEqual(
          contained.items.map((model) => String(model.id)),
          ['1', '2', '3'],
          'Registered remote object containment must preserve the original positive oracle',
        )
        assert.equal(
          (
            await client!.scopes
              .metadataContains({ value: { region: 'absent' } })
              .get()
          ).items.length,
          0,
        )
        await client!.sync.pull('catalog')
        const item = await client!.models.Item.findOrFail(1)
        await item.increment('quantity', 1)
        assert.ok(item.lastOperationId)
        await client!.sync.confirmed(item.lastOperationId)
        await item.refresh()
        assert.equal(item.quantity, 6)
        assert.equal(item.syncState, 'synced')
        checks.push('typed-command-scope-confirmed-delta')
        recordMethods(
          ['C13.jsonObjectContainsRemote'],
          'typed registered command replay, remote scope and confirmed atomic delta',
        )
        recordMethods(
          ['C46.localScopeRemote', 'C48.typedCommand'],
          'typed registered command replay, remote scope and confirmed atomic delta',
          ['remote'],
        )
        recordMethods(
          ['C53.synced', 'C57.confirmedWrite'],
          'typed registered command replay, remote scope and confirmed atomic delta',
        )
      },
    )
    await context.test(
      'unsafe PostgreSQL integer identities retain exact HTTP and SQLite values',
      async () => {
        const identity = '9007199254740993'
        const inserted = spawnSync(
          'php',
          [
            '-r',
            "require 'vendor/autoload.php'; $application = require 'bootstrap/app.php'; $application->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap(); Illuminate\\Support\\Facades\\DB::table('categories')->insert(['id' => 9007199254740993, 'tenant_id' => 1, 'title' => 'Exact unsafe integer']);",
          ],
          { cwd: host, env: environment, encoding: 'utf8' },
        )
        assert.equal(inserted.status, 0, inserted.stdout + inserted.stderr)
        const remote = await transport.query(
          envelope(
            'query',
            {
              model: 'Category',
              where: {
                kind: 'comparison',
                field: 'id',
                operator: '=',
                value: identity,
              },
            },
            manifest!.fingerprint,
          ),
        )
        assert.equal(remote.records.length, 1)
        assert.equal(remote.records[0]!.id, identity)
        assert.equal(remote.records[0]!.attributes.id, identity)
        await client!.sync.resnapshot('catalog')
        assert.equal(
          (await client!.models.Category.findOrFail(identity)).id,
          identity,
        )
        assert.equal(
          (await client!.models.Category.where('id', identity).firstOrFail())
            .id,
          identity,
        )
        checks.push('unsafe-integer-exact-http-sqlite')
      },
    )
    await context.test(
      'real actor boundaries, snapshot corruption rollback and reactive delete',
      async () => {
        const unauthorized = transportFor(url, '2')
        await assert.rejects(
          unauthorized.query(
            envelope('query', { model: 'Item' }, manifest!.fingerprint),
          ),
          (failure: unknown) =>
            failure instanceof SynloquentError &&
            failure.code === 'forbidden_operation',
        )
        const snapshot = await transport.snapshot(
          envelope('snapshot', { dataset: 'catalog' }, manifest!.fingerprint),
        )
        assert.ok(snapshot.downloadUrl)
        const snapshotUrl = new URL(snapshot.downloadUrl, url)
        const snapshotHeaders = {
          Accept: 'application/json',
          Authorization: 'Bearer synthetic-actor-1',
          'X-Synloquent-Device': session.deviceId,
          'X-Synloquent-Device-Epoch': session.deviceEpoch,
        }
        const downloaded = await fetch(snapshotUrl, {
          headers: snapshotHeaders,
        })
        assert.equal(downloaded.status, 200)
        assert.deepEqual(await downloaded.json(), snapshot)
        assert.equal(
          (
            await fetch(snapshotUrl, {
              headers: {
                ...snapshotHeaders,
                'X-Synloquent-Device': 'other-device',
              },
            })
          ).status,
          403,
        )
        assert.equal(
          (
            await fetch(snapshotUrl, {
              headers: {
                ...snapshotHeaders,
                Authorization: 'Bearer synthetic-actor-2',
              },
            })
          ).status,
          403,
        )
        const before = (await client!.models.Item.get()).length
        await assert.rejects(
          client!.sync.installSnapshot({ ...snapshot, hash: '0'.repeat(64) }),
        )
        assert.equal((await client!.models.Item.get()).length, before)
        const subscription = client!.observe(client!.models.Item)
        await subscription.refresh()
        const target = await client!.models.Item.findOrFail(3)
        await target.delete()
        await client!.sync.resnapshot('catalog')
        assert.equal(
          await client!.models.Item.find(3),
          null,
          'Snapshot must retain a pending local delete overlay',
        )
        await client!.sync.flush()
        await client!.sync.pull('catalog')
        await subscription.refresh()
        assert.equal(await client!.models.Item.find(3), null)
        assert.equal(
          subscription
            .getSnapshot()
            .data.items.some((item) => String(item.id) === '3'),
          false,
        )
        subscription.dispose()
        assert.equal(client!.storage.owner.listenerCount, 0)
        checks.push('actor-corruption-reactive-delete')
        recordMethods(
          [
            'C55.download',
            'C55.snapshotRollback',
            'C55.pendingEditPreservation',
            'C51.querySubscription',
            'C51.committedSnapshot',
            'C51.cancelCleanup',
          ],
          'real actor boundaries, snapshot corruption rollback and reactive delete',
        )
      },
    )
    await context.test(
      'real HTTP partial results reject definitive aggregates and offline server execution',
      async () => {
        const partialClient = await createSynloquent<
          BackendModels,
          BackendCommands,
          BackendScopes
        >({
          ...configuration(),
          database: new NodeDatabase(join(temporary, 'partial.sqlite')),
        })
        try {
          assert.equal(
            (await partialClient.models.Item.get()).completeness,
            'partial',
          )
          await assert.rejects(
            partialClient.models.Item.count(),
            (failure: unknown) =>
              failure instanceof SynloquentError &&
              failure.code === 'incomplete_dataset',
          )
          const remoteRows = await partialClient.models.Item.remote()
            .limit(1)
            .get()
          assert.equal(remoteRows.length, 1)
          assert.equal(remoteRows.completeness, 'partial')
          await assert.rejects(
            partialClient.models.Item.remote().count(),
            (failure: unknown) =>
              failure instanceof SynloquentError &&
              failure.code === 'incomplete_dataset',
          )
          assert.ok(
            (await partialClient.models.Item.remote().allowPartial().count()) >=
              1,
          )
          await assert.rejects(
            partialClient.models.Item.scope('activePriced', {
              minimumPrice: '12.00',
            }).get(),
            (failure: unknown) =>
              failure instanceof SynloquentError &&
              failure.code === 'unsupported_query',
          )
          assert.ok(
            (
              await partialClient.scopes
                .activePriced({ minimumPrice: '12.00' })
                .get()
            ).length >= 1,
          )
          for (const mode of ['update', 'shared'] as const)
            assert.equal(
              (
                await partialClient.commands.inspectItemLocked(
                  { item_id: '1', mode },
                  randomUUID(),
                )
              ).lockMode,
              mode,
            )
          assert.throws(
            () => partialClient.models.Item.lockForUpdate(),
            (failure: unknown) =>
              failure instanceof SynloquentError &&
              failure.code === 'unsupported_query',
          )
          assert.throws(
            () => partialClient.models.Item.sharedLock(),
            (failure: unknown) =>
              failure instanceof SynloquentError &&
              failure.code === 'unsupported_query',
          )
          recordMethods(
            ['C16.partialCompletenessGuard', 'C52.partialDataset'],
            'real HTTP partial results reject definitive aggregates and offline server execution',
          )
          recordMethods(
            ['C46.unsupportedOfflineScope', 'C49.unsupportedLocalLock'],
            'real HTTP partial results reject definitive aggregates and offline server execution',
            ['remote'],
          )
        } finally {
          await partialClient.close()
        }
      },
    )
    await context.test(
      'compatible actual HTTP manifest backfills old bundled fields and retains offline proposal across restart',
      async () => {
        const currentItem = manifest!.models.Item!
        const oldFields = Object.fromEntries(
          Object.entries(currentItem.fields).filter(
            ([field]) => field !== 'display_label',
          ),
        )
        const oldManifest: Manifest = {
          ...manifest!,
          fingerprint: 'historical-compatible-bundle',
          models: {
            ...manifest!.models,
            Item: { ...currentItem, fields: oldFields },
          },
        }
        const oldFilename = join(temporary, 'old-bundle.sqlite')
        let evolvingClient = await createSynloquent<
          BackendModels,
          BackendCommands,
          BackendScopes
        >({
          ...configuration(),
          schema: oldManifest,
          database: new NodeDatabase(oldFilename),
        })
        try {
          const canonical = (
            await transport.query(
              envelope(
                'query',
                {
                  model: 'Item',
                  where: {
                    kind: 'comparison',
                    field: 'id',
                    operator: '=',
                    value: 1,
                  },
                },
                manifest!.fingerprint,
              ),
            )
          ).records[0]!
          const historicalCatalog = await transport.snapshot(
            envelope('snapshot', { dataset: 'catalog' }, manifest!.fingerprint),
          )
          await evolvingClient.storage.write((executor, changed) =>
            evolvingClient.storage.ingestSnapshotRecords(
              historicalCatalog.records.map((record) => ({
                ...record,
                attributes: Object.fromEntries(
                  Object.entries(record.attributes).filter(
                    ([field]) =>
                      field in oldManifest.models[record.model]!.fields,
                  ),
                ),
              })),
              executor,
              changed,
            ),
          )
          const oldModel = await evolvingClient.models.Item.findOrFail(1)
          assert.equal('display_label' in oldModel.attributes, false)
          await oldModel.update({
            title: 'Proposal retained through real HTTP schema backfill',
          })
          const operationId = oldModel.lastOperationId!
          const identity = oldModel.localIdentity
          assert.equal(
            await evolvingClient.sync.updateManifest('catalog'),
            true,
          )
          const backfilled =
            await evolvingClient.models.Item.findOrFail(identity)
          assert.equal(
            backfilled.title,
            'Proposal retained through real HTTP schema backfill',
          )
          assert.equal(
            backfilled.display_label,
            `${canonical.attributes.title} / ${canonical.attributes.status}`,
          )
          const displayLabel = backfilled.display_label
          assert.equal(await evolvingClient.sync.status(operationId), 'pending')
          assert.equal(
            evolvingClient.storage.manifest.fingerprint,
            manifest!.fingerprint,
          )
          assert.equal(
            await evolvingClient.sync.updateManifest('catalog'),
            false,
          )
          assert.throws(
            () => oldModel.attributes,
            (failure: unknown) =>
              failure instanceof SynloquentError &&
              failure.code === 'session_changed',
          )
          await evolvingClient.close()
          evolvingClient = await createSynloquent<
            BackendModels,
            BackendCommands,
            BackendScopes
          >({
            ...configuration(),
            schema: oldManifest,
            transport: undefined,
            database: new NodeDatabase(oldFilename),
          })
          assert.equal(
            evolvingClient.storage.manifest.fingerprint,
            manifest!.fingerprint,
          )
          assert.equal(
            (await evolvingClient.models.Item.findOrFail(identity))
              .display_label,
            displayLabel,
          )
          assert.equal(
            (await evolvingClient.models.Item.findOrFail(identity)).title,
            'Proposal retained through real HTTP schema backfill',
          )
          assert.equal(await evolvingClient.sync.status(operationId), 'pending')
          const unknownDatabase = new NodeDatabase(
            join(temporary, 'unknown-capability.sqlite'),
          )
          try {
            await assert.rejects(
              createSynloquent({
                ...configuration(),
                schema: {
                  ...manifest!,
                  capabilities: [
                    ...manifest!.capabilities,
                    'unregistered.executable.v9',
                  ],
                },
                database: unknownDatabase,
              }),
              (failure: unknown) =>
                failure instanceof SynloquentError &&
                failure.code === 'upgrade_required',
            )
          } finally {
            await unknownDatabase.close()
          }
          recordMethods(
            [
              'C54.offlineBoot',
              'C54.compatibleOnlineManifest',
              'C54.cachedManifest',
              'C54.unknownCapabilityGuard',
              'C55.schemaBackfill',
            ],
            'compatible actual HTTP manifest backfills old bundled fields and retains offline proposal across restart',
          )
        } finally {
          await evolvingClient.close()
        }
      },
    )
    await context.test(
      'real HTTP receipt rejection cancellation and delta conflict retry preserve canonical intent',
      async () => {
        const recoveryClient = await createSynloquent<
          BackendModels,
          BackendCommands,
          BackendScopes
        >({
          ...configuration(),
          database: new NodeDatabase(
            join(temporary, 'receipt-recovery.sqlite'),
          ),
        })
        try {
          await recoveryClient.sync.resnapshot('catalog')
          let item = await recoveryClient.models.Item.findOrFail(1)
          const canonicalTitle = item.title
          await item.update({ title: 'x'.repeat(256) })
          const rejectedOperationId = item.lastOperationId!
          await assert.rejects(
            recoveryClient.sync.confirmed(rejectedOperationId),
            (failure: unknown) =>
              failure instanceof SynloquentError &&
              failure.code === 'validation_failed' &&
              failure.details.operationId === rejectedOperationId &&
              failure.details.status === 'rejected',
          )
          item = await recoveryClient.models.Item.findOrFail(1)
          assert.equal(item.syncState, 'rejected')
          assert.equal(item.title, 'x'.repeat(256))
          assert.equal(item.canonicalRecord()?.attributes.title, canonicalTitle)
          assert.equal(
            (await recoveryClient.models.Item.remote().findOrFail(1)).title,
            canonicalTitle,
          )
          await recoveryClient.sync.resolveConflict(
            rejectedOperationId,
            'discard',
          )
          item = await recoveryClient.models.Item.findOrFail(1)
          await item.update({ title: 'Cancelled before transport' })
          const cancelOperationId = item.lastOperationId!
          await recoveryClient.sync.cancel(cancelOperationId)
          assert.equal(
            await recoveryClient.sync.status(cancelOperationId),
            'cancelled',
          )
          assert.equal(
            (await recoveryClient.models.Item.findOrFail(1)).title,
            canonicalTitle,
          )
          assert.equal(
            (await recoveryClient.models.Item.remote().findOrFail(1)).title,
            canonicalTitle,
          )
          item = await recoveryClient.models.Item.findOrFail(1)
          await item.increment('quantity', 1)
          const deltaOperationId = item.lastOperationId!
          const remoteCurrent = (
            await transport.query(
              envelope(
                'query',
                {
                  model: 'Item',
                  where: {
                    kind: 'comparison',
                    field: 'id',
                    operator: '=',
                    value: 1,
                  },
                },
                manifest!.fingerprint,
              ),
            )
          ).records[0]!
          const serverQuantity = Number(remoteCurrent.attributes.quantity) + 5
          const accepted = await transport.push(
            envelope(
              'push',
              {
                operations: [
                  {
                    operationId: randomUUID(),
                    model: 'Item',
                    localIdentity: 'independent-delta-writer',
                    id: '1',
                    action: 'update',
                    values: { quantity: serverQuantity },
                    expectedRevision: remoteCurrent.revision,
                    dependsOn: [],
                  },
                ],
              },
              manifest!.fingerprint,
            ),
          )
          assert.equal(accepted.receipts[0]?.status, 'accepted')
          await recoveryClient.sync.flush()
          assert.equal(
            await recoveryClient.sync.status(deltaOperationId),
            'conflicted',
          )
          assert.equal(
            (await recoveryClient.models.Item.findOrFail(1)).quantity,
            serverQuantity + 1,
          )
          await recoveryClient.sync.resolveConflict(deltaOperationId, 'retry')
          await recoveryClient.sync.flush()
          item = await recoveryClient.models.Item.findOrFail(1)
          assert.equal(item.quantity, serverQuantity + 1)
          assert.equal(item.syncState, 'synced')
          assert.equal(
            (await recoveryClient.models.Item.remote().findOrFail(1)).quantity,
            serverQuantity + 1,
          )
          recordMethods(
            [
              'C25.atomicDeltaConflict',
              'C53.rejected',
              'C57.cancelUnattempted',
              'C57.retryConflict',
            ],
            'real HTTP receipt rejection cancellation and delta conflict retry preserve canonical intent',
          )
        } finally {
          await recoveryClient.close()
        }
      },
    )
    await context.test(
      'real HTTP model subscriptions replace committed membership and dispose on logout',
      async () => {
        const reactiveClient = await createSynloquent<
          BackendModels,
          BackendCommands,
          BackendScopes
        >({
          ...configuration(),
          database: new NodeDatabase(
            join(temporary, 'model-subscription.sqlite'),
          ),
        })
        const subscription = reactiveClient.observe(
          reactiveClient.models.Item.where('id', 1),
        )
        let notifications = 0
        const unsubscribe = subscription.subscribe(() => {
          notifications += 1
        })
        try {
          await reactiveClient.sync.resnapshot('catalog')
          await subscription.refresh()
          const oldSnapshot = subscription.getSnapshot()
          assert.equal(oldSnapshot.data.length, 1)
          const oldInstance = oldSnapshot.data.first()!
          const canonical = (
            await transport.query(
              envelope(
                'query',
                {
                  model: 'Item',
                  where: {
                    kind: 'comparison',
                    field: 'id',
                    operator: '=',
                    value: 1,
                  },
                },
                manifest!.fingerprint,
              ),
            )
          ).records[0]!
          const title = `Committed subscribed title ${randomUUID()}`
          const response = await transport.push(
            envelope(
              'push',
              {
                operations: [
                  {
                    operationId: randomUUID(),
                    model: 'Item',
                    localIdentity: 'subscription-writer',
                    id: '1',
                    action: 'update',
                    values: { title },
                    expectedRevision: canonical.revision,
                    dependsOn: [],
                  },
                ],
              },
              manifest!.fingerprint,
            ),
          )
          assert.equal(response.receipts[0]?.status, 'accepted')
          await reactiveClient.sync.pull('catalog')
          await subscription.refresh()
          assert.equal(subscription.getSnapshot().data.first()?.title, title)
          assert.notEqual(subscription.getSnapshot(), oldSnapshot)
          assert.throws(
            () => oldInstance.attributes,
            (failure: unknown) =>
              failure instanceof SynloquentError &&
              failure.code === 'session_changed',
          )
          await reactiveClient.sync.resnapshot('catalog')
          await subscription.refresh()
          assert.equal(subscription.getSnapshot().data.first()?.title, title)
          await reactiveClient.setSession({
            ...session,
            accountId: '2',
            tenantId: '2',
          })
          await subscription.refresh()
          assert.equal(subscription.getSnapshot().data.length, 0)
          assert.equal(subscription.getSnapshot().data.completeness, 'partial')
          assert.ok(notifications > 0)
          unsubscribe()
          subscription.dispose()
          assert.equal(reactiveClient.storage.owner.listenerCount, 0)
          recordMethods(
            [
              'C51.modelSubscription',
              'C51.replacementCleanup',
              'C51.logoutCleanup',
              'C52.subscriptionMembership',
            ],
            'real HTTP model subscriptions replace committed membership and dispose on logout',
          )
        } finally {
          unsubscribe()
          subscription.dispose()
          await reactiveClient.close()
        }
      },
    )
    await context.test(
      'actual HTTP late replies cannot cross account device epoch or session generations',
      async () => {
        let releaseReply!: () => void
        let replyArrived!: () => void
        const replyBarrier = new Promise<void>((resolveReply) => {
          releaseReply = resolveReply
        })
        const arrivalBarrier = new Promise<void>((resolveArrival) => {
          replyArrived = resolveArrival
        })
        const delayedTransport: Transport = {
          ...transport,
          query: async (requestEnvelope) => {
            const response = await transport.query(requestEnvelope)
            replyArrived()
            await replyBarrier
            return response
          },
        }
        const partitionClient = await createSynloquent<
          BackendModels,
          BackendCommands,
          BackendScopes
        >({
          ...configuration(),
          transport: delayedTransport,
          database: new NodeDatabase(
            join(temporary, 'partition-generations.sqlite'),
          ),
        })
        try {
          await partitionClient.sync.resnapshot('catalog')
          const original = await partitionClient.models.Item.findOrFail(1)
          const local = await partitionClient.models.Category.create({
            title: `Partition pending ${randomUUID()}`,
          })
          const localTitle = local.title
          const originalIdentity = local.localIdentity
          const originalOperationId = local.lastOperationId!
          const delayed = partitionClient.models.Item.remote().get()
          const delayedRejection = assert.rejects(
            delayed,
            (failure: unknown) =>
              failure instanceof SynloquentError &&
              failure.code === 'session_changed',
          )
          await arrivalBarrier
          await partitionClient.setSession({
            ...session,
            accountId: '2',
            tenantId: '2',
          })
          releaseReply()
          await delayedRejection
          assert.equal((await partitionClient.models.Item.get()).length, 0)
          assert.throws(
            () => original.attributes,
            (failure: unknown) =>
              failure instanceof SynloquentError &&
              failure.code === 'session_changed',
          )
          const nextDevice = { ...session, deviceId: 'integration-device-2' }
          await partitionClient.setSession(nextDevice)
          assert.equal(
            await partitionClient.models.Category.find(originalIdentity),
            null,
          )
          await partitionClient.sync.resnapshot('catalog')
          assert.ok(await partitionClient.models.Item.find(1))
          assert.equal(
            await partitionClient.models.Category.find(originalIdentity),
            null,
          )
          await partitionClient.setSession({
            ...nextDevice,
            deviceEpoch: 'integration-epoch-2',
          })
          assert.equal((await partitionClient.models.Item.get()).length, 0)
          await partitionClient.sync.resnapshot('catalog')
          assert.ok(await partitionClient.models.Item.find(1))
          assert.equal(
            await partitionClient.sync.status(originalOperationId),
            'unknown',
          )
          await partitionClient.setSession(session)
          assert.equal(
            (await partitionClient.models.Category.findOrFail(originalIdentity))
              .title,
            localTitle,
          )
          assert.equal(
            await partitionClient.sync.status(originalOperationId),
            'pending',
          )
          recordMethods(
            [
              'C56.accountPartition',
              'C56.devicePartition',
              'C56.epochSeparation',
              'C56.sessionGeneration',
              'C56.lateResponse',
            ],
            'actual HTTP late replies cannot cross account device epoch or session generations',
          )
        } finally {
          releaseReply()
          await partitionClient.close()
        }
      },
    )
    await context.test(
      'pending dependent edits survive a real HTTP snapshot before captured cascade deletion',
      async () => {
        const deletionClient = await createSynloquent<
          BackendModels,
          BackendCommands,
          BackendScopes
        >({
          ...configuration(),
          database: new NodeDatabase(
            join(temporary, 'pending-dependent-delete.sqlite'),
          ),
        })
        try {
          await deletionClient.sync.resnapshot('catalog')
          const parent = await deletionClient.models.Item.create({
            title: `Pending dependency parent ${randomUUID()}`,
            category_id: null,
            price: '1.00',
            active: true,
            quantity: 1,
          })
          const child = await deletionClient.models.Image.create({
            item_id: parent.id,
            url: 'accepted-dependent.jpg',
          })
          const parentIdentity = parent.localIdentity
          const childIdentity = child.localIdentity
          await deletionClient.sync.flush()
          await parent.refresh()
          await child.refresh()
          const serverParentIdentity = parent.id
          const serverChildIdentity = child.id
          assert.match(String(serverParentIdentity), /^\d+$/)
          assert.equal(String(child.item_id), String(serverParentIdentity))
          assert.equal(parent.category_id, null)
          assert.equal(
            (
              await deletionClient.models.Item.remote().findOrFail(
                serverParentIdentity,
              )
            ).category_id,
            null,
          )
          await child.update({ url: 'retained-dependent-proposal.jpg' })
          const childOperationId = child.lastOperationId!
          await parent.delete()
          const deletionOperationId = parent.lastOperationId!
          assert.equal(
            await deletionClient.models.Item.find(parentIdentity),
            null,
          )
          assert.equal(
            await deletionClient.models.Image.find(childIdentity),
            null,
          )
          await deletionClient.sync.resnapshot('catalog')
          assert.equal(
            await deletionClient.models.Item.find(parentIdentity),
            null,
          )
          assert.equal(
            await deletionClient.models.Image.find(childIdentity),
            null,
          )
          assert.equal(
            await deletionClient.sync.status(childOperationId),
            'pending',
          )
          const retained = await deletionClient.storage.read((executor) =>
            deletionClient.storage.findStored('Image', childIdentity, executor),
          )
          assert.equal(
            retained?.proposal.url,
            'retained-dependent-proposal.jpg',
          )
          assert.equal(retained?.canonical.url, 'accepted-dependent.jpg')
          await deletionClient.sync.flush()
          assert.equal(
            await deletionClient.sync.status(childOperationId),
            'accepted',
          )
          assert.equal(
            await deletionClient.sync.status(deletionOperationId),
            'accepted',
          )
          await deletionClient.sync.pull('catalog')
          assert.equal(
            await deletionClient.models.Item.remote().find(
              serverParentIdentity,
            ),
            null,
          )
          assert.equal(
            await deletionClient.models.Image.remote().find(
              serverChildIdentity,
            ),
            null,
          )
          assert.equal(
            (
              await deletionClient.storage.read((executor) =>
                executor.execute('PRAGMA foreign_key_check'),
              )
            ).rows.length,
            0,
          )
          recordMethods(
            ['C58.pendingDependencyDelete'],
            'pending dependent edits survive a real HTTP snapshot before captured cascade deletion',
          )
        } finally {
          await deletionClient.close()
        }
      },
    )
    await context.test(
      'actual HTTP commands preserve safe numeric exact string and unsafe integer arguments',
      async () => {
        const identity = '9007199254740993'
        const inserted = spawnSync(
          join(process.env.SYNLOQUENT_POSTGRES_BIN ?? '', 'psql'),
          [
            ...databaseArguments,
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            "INSERT INTO items (id, tenant_id, title, price, active, quantity, category_id) VALUES (9007199254740993, 1, 'Unsafe command target', 1.00, true, 1, NULL)",
          ],
          { encoding: 'utf8' },
        )
        assert.equal(inserted.status, 0, inserted.stdout + inserted.stderr)
        const before = (
          await transport.query(
            envelope(
              'query',
              {
                model: 'Item',
                where: {
                  kind: 'comparison',
                  field: 'id',
                  operator: '=',
                  value: identity,
                },
              },
              manifest!.fingerprint,
            ),
          )
        ).records[0]!
        assert.equal(before.attributes.id, identity)
        assert.equal(before.attributes.category_id, null)
        assert.deepEqual(
          await client!.commands.increaseQuantity(
            { item_id: identity, delta: '1' },
            randomUUID(),
          ),
          { quantity: 2 },
        )
        assert.deepEqual(
          await client!.commands.increaseQuantity(
            { item_id: identity, delta: 1 },
            randomUUID(),
          ),
          { quantity: 3 },
        )
        await assert.rejects(
          transport.command(
            envelope(
              'command',
              {
                name: 'increaseQuantity',
                operationId: randomUUID(),
                arguments: { item_id: '09007199254740993', delta: 1 },
              },
              manifest!.fingerprint,
            ),
          ),
          (failure: unknown) =>
            failure instanceof SynloquentError &&
            failure.code === 'validation_failed',
        )
        const after = (
          await transport.query(
            envelope(
              'query',
              {
                model: 'Item',
                where: {
                  kind: 'comparison',
                  field: 'id',
                  operator: '=',
                  value: identity,
                },
              },
              manifest!.fingerprint,
            ),
          )
        ).records[0]!
        assert.equal(after.attributes.quantity, 3)
        assert.equal(after.attributes.id, identity)
      },
    )
    await context.test(
      'grouped actual HTTP and SQLite aggregates preserve unsafe integer sum average and HAVING',
      async () => {
        const identities = ['9007199254740993', '9007199254740994']
        const inserted = spawnSync(
          join(process.env.SYNLOQUENT_POSTGRES_BIN ?? '', 'psql'),
          [
            ...databaseArguments,
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            "INSERT INTO categories (id, tenant_id, title) VALUES (9007199254740994, 1, 'Second exact grouped integer')",
          ],
          { encoding: 'utf8' },
        )
        assert.equal(inserted.status, 0, inserted.stdout + inserted.stderr)
        await client!.sync.resnapshot('catalog')
        for (const target of ['local', 'remote'] as const) {
          const query =
            target === 'local'
              ? client!.models.Category
              : client!.models.Category.remote().allowPartial()
          const grouped = query.whereIn('id', identities).groupBy('created_at')
          const sum = await grouped.aggregateGroups('sum', 'id')
          assert.deepEqual(sum.groups, [
            { keys: { created_at: null }, value: '18014398509481987' },
          ])
          assert.deepEqual(
            (await grouped.aggregateGroups('avg', 'id')).groups,
            [{ keys: { created_at: null }, value: '9007199254740993.5' }],
          )
          assert.deepEqual(
            (
              await grouped
                .having('$aggregate', '>', '18014398509481986')
                .aggregateGroups('sum', 'id')
            ).groups,
            sum.groups,
          )
          assert.equal(
            (
              await grouped
                .having('$aggregate', '>', '18014398509481987')
                .aggregateGroups('sum', 'id')
            ).groups?.length,
            0,
          )
          recordMethods(
            ['C17.groupBy', 'C17.having'],
            'grouped actual HTTP and SQLite aggregates preserve unsafe integer sum average and HAVING',
            [target],
          )
        }
      },
    )
    await context.test(
      'actual HTTP retention expiry installs a new snapshot and preserves unattempted work',
      async () => {
        let resnapshots = 0
        let expiredReplies = 0
        const retentionTransport: Transport = {
          ...transport,
          snapshot: async (requestEnvelope) => {
            resnapshots += 1
            return transport.snapshot(requestEnvelope)
          },
          pull: async (requestEnvelope) => {
            try {
              return await transport.pull(requestEnvelope)
            } catch (failure) {
              if (
                failure instanceof SynloquentError &&
                failure.code === 'cursor_expired'
              )
                expiredReplies += 1
              throw failure
            }
          },
        }
        const retentionClient = await createSynloquent<
          BackendModels,
          BackendCommands,
          BackendScopes
        >({
          ...configuration(),
          transport: retentionTransport,
          database: new NodeDatabase(
            join(temporary, 'retention-recovery.sqlite'),
          ),
        })
        try {
          await retentionClient.sync.resnapshot('catalog')
          const oldCursor =
            await retentionClient.storage.metadata('cursor:catalog')
          const pending = await retentionClient.models.Category.create({
            title: `Retained after journal expiry ${randomUUID()}`,
          })
          const pendingIdentity = pending.localIdentity
          const pendingTitle = pending.title
          const pendingOperationId = pending.lastOperationId!
          const canonical = (
            await transport.query(
              envelope(
                'query',
                {
                  model: 'Item',
                  where: {
                    kind: 'comparison',
                    field: 'id',
                    operator: '=',
                    value: 1,
                  },
                },
                manifest!.fingerprint,
              ),
            )
          ).records[0]!
          const title = `Accepted after old cursor ${randomUUID()}`
          const response = await transport.push(
            envelope(
              'push',
              {
                operations: [
                  {
                    operationId: randomUUID(),
                    model: 'Item',
                    localIdentity: 'retention-writer',
                    id: '1',
                    action: 'update',
                    values: { title },
                    expectedRevision: canonical.revision,
                    dependsOn: [],
                  },
                ],
              },
              manifest!.fingerprint,
            ),
          )
          assert.equal(response.receipts[0]?.status, 'accepted')
          const retained = spawnSync(
            join(process.env.SYNLOQUENT_POSTGRES_BIN ?? '', 'psql'),
            [
              ...databaseArguments,
              '-v',
              'ON_ERROR_STOP=1',
              '-c',
              'UPDATE synloquent_streams SET retention_floor = sequence',
            ],
            { encoding: 'utf8' },
          )
          assert.equal(retained.status, 0, retained.stdout + retained.stderr)
          await retentionClient.sync.pull('catalog')
          assert.equal(expiredReplies, 1)
          assert.equal(resnapshots, 2)
          assert.notEqual(
            await retentionClient.storage.metadata('cursor:catalog'),
            oldCursor,
          )
          assert.equal(
            (await retentionClient.models.Item.findOrFail(1)).title,
            title,
          )
          assert.equal(
            (await retentionClient.models.Category.findOrFail(pendingIdentity))
              .title,
            pendingTitle,
          )
          assert.equal(
            await retentionClient.sync.status(pendingOperationId),
            'pending',
          )
          recordMethods(
            ['C55.retentionResnapshot'],
            'actual HTTP retention expiry installs a new snapshot and preserves unattempted work',
          )
        } finally {
          await retentionClient.close()
        }
      },
    )
    writeFileSync(
      join(artifacts, 'result.json'),
      JSON.stringify(
        {
          checks,
          backend: 'PostgreSQL18.3',
          transport: 'real Laravel HTTP',
          localDatabase: 'real SQLite',
          serverProcess: httpServer.pid,
        },
        null,
        2,
      ) + '\n',
    )
    writeFileSync(
      join(artifacts, 'capability-map.json'),
      JSON.stringify({ witnesses: methodWitnesses }, null, 2) + '\n',
    )
  } finally {
    await client?.close()
    if (httpServer?.pid && httpServer.exitCode === null) {
      const exited = new Promise<void>((resolveExit) =>
        httpServer!.once('exit', () => resolveExit()),
      )
      process.kill(-httpServer.pid, 'SIGTERM')
      await Promise.race([
        exited,
        delay(5000).then(() => {
          if (httpServer!.exitCode === null)
            process.kill(-httpServer!.pid!, 'SIGKILL')
        }),
      ])
    }
    writeFileSync(join(artifacts, 'laravel.log'), serverOutput)
    rmSync(temporary, { recursive: true, force: true })
    const dropped = spawnSync(
      join(process.env.SYNLOQUENT_POSTGRES_BIN ?? '', 'dropdb'),
      databaseArguments,
      { encoding: 'utf8' },
    )
    assert.equal(dropped.status, 0, dropped.stderr)
  }
})
