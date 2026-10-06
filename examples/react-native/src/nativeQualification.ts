import {
  createSynloquent,
  type Query,
  type QuerySnapshot,
  type Attributes,
  type QueryMode,
  type CanonicalRecord,
  type ClientConfiguration,
  type Manifest,
  type Snapshot,
  type SynloquentClient,
} from '@synloquent/client'
import { createDatabaseAdapter } from '@synloquent/client/sqlite'
import {
  createReactNativeClient,
  createNativeMemoryBudget,
} from '@synloquent/client/react-native'
import { open } from '@op-engineering/op-sqlite'
import { Platform } from 'react-native'
import {
  backendSchema,
  type BackendModels,
  type BackendCommands,
  type BackendScopes,
} from '../backend.generated'
import { createExampleTransport, nativeHttpFailure } from './httpTransport'
import { verifyNativeCryptography } from './nativeCrypto'
import { verifyNativeMemoryBudget } from './nativeMemory'
import {
  canonicalJson,
  digest,
  digestChunks,
  createNativeSqlObserver,
  encodeUtf8,
  generateIdentity,
  schedule,
  nativeClock,
  createMeasuredCryptoProvider,
} from './platform'
import {
  runDriverSpike,
  type NativeCheck,
  type NativeSpikeResult,
} from '../../../packages/client/tests/native/driver-spike'

export type ExampleClient = SynloquentClient<
  BackendModels,
  BackendCommands,
  BackendScopes
>
export interface QueryMount {
  snapshot(): QuerySnapshot<
    Attributes,
    Attributes,
    string,
    undefined,
    QueryMode
  >
  observedQueryKey(): string | undefined
  unmount(): Promise<void>
}
export type MountQuery = (
  client: ExampleClient,
  query: Query<Attributes, Attributes, string, undefined, QueryMode>,
) => Promise<QueryMount>

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const started = nativeClock.now()
  while (nativeClock.now() - started < 10000) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

export const exampleSession = {
  accountId: '1',
  tenantId: '1',
  deviceId: 'example-device',
  deviceEpoch: 'epoch-1',
  generation: 0,
} as const

export async function makeExampleClient(
  name: string,
  address: string,
  schema: Manifest = backendSchema,
  diagnostics?: Partial<
    Pick<
      ClientConfiguration,
      | 'observeSnapshotPhase'
      | 'now'
      | 'generateIdentity'
      | 'digest'
      | 'digestChunks'
      | 'memoryBudget'
      | 'refreshMemoryBudget'
      | 'transport'
    >
  >,
): Promise<ExampleClient> {
  let client: ExampleClient | undefined
  let database: ReturnType<typeof createDatabaseAdapter> | undefined
  const memory = diagnostics?.memoryBudget
    ? undefined
    : createNativeMemoryBudget({
        nowMilliseconds: () => nativeClock.now(),
        onCacheBudgetReduced: () =>
          client?.storage.memoryCache.reduceToCurrentBudget(),
      })
  const memoryBudget = diagnostics?.memoryBudget ?? memory!.policy
  const crypto = createMeasuredCryptoProvider(
    () => memoryBudget.current().maximumHashBufferUnits,
  )
  const transport = createExampleTransport({ address, digest: crypto.digest })
  const sqlObserver = createNativeSqlObserver(name)
  try {
    database = createDatabaseAdapter({
      name,
      observeNativeWork: sqlObserver.observeNativeWork,
    })
    client = await createSynloquent<
      BackendModels,
      BackendCommands,
      BackendScopes
    >({
      schema,
      database,
      session: exampleSession,
      transport,
      generateIdentity,
      now: () => new Date().toISOString(),
      digest: crypto.digest,
      digestChunks: crypto.digestChunks,
      memoryBudget,
      ...(memory ? { refreshMemoryBudget: memory.refresh } : {}),
      schedule,
      ...diagnostics,
      observeSnapshotPhase(event) {
        sqlObserver.observeSnapshotPhase(event)
        diagnostics?.observeSnapshotPhase?.call(this, event)
      },
    })
    sqlObserver.bindClient(client)
    const originalSetSession = client.sync.setSession.bind(client.sync)
    const originalClose = client.close.bind(client)
    client.sync.setSession = async (session) => {
      memory?.reset()
      transport.suspend()
      await originalSetSession(session)
    }
    let closing: Promise<void> | undefined
    client.close = () => {
      if (closing) return closing
      memory?.close()
      closing = Promise.allSettled([
        transport.close(),
        crypto.close(),
        originalClose(),
      ]).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        )
        if (failures.length)
          throw new AggregateError(failures, 'Example client cleanup failed.')
      })
      return closing
    }
    return client
  } catch (failure) {
    memory?.close()
    await Promise.allSettled([
      transport.close(),
      crypto.close(),
      client ? client.close() : database?.close(),
    ])
    throw failure
  }
}

export async function makeSnapshot(
  records: readonly CanonicalRecord[],
  schema: Manifest = backendSchema,
): Promise<Snapshot> {
  const content = canonicalJson({ records, relationSets: [] })
  return {
    records,
    relationSets: [],
    schemaFingerprint: schema.fingerprint,
    dataset: 'catalog',
    generation: generateIdentity(),
    cursor: 'native-fixture-cursor',
    hash: await digest(content),
    byteSize: encodeUtf8(content).length,
    scope: {
      dataset: 'catalog',
      authorizationGeneration: 'native-fixture-authorization',
      projectionGeneration: 'native-fixture-projection',
      schemaFingerprint: schema.fingerprint,
      completeness: 'complete',
    },
  }
}

export function deleteDatabase(name: string): void {
  const connection = open({ name })
  connection.delete()
}

async function verifyClientDigestLifecycle(address: string) {
  const measurements = []
  for (const mode of ['close', 'account-switch'] as const) {
    const name = `synloquent_digest_${generateIdentity()}.sqlite`
    let client: ExampleClient | undefined
    let reopened: ExampleClient | undefined
    let intercept = false
    let returned = false
    let startedRead: () => void = () => undefined
    const readStarted = new Promise<void>((resolve) => {
      startedRead = resolve
    })
    let deliverLate: (value: IteratorResult<string>) => void = () => undefined
    const pendingRead = new Promise<IteratorResult<string>>((resolve) => {
      deliverLate = resolve
    })
    try {
      client = await makeExampleClient(name, address, backendSchema, {
        digestChunks(source, lifecycle) {
          if (!intercept) return digestChunks(source, lifecycle)
          const original = source[Symbol.asyncIterator]()
          const stuck: AsyncIterable<string> = {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  startedRead()
                  return pendingRead
                },
                return() {
                  returned = true
                  const closing = original.return?.()
                  if (closing)
                    void Promise.resolve(closing).catch(() => undefined)
                  return new Promise<IteratorResult<string>>(() => undefined)
                },
              }
            },
          }
          return digestChunks(stuck, lifecycle)
        },
      })
      const initial = await makeSnapshot([
        {
          model: 'Item',
          id: '1',
          revision: '1',
          attributes: { id: 1, title: 'Initial digest generation' },
        },
      ])
      await client.sync.installSnapshot(initial)
      const replacement = await makeSnapshot([
        {
          model: 'Item',
          id: '2',
          revision: '1',
          attributes: { id: 2, title: 'Cancelled late digest generation' },
        },
      ])
      intercept = true
      const installing = client.sync.installSnapshot(replacement).then(
        () => false,
        () => true,
      )
      await readStarted
      const started = nativeClock.now()
      if (mode === 'close') await client.close()
      else
        await client.setSession({
          ...exampleSession,
          accountId: '2',
          generation: 1,
        })
      const elapsedMilliseconds = nativeClock.now() - started
      assert(
        await installing,
        'Client lifecycle must reject a pending digest before its late snapshot can activate.',
      )
      assert(
        returned && elapsedMilliseconds < 1000,
        'Client lifecycle must reclaim native context without awaiting a stuck producer.',
      )
      deliverLate({ done: false, value: 'Late native digest producer result' })
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      if (mode === 'close') {
        reopened = await makeExampleClient(name, address)
        assert(
          (await reopened.storage.metadata('snapshotGeneration')) ===
            initial.generation &&
            (await reopened.models.Item.find('2')) === null,
          'Reopen must retain the previous committed generation after digest cancellation.',
        )
      } else {
        assert(
          (await client.models.Item.allowPartial().count()) === 0 &&
            (await client.storage.metadata('snapshotGeneration')) === null,
          'Account replacement must remain isolated after a late cancelled digest result.',
        )
      }
      measurements.push({
        mode,
        elapsedMilliseconds,
        producerReturnRequested: returned,
        lateSnapshotRejected: true,
      })
    } finally {
      await client?.close()
      await reopened?.close()
      deleteDatabase(name)
    }
  }
  return measurements
}

export async function runNativeQualification(
  address: string,
  mountQuery: MountQuery,
  progress: (message: string) => void,
): Promise<NativeSpikeResult> {
  const startedAt = new Date().toISOString()
  const checks: NativeCheck[] = []
  const databaseName = `synloquent_qualification_${generateIdentity()}.sqlite`
  const schemaDatabaseName = `synloquent_schema_${generateIdentity()}.sqlite`
  const clients = new Set<ExampleClient>()
  const mountedQueries = new Set<QueryMount>()
  let client: ExampleClient | undefined
  const titlePrefix = `Native ${Platform.OS} ${generateIdentity()}`
  async function check(
    name: string,
    callback: () => Promise<unknown>,
  ): Promise<void> {
    progress(name)
    const started = nativeClock.now()
    checks.push({ name, durationMilliseconds: 0, detail: await callback() })
    const latest = checks[checks.length - 1]!
    checks[checks.length - 1] = {
      ...latest,
      durationMilliseconds: nativeClock.now() - started,
    }
  }
  try {
    assert(
      (globalThis as typeof globalThis & { HermesInternal?: unknown })
        .HermesInternal,
      'Qualification requires a real Hermes runtime.',
    )
    const spike = await runDriverSpike(progress)
    checks.push(...spike.checks)
    assert(
      spike.status === 'passed',
      spike.error ?? 'The native driver spike failed.',
    )
    await check('system native SHA256 streaming lifecycle', async () => ({
      ...(await verifyNativeCryptography()),
      currentMemory: await verifyNativeMemoryBudget(),
    }))
    await check('native-public-composition', async () => {
      const name = `synloquent_public_${generateIdentity()}.sqlite`
      let runtime:
        | Awaited<
            ReturnType<
              typeof createReactNativeClient<
                BackendModels,
                BackendCommands,
                BackendScopes
              >
            >
          >
        | undefined
      try {
        runtime = await createReactNativeClient<
          BackendModels,
          BackendCommands,
          BackendScopes
        >({
          schema: backendSchema,
          database: { name },
          session: exampleSession,
          generateIdentity,
          http: {
            endpoint: `${address}/synloquent/v1/protocol`,
            authenticate: (identity) => ({
              session: identity.session,
              headers: {
                Authorization: `Bearer synthetic-actor-${identity.session.accountId}`,
              },
            }),
          },
        })
        const item = await runtime.client.models.Item.create({
          title: `${titlePrefix} public composition`,
          price: '3.14',
          quantity: 2,
        })
        const createOperationId = item.lastOperationId
        assert(
          createOperationId,
          'Public composition must expose durable create operation identity.',
        )
        item.fill({ quantity: 3 })
        await item.save()
        const editOperationId = item.lastOperationId
        assert(
          editOperationId,
          'Public composition must expose durable edit operation identity.',
        )
        const localIdentity = item.localIdentity
        assert(
          (await runtime.client.models.Item.findOrFail(localIdentity))
            .attributes.quantity === 3,
          'Public composition must support ordinary offline CRUD.',
        )
        await runtime.client.sync.flush()
        const accepted =
          await runtime.client.models.Item.findOrFail(localIdentity)
        const canonicalIdentity = accepted.canonicalRecord()?.id
        assert(
          canonicalIdentity &&
            accepted.syncState === 'synced' &&
            accepted.attributes.quantity === 3,
          'Actual HTTP receipts must confirm public composition writes.',
        )
        assert(
          (await runtime.client.models.Item.findOrFail(canonicalIdentity))
            .localIdentity === localIdentity,
          'Actual HTTP alias must resolve to the stable offline identity.',
        )
        const active = runtime.client
        const receipts = await active.storage.read((executor) =>
          active.storage.pending(executor),
        )
        for (const operationId of [createOperationId, editOperationId])
          assert(
            receipts.some(
              (entry) =>
                entry.operation.operationId === operationId &&
                entry.status === 'accepted',
            ),
            'Public composition receipt must remain durable.',
          )
        await runtime.setSession({
          ...exampleSession,
          accountId: '2',
          tenantId: '2',
        })
        assert(
          (await runtime.client.models.Item.find(localIdentity)) === null,
          'Public composition session switch must isolate the previous account and tenant.',
        )
        await runtime.setSession(exampleSession)
        assert(
          (await runtime.client.models.Item.findOrFail(canonicalIdentity))
            .localIdentity === localIdentity,
          'Public composition must restore the original durable alias after switching back.',
        )
        const closing = runtime.close()
        assert(
          closing === runtime.close() && closing === runtime.client.close(),
          'Public composition close must be idempotent through both public handles.',
        )
        await closing
        return {
          actualHttp: true,
          ordinaryOfflineCrud: true,
          canonicalIdentity,
          localIdentity,
          receiptOperationIds: [createOperationId, editOperationId],
          sessionIsolation: true,
          idempotentClose: true,
        }
      } finally {
        try {
          await runtime?.close()
        } finally {
          deleteDatabase(name)
        }
      }
    })
    await check(
      'native secure identities and UTF8 snapshot hashing',
      async () => {
        const content = 'Žluťoučký 🧭'
        const expected =
          'a17a209398270f3520aa7254cdc26406e26d8464d47e3a741caf4a34d2d221d5'
        async function* splitSurrogate(): AsyncIterable<string> {
          yield 'Žluťoučký \ud83e'
          yield '\udded'
        }
        const actualDigest = await digest(content)
        let actualSplitSurrogateDigest: string | undefined
        assert(
          actualDigest === expected &&
            (actualSplitSurrogateDigest =
              await digestChunks(splitSurrogate())) === expected,
          'UTF8 and incremental hashing must match the independently calculated SHA256 witness, including a split surrogate pair.',
        )
        const identities = Array.from({ length: 100 }, generateIdentity)
        assert(
          new Set(identities).size === 100 &&
            identities.every((identity) =>
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                identity,
              ),
            ),
          'Native secure random identities must be correctly formed unique UUIDv4 values.',
        )
        return {
          knownHash: expected,
          splitSurrogate: true,
          uniqueIdentities: identities.length,
          actualDigest,
          actualSplitSurrogateDigest,
          identities,
        }
      },
    )
    await check(
      'client close and account switch cancel stuck native digest',
      () => verifyClientDigestLifecycle(address),
    )
    client = await makeExampleClient(databaseName, address)
    clients.add(client)
    const current = client
    let parentIdentity = ''
    let imageIdentity = ''
    await check(
      'synloquent offline parent-child and identity aliases',
      async () => {
        const parent = await current.models.Item.create({
          title: `${titlePrefix} parent`,
          price: '1.20',
        })
        const image = await parent
          .relation('images')
          .create({ url: `${titlePrefix}.jpg` })
        parentIdentity = parent.localIdentity
        imageIdentity = image.localIdentity
        assert(
          image.attributes.item_id === parentIdentity,
          'The offline child must reference the stable local parent identity.',
        )
        const loaded =
          await current.models.Item.with('images').findOrFail(parentIdentity)
        assert(
          loaded.relation('images').current?.length === 1,
          'Native relation hydration must load the offline child.',
        )
        parent.fill({ title: `${titlePrefix} updated` })
        await parent.save()
        const queue = await current.storage.read((executor) =>
          current.storage.pending(executor),
        )
        assert(
          queue.length === 3 &&
            queue.every((entry) => entry.status === 'pending'),
          'Offline changes and their outbox must persist together.',
        )
        await current.close()
        clients.delete(current)
        client = await makeExampleClient(databaseName, address)
        clients.add(client)
        assert(
          (await client.models.Item.findOrFail(parentIdentity)).attributes
            .title === `${titlePrefix} updated`,
          'Reopen must preserve pending edits.',
        )
        return {
          parentIdentity,
          imageIdentity,
          persistedOperations: queue.length,
        }
      },
    )
    const active = client!
    await check('synloquent nested transaction and scoped handle', async () => {
      const baseline = await active.models.Item.allowPartial().count()
      let published = 0
      const unsubscribe = active.storage.owner.subscribe(() => {
        published += 1
      })
      try {
        let rejected = false
        try {
          await active.transaction(async (transaction) => {
            await transaction.models.Item.create({
              title: `${titlePrefix} rollback`,
            })
            throw new Error('outer rollback')
          })
        } catch {
          rejected = true
        }
        assert(
          rejected &&
            (await active.models.Item.allowPartial().count()) === baseline &&
            published === 0,
          'Rollback must preserve data, outbox and committed notifications.',
        )
        await active.transaction(async (transaction) => {
          await transaction.models.Item.create({
            title: `${titlePrefix} retained`,
          })
          try {
            await transaction.transaction(async (nested) => {
              await nested.models.Item.create({
                title: `${titlePrefix} nested`,
              })
              throw new Error('nested rollback')
            })
          } catch (failure) {
            assert(
              String(failure).includes('nested rollback'),
              'Nested rollback must retain its cause.',
            )
          }
        })
        assert(
          (await active.models.Item.allowPartial().count()) === baseline + 1 &&
            Number(published) === 1,
          'Only the outer committed transaction publishes once.',
        )
        const retained = await active.models.Item.where(
          'title',
          `${titlePrefix} retained`,
        ).firstOrFail()
        await retained.delete()
        return {
          rolledBack: true,
          nestedSavepoints: true,
          committedPublications: 1,
        }
      } finally {
        unsubscribe()
      }
    })
    await check('synloquent HTTP sync and reactive updates', async () => {
      const mounted = await mountQuery(
        active,
        active.query('Item').where('title', 'like', `${titlePrefix}%`),
      )
      mountedQueries.add(mounted)
      await waitFor(
        () => !mounted.snapshot().loading,
        'the mounted React query',
      )
      await active.sync.flush()
      const parent =
        await active.models.Item.with('images').findOrFail(parentIdentity)
      const child = await active.models.Image.findOrFail(imageIdentity)
      assert(
        parent.canonicalRecord()?.id &&
          String(child.attributes.item_id) === String(parent.id),
        'Server acknowledgements must remap child keys while preserving local identities.',
      )
      assert(
        (await active.models.Item.findOrFail(String(parent.id)))
          .localIdentity === parentIdentity,
        'The server identity must resolve to the stable local alias.',
      )
      const canonicalIdentity = String(parent.id)
      parent.fill({ title: `${titlePrefix} reactive` })
      await parent.save()
      await waitFor(
        () =>
          mounted
            .snapshot()
            .data.items.some(
              (model) => model.attributes.title === `${titlePrefix} reactive`,
            ),
        'the committed React subscription update',
      )
      await active.sync.flush()
      await active.sync.pull('catalog')
      const remote = await active.models.Item.remote()
        .where('id', canonicalIdentity)
        .with('images')
        .firstOrFail()
      assert(
        remote.attributes.title === `${titlePrefix} reactive` &&
          remote.relation('images').current?.length === 1,
        'The actual Laravel query must return the synchronized parent and child.',
      )
      await mounted.unmount()
      mountedQueries.delete(mounted)
      assert(
        active.storage.owner.listenerCount === 0,
        'React unmount must remove its owner listener.',
      )
      return {
        canonicalIdentity,
        localIdentity: parentIdentity,
        actualHttp: true,
        reactive: true,
      }
    })
    await check(
      'synloquent HTTP conflict recovery and registered command',
      async () => {
        const parent = await active.models.Item.findOrFail(parentIdentity)
        const canonical = parent.canonicalRecord()
        assert(
          canonical,
          'The synchronized parent must have an authoritative revision.',
        )
        const transport = createExampleTransport({ address })
        const externalOperation = generateIdentity()
        const response = await transport.push(
          active.sync.envelope('push', {
            operations: [
              {
                operationId: externalOperation,
                localIdentity: generateIdentity(),
                model: 'Item',
                id: canonical.id,
                action: 'update',
                expectedRevision: canonical.revision,
                dependsOn: [],
                values: { title: `${titlePrefix} server proposal` },
              },
            ],
          }),
        )
        assert(
          response.receipts[0]?.status === 'accepted',
          'The competing actual HTTP update must commit.',
        )
        parent.fill({ title: `${titlePrefix} local proposal` })
        await parent.save()
        const conflictOperation = parent.lastOperationId
        assert(
          conflictOperation,
          'The local edit must expose its immutable operation identity.',
        )
        await active.sync.flush()
        const conflict = await active.models.Item.findOrFail(parentIdentity)
        assert(
          conflict.syncState === 'conflicted' &&
            conflict.attributes.title === `${titlePrefix} local proposal`,
          'An authoritative revision conflict must retain the local proposal.',
        )
        await active.sync.resolveConflict(conflictOperation, 'discard')
        const recovered = await active.models.Item.findOrFail(parentIdentity)
        assert(
          recovered.attributes.title === `${titlePrefix} server proposal` &&
            recovered.syncState === 'synced',
          'Discard must reveal the authoritative canonical value.',
        )
        const operationIdentity = generateIdentity()
        const before = Number(recovered.attributes.quantity)
        const command = await active.commands.increaseQuantity(
          { item_id: canonical.id, delta: 1 },
          operationIdentity,
        )
        const repeated = await active.commands.increaseQuantity(
          { item_id: canonical.id, delta: 1 },
          operationIdentity,
        )
        assert(
          Number(command.quantity) === before + 1 &&
            canonicalJson(command) === canonicalJson(repeated),
          'The registered command must return its typed projection and replay its exact operation identity.',
        )
        await active.sync.pull('catalog')
        assert(
          Number(
            (await active.models.Item.findOrFail(parentIdentity)).attributes
              .quantity,
          ) ===
            before + 1,
          'Command publication must reach the native catalog by pull.',
        )
        return {
          retainedConflict: true,
          canonicalRecovery: true,
          commandQuantity: command.quantity,
          idempotentCommand: true,
        }
      },
    )
    await check(
      'synloquent exact integer and query comparison semantics',
      async () => {
        const exactIdentity = '18446744073709551614'
        const record: CanonicalRecord = {
          model: 'Item',
          id: exactIdentity,
          revision: '1',
          attributes: {
            id: exactIdentity,
            title: 'Ž Native exact',
            price: '9007199254740993.01',
            quantity: exactIdentity,
            active: true,
            category_id: null,
            metadata: null,
            created_at: null,
            updated_at: null,
          },
        }
        await active.sync.installSnapshot(await makeSnapshot([record]))
        const loaded = await active.models.Item.findOrFail(exactIdentity)
        assert(
          loaded.attributes.quantity === exactIdentity &&
            String(loaded.id) === exactIdentity,
          'Native OP numeric conversion must not round stored unsigned integer identities.',
        )
        assert(
          (await active.models.Item.where('title', 'like', 'ž%').count()) ===
            0 &&
            (await active.models.Item.where('title', 'like', 'Ž%').count()) ===
              1,
          'LIKE must be case sensitive for Unicode.',
        )
        assert(
          (await active.models.Item.where(
            'quantity',
            '>',
            '9007199254740993',
          ).count()) === 1,
          'Native integer comparisons must preserve exact lexical numeric shadows.',
        )
        assert(
          String(await active.models.Item.sum('quantity')) === exactIdentity &&
            String(await active.models.Item.max('quantity')) === exactIdentity,
          'Native integer aggregates must retain values outside JavaScript safe integer range.',
        )
        return { exactIdentity, exactQuantity: loaded.attributes.quantity }
      },
    )
    await check(
      'mounted React query retains remote and partial execution',
      async () => {
        const remoteQuery = active.query('Item').remote().take(2)
        const remoteMount = await mountQuery(active, remoteQuery)
        mountedQueries.add(remoteMount)
        await waitFor(
          () =>
            !remoteMount.snapshot().loading &&
            remoteMount.snapshot().data.length > 0,
          'mounted actual remote query',
        )
        assert(
          remoteMount.observedQueryKey() === remoteQuery.observationKey &&
            remoteMount
              .snapshot()
              .data.items.every((model) =>
                model.localIdentity.startsWith('remote:'),
              ),
          'Mounted hook must preserve remote execution and public query descriptor.',
        )
        await remoteMount.unmount()
        mountedQueries.delete(remoteMount)
        const partialQuery = active.query('Item').allowPartial().take(2)
        const partialMount = await mountQuery(active, partialQuery)
        mountedQueries.add(partialMount)
        await waitFor(
          () => !partialMount.snapshot().loading,
          'mounted partial local query',
        )
        assert(
          partialMount.observedQueryKey() === partialQuery.observationKey &&
            JSON.parse(partialMount.observedQueryKey()!).allowPartial === true,
          'Mounted hook must preserve explicit partial execution through its public descriptor.',
        )
        await partialMount.unmount()
        mountedQueries.delete(partialMount)
        assert(
          active.storage.owner.listenerCount === 0,
          'Execution-mode probes must clean up actual owner listeners.',
        )
        return {
          remoteMode: true,
          partialMode: true,
          actualRemoteRows: remoteMount.snapshot().data.length,
          listeners: active.storage.owner.listenerCount,
        }
      },
    )
    await check(
      'synloquent unmount account-switch schema-update listeners',
      async () => {
        const mounted = await mountQuery(active, active.query('Item'))
        mountedQueries.add(mounted)
        await waitFor(() => !mounted.snapshot().loading, 'the account query')
        const staleModel = await active.models.Item.firstOrFail()
        await active.setSession({
          ...exampleSession,
          accountId: '2',
          generation: 1,
        })
        await waitFor(
          () =>
            mounted.snapshot().generation === active.storage.owner.generation &&
            mounted.snapshot().data.length === 0,
          'account partition replacement',
        )
        let staleRejected = false
        try {
          void staleModel.attributes
        } catch {
          staleRejected = true
        }
        assert(
          staleRejected,
          'Old generation models must reject access after account replacement.',
        )
        await mounted.unmount()
        mountedQueries.delete(mounted)
        assert(
          active.storage.owner.listenerCount === 0,
          'The account query must clean up on unmount.',
        )
        const oldSchema = {
          ...backendSchema,
          fingerprint: 'native-old-schema',
          schemaVersion: 0,
        }
        const upgrading = await makeExampleClient(
          schemaDatabaseName,
          address,
          oldSchema,
        )
        clients.add(upgrading)
        const upgradeMount = await mountQuery(
          upgrading,
          upgrading.query('Item').take(10),
        )
        mountedQueries.add(upgradeMount)
        assert(
          await upgrading.sync.updateManifest('catalog'),
          'An installed older metadata generation must update from the actual Laravel manifest.',
        )
        await waitFor(
          () =>
            upgradeMount.snapshot().generation ===
              upgrading.storage.owner.generation &&
            !upgradeMount.snapshot().loading,
          'schema generation publication',
        )
        assert(
          upgrading.storage.manifest.fingerprint === backendSchema.fingerprint,
          'Schema replacement must install the generated Laravel fingerprint.',
        )
        await upgradeMount.unmount()
        mountedQueries.delete(upgradeMount)
        assert(
          upgrading.storage.owner.listenerCount === 0,
          'Schema replacement subscriptions must release their listeners.',
        )
        return {
          accountIsolation: true,
          staleModelsRejected: true,
          generatedSchemaInstalled: true,
          remainingListeners: 0,
        }
      },
    )
    await check(
      'synloquent close drains domain work and preserves durability',
      async () => {
        await active.setSession(exampleSession)
        const accepted = active.models.Item.create({
          title: `${titlePrefix} close`,
        })
        const closing = active.close()
        await accepted
        await closing
        clients.delete(active)
        const reopened = await makeExampleClient(databaseName, address)
        clients.add(reopened)
        assert(
          (
            await reopened.models.Item.where(
              'title',
              `${titlePrefix} close`,
            ).firstOrFail()
          ).syncState === 'pending',
          'Close must drain accepted domain and outbox work.',
        )
        return {
          durable: true,
          listenerCount: reopened.storage.owner.listenerCount,
        }
      },
    )
    return {
      platform: Platform.OS,
      hermes: true,
      status: 'passed',
      checks,
      startedAt,
      finishedAt: new Date().toISOString(),
    }
  } catch (failure) {
    const httpFailure = nativeHttpFailure()
    if (httpFailure)
      checks.push({
        name: 'first native HTTP failure boundary',
        durationMilliseconds: 0,
        detail: httpFailure,
      })
    return {
      platform: Platform.OS,
      hermes: Boolean(
        (globalThis as typeof globalThis & { HermesInternal?: unknown })
          .HermesInternal,
      ),
      status: 'failed',
      checks,
      error: String(failure),
      startedAt,
      finishedAt: new Date().toISOString(),
    }
  } finally {
    for (const mounted of mountedQueries) await mounted.unmount()
    for (const active of clients) await active.close()
    deleteDatabase(databaseName)
    deleteDatabase(schemaDatabaseName)
  }
}
