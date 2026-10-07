import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { Script, createContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import typescript from 'typescript'
import type {
  Envelope,
  Session,
  SnapshotPartsDescriptor,
  SnapshotPartIdentity,
  SnapshotPartBatch,
  Transport,
} from '../src/core/types.js'

const session: Session = {
  accountId: 'a',
  tenantId: 't',
  deviceId: 'd',
  deviceEpoch: 'e',
  generation: 0,
}
const hash = (content: string) =>
  createHash('sha256').update(content).digest('hex')
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
function fixture(
  options: {
    corrupt?: boolean
    oversize?: boolean
    pauseDigest?: boolean
    pauseFetch?: boolean
    malformed?: boolean
    descriptorPatch?: Readonly<Record<string, unknown>>
    escapedRowsKey?: boolean
    firstRowsValue?: string
  } = {},
) {
  const calls: {
    address: string
    settings: { method: string; headers: Record<string, string>; body?: string }
  }[] = []
  const rows = [
    {
      model: 'Item',
      id: '1',
      revision: '1',
      attributes: {
        title: 'Příliš 😀',
        nested: { rows: ['escaped "rows":[]'] },
      },
    },
  ]
  const canonicalDocument = JSON.stringify({
    format: 'canonical-parts-v1',
    ordinal: 0,
    section: 'records',
    firstIndex: 0,
    rowCount: 1,
    rows,
  })
  const escapedDocument = options.escapedRowsKey
    ? canonicalDocument.replace('"rows":', '"\\u0072ows":')
    : canonicalDocument
  const document =
    options.firstRowsValue === undefined
      ? escapedDocument
      : escapedDocument.replace(
          '"rows":',
          '"rows":' + options.firstRowsValue + ',"rows":',
        )
  const firstPart: SnapshotPartIdentity = {
    ordinal: 0,
    downloadUrl:
      'https://owned.invalid/snapshots/' +
      'a'.repeat(64) +
      '/' +
      'b'.repeat(64) +
      '/parts/0',
    hash: hash(document),
    byteSize: Buffer.byteLength(document),
    continuation: 'opaque-bound-token',
  }
  const descriptor: SnapshotPartsDescriptor = {
    schemaFingerprint: 'schema',
    dataset: 'catalog',
    generation: 'a'.repeat(64),
    cursor: 'cursor',
    hash: 'b'.repeat(64),
    byteSize: 100,
    scope: {
      dataset: 'catalog',
      authorizationGeneration: '1',
      projectionGeneration: '1',
      schemaFingerprint: 'schema',
      completeness: 'complete',
    },
    format: 'canonical-parts-v1',
    status: 'ready',
    partCount: 1,
    recordCount: 1,
    relationSetCount: 0,
    maximumPartBytes: 65536,
    maximumRowBytes: 500,
    partRowLimit: 256,
    firstPart,
  }
  const request = <Payload>(payload: Payload): Envelope<Payload> => ({
    protocolVersion: 1,
    requestId: 'request',
    kind: 'snapshot',
    schemaFingerprint: 'schema',
    session,
    payload,
  })
  let resolveDigest: (() => void) | undefined
  const paused = new Promise<void>((resolvePause) => {
    resolveDigest = resolvePause
  })
  let resolveFetch: (() => void) | undefined
  const pausedFetch = new Promise<void>((resolvePause) => {
    resolveFetch = resolvePause
  })
  const fetchSignals: AbortSignal[] = []
  const stages: { phase: string; boundary?: string }[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const context = createContext({
    AbortController,
    setTimeout(callback: () => void, delay: number) {
      const timer = setTimeout(callback, delay)
      timers.add(timer)
      return timer
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) {
      timers.delete(timer)
      clearTimeout(timer)
    },
    fetch: async (
      address: string,
      settings: (typeof calls)[number]['settings'] & { signal: AbortSignal },
    ) => {
      calls.push({ address, settings })
      fetchSignals.push(settings.signal)
      if (options.pauseFetch && calls.length === 1) await pausedFetch
      let body: string
      const headers = new Map<string, string>()
      if (settings.method === 'GET') {
        headers.set('X-Synloquent-Part-Index', JSON.stringify([firstPart]))
        headers.set('X-Synloquent-Confirmation-Token', 'confirm-token')
        body =
          (options.corrupt ? document.replace('Příliš', 'Tamper') : document) +
          '\n'
        if (options.oversize) body += 'x'.repeat(1048576)
        if (options.malformed)
          headers.set(
            'X-Synloquent-Part-Index',
            JSON.stringify([{ ...firstPart, ordinal: 1 }]),
          )
      } else if (address.endsWith('/confirm'))
        body = JSON.stringify({ ...descriptor, confirmed: true })
      else
        body = JSON.stringify({
          ...request({ dataset: 'catalog' }),
          payload: { ...descriptor, ...options.descriptorPatch },
        })
      return {
        status: 200,
        ok: true,
        headers: { get: (name: string) => headers.get(name) ?? null },
        text: async () => body,
      }
    },
  })
  const loaded = new Map<string, object>()
  const load = (filename: string): object => {
    const absolute = resolve(filename)
    const cached = loaded.get(absolute)
    if (cached) return cached
    const exported = {}
    loaded.set(absolute, exported)
    const compiled = typescript.transpileModule(
      readFileSync(absolute, 'utf8'),
      {
        compilerOptions: {
          module: typescript.ModuleKind.CommonJS,
          target: typescript.ScriptTarget.ES2022,
        },
      },
    ).outputText
    const require = (name: string): object =>
      name === 'scheduler'
        ? { unstable_NormalPriority: 3 }
        : load(resolve(dirname(absolute), name.replace(/\.js$/, '.ts')))
    new Script('(function(require,exports){' + compiled + '\n})').runInContext(
      context,
    )(require, exported)
    return exported
  }
  const exported = load(
    resolve(repository, 'packages/client/src/react-native/http/transport.ts'),
  ) as {
    createReactNativeHttpTransport(configuration: object): {
      transport: Transport
      close(): Promise<void>
      setSession(value: Session): void
    }
  }
  const owner = exported.createReactNativeHttpTransport({
    endpoint: 'https://owned.invalid/protocol',
    session,
    authenticate: () => ({
      session,
      headers: { Authorization: 'Bearer fixture' },
    }),
    timeoutMilliseconds: 30000,
    nowMilliseconds: () => 0,
    schedule(callback: () => void) {
      const task = setImmediate(callback)
      return () => clearImmediate(task)
    },
    async digest(content: string, lifecycle: { readonly cancelled: boolean }) {
      if (options.pauseDigest) await paused
      if (lifecycle.cancelled) throw new Error('Cancelled digest')
      return hash(content)
    },
    observeStage(stage: { phase: string; boundary?: string }) {
      stages.push(stage)
    },
  })
  return {
    owner,
    descriptor,
    firstPart,
    request,
    document,
    rows,
    calls,
    timers,
    resolveDigest,
    resolveFetch,
    fetchSignals,
    stages,
  }
}

test('bounded HTTP preserves exact Unicode wire and raw rows, uses one authenticated bundle request and confirms the same acquisition', async () => {
  const control = fixture()
  try {
    const prepared = await control.owner.transport.snapshotParts!(
      control.request({ dataset: 'catalog' }),
    )
    assert.equal(prepared.generation, control.descriptor.generation)
    const batch = await control.owner.transport.snapshotPartBatch!(
      control.request({ descriptor: prepared, part: control.firstPart }),
    )
    const parts = []
    for await (const part of batch.parts) parts.push(part)
    assert.equal(parts.length, 1)
    assert.equal(parts[0]!.rawDocument, control.document)
    assert.deepEqual(JSON.parse(parts[0]!.rawRows), control.rows)
    assert.equal(parts[0]!.hash, control.firstPart.hash)
    assert.deepEqual(
      control.stages
        .filter((stage) => stage.boundary?.startsWith('immutable part 0'))
        .map((stage) => stage.phase),
      ['jsonDecode', 'shapeValidation', 'shapeValidation'],
    )
    assert.equal(batch.confirmationToken, 'confirm-token')
    const confirmation = await control.owner.transport.confirmSnapshotParts!(
      control.request({
        descriptor: prepared,
        confirmationToken: batch.confirmationToken!,
      }),
    )
    assert.equal(confirmation.confirmed, true)
    assert.equal(control.calls.length, 3)
    assert.equal(
      control.calls[1]!.settings.headers['X-Synloquent-Continuation'],
      'opaque-bound-token',
    )
    assert.equal(
      control.calls[1]!.settings.headers.Authorization,
      'Bearer fixture',
    )
    assert.equal(control.calls[1]!.settings.body, undefined)
  } finally {
    await control.owner.close()
    assert.equal(control.timers.size, 0)
  }
})

for (const scenario of ['corrupt', 'oversize', 'malformed'] as const)
  test(
    'bounded HTTP rejects ' + scenario + ' immutable data before issuing a row',
    async () => {
      const control = fixture({ [scenario]: true })
      let issued = 0
      try {
        await assert.rejects(async () => {
          const batch = await control.owner.transport.snapshotPartBatch!(
            control.request({
              descriptor: control.descriptor,
              part: control.firstPart,
            }),
          )
          for await (const part of batch.parts) {
            assert.ok(part.hash)
            issued++
          }
        })
        assert.equal(issued, 0)
      } finally {
        await control.owner.close()
        assert.equal(control.timers.size, 0)
      }
    },
  )

for (const descriptorPatch of [
  {
    scope: {
      dataset: 'different',
      schemaFingerprint: 'schema',
      authorizationGeneration: '1',
      projectionGeneration: '1',
    },
  },
  {
    scope: {
      dataset: 'catalog',
      schemaFingerprint: 'schema',
      authorizationGeneration: '1',
      projectionGeneration: '1',
      completeness: 'unknown',
    },
  },
  { partCount: 0, confirmationToken: 'token' },
  { maximumRowBytes: 65537 },
  { unexpected: { nested: 'untrusted' } },
])
  test(
    'bounded descriptor rejects inconsistent metadata ' +
      JSON.stringify(descriptorPatch),
    async () => {
      const control = fixture({ descriptorPatch })
      try {
        await assert.rejects(
          control.owner.transport.snapshotParts!(
            control.request({ dataset: 'catalog' }),
          ),
          { code: 'schema_mismatch' },
        )
        assert.equal(control.calls.length, 1)
      } finally {
        await control.owner.close()
        assert.equal(control.timers.size, 0)
      }
    },
  )

test('closing an unconsumed bounded bundle releases its operation and invalidates its lazy iterator', async () => {
  const control = fixture()
  const batch: SnapshotPartBatch = await control.owner.transport
    .snapshotPartBatch!(
    control.request({
      descriptor: control.descriptor,
      part: control.firstPart,
    }),
  )
  await control.owner.close()
  assert.equal(control.timers.size, 0)
  await assert.rejects(async () => {
    for await (const part of batch.parts)
      assert.fail('Closed bundle yielded ordinal ' + part.ordinal)
  })
})

test('session replacement cancels a pending part digest and releases the bounded response without waiting for that digest', async () => {
  const control = fixture({ pauseDigest: true })
  try {
    const batch = await control.owner.transport.snapshotPartBatch!(
      control.request({
        descriptor: control.descriptor,
        part: control.firstPart,
      }),
    )
    const iterator = batch.parts[Symbol.asyncIterator]()
    const pending = iterator.next()
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
    control.owner.setSession({ ...session, generation: 1 })
    control.resolveDigest!()
    await assert.rejects(pending)
  } finally {
    control.resolveDigest!()
    await control.owner.close()
    assert.equal(control.timers.size, 0)
  }
})

test('owner cancellation aborts native fetch and prevents replacement overlap until the cancelled fetch actually settles', async () => {
  const control = fixture({ pauseFetch: true })
  const listeners = new Set<() => void>()
  let cancelled = false
  const lifecycle = {
    get cancelled() {
      return cancelled
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const request = control.request({
    descriptor: control.descriptor,
    part: control.firstPart,
  })
  try {
    const pending = control.owner.transport.snapshotPartBatch!(
      request,
      lifecycle,
    )
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
    assert.equal(control.calls.length, 1)
    cancelled = true
    for (const listener of listeners) listener()
    await assert.rejects(pending, { code: 'snapshot_install_cancelled' })
    assert.equal(control.fetchSignals[0]!.aborted, true)
    assert.equal(listeners.size, 0)
    await assert.rejects(control.owner.transport.snapshotPartBatch!(request), {
      code: 'snapshot_admission_required',
    })
    assert.equal(control.calls.length, 1)
    control.resolveFetch!()
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
    const replacement =
      await control.owner.transport.snapshotPartBatch!(request)
    let issued = 0
    for await (const part of replacement.parts) {
      assert.equal(part.ordinal, 0)
      issued++
    }
    assert.equal(issued, 1)
    assert.equal(control.calls.length, 2)
  } finally {
    control.resolveFetch!()
    await control.owner.close()
    assert.equal(control.timers.size, 0)
    assert.equal(listeners.size, 0)
  }
})

test('an unconsumed bundle prevents a second acquisition until the owned iterator closes', async () => {
  const control = fixture()
  const request = control.request({
    descriptor: control.descriptor,
    part: control.firstPart,
  })
  try {
    const batch = await control.owner.transport.snapshotPartBatch!(request)
    await assert.rejects(control.owner.transport.snapshotPartBatch!(request), {
      code: 'snapshot_admission_required',
    })
    assert.equal(control.calls.length, 1)
    for await (const part of batch.parts) {
      assert.equal(part.ordinal, 0)
      break
    }
    const replacement =
      await control.owner.transport.snapshotPartBatch!(request)
    for await (const part of replacement.parts) {
      assert.equal(part.ordinal, 0)
      break
    }
    assert.equal(control.calls.length, 2)
  } finally {
    await control.owner.close()
    assert.equal(control.timers.size, 0)
  }
})

for (const ending of ['return', 'throw'] as const) {
  test(`an unopened iterator ${ending} releases its acquisition before replacement`, async () => {
    const control = fixture()
    const request = control.request({
      descriptor: control.descriptor,
      part: control.firstPart,
    })
    try {
      const batch = await control.owner.transport.snapshotPartBatch!(request)
      const iterator = batch.parts[Symbol.asyncIterator]()
      if (ending === 'return') await iterator.return!()
      else {
        const failure = new Error('Consumer abandoned the unopened bundle')
        await assert.rejects(
          iterator.throw!(failure),
          (value) => value === failure,
        )
      }
      assert.equal(control.timers.size, 0)
      const replacement =
        await control.owner.transport.snapshotPartBatch!(request)
      for await (const part of replacement.parts) assert.equal(part.ordinal, 0)
      assert.equal(control.calls.length, 2)
    } finally {
      await control.owner.close()
      assert.equal(control.timers.size, 0)
    }
  })
}

test('iterator return cancels a pending digest and retains the gate until that digest settles', async () => {
  const control = fixture({ pauseDigest: true })
  const request = control.request({
    descriptor: control.descriptor,
    part: control.firstPart,
  })
  try {
    const batch = await control.owner.transport.snapshotPartBatch!(request)
    const iterator = batch.parts[Symbol.asyncIterator]()
    const pending = iterator.next()
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
    const ending = iterator.return!()
    await assert.rejects(control.owner.transport.snapshotPartBatch!(request), {
      code: 'snapshot_admission_required',
    })
    assert.equal(control.calls.length, 1)
    control.resolveDigest!()
    await assert.rejects(pending, { message: 'Cancelled digest' })
    assert.equal((await ending).done, true)
    const replacement =
      await control.owner.transport.snapshotPartBatch!(request)
    for await (const part of replacement.parts) assert.equal(part.ordinal, 0)
    assert.equal(control.calls.length, 2)
  } finally {
    control.resolveDigest!()
    await control.owner.close()
    assert.equal(control.timers.size, 0)
  }
})

test('bounded HTTP preserves the original wire and exact array span with an escaped root rows key', async () => {
  const control = fixture({ escapedRowsKey: true })
  try {
    const batch = await control.owner.transport.snapshotPartBatch!(
      control.request({
        descriptor: control.descriptor,
        part: control.firstPart,
      }),
    )
    let issued = 0
    for await (const part of batch.parts) {
      assert.equal(part.rawDocument, control.document)
      assert.equal(part.rawRows, JSON.stringify(control.rows))
      assert.equal(part.hash, hash(control.document))
      assert.deepEqual(JSON.parse(part.rawRows), control.rows)
      issued++
    }
    assert.equal(issued, 1)
  } finally {
    await control.owner.close()
    assert.equal(control.timers.size, 0)
  }
})

for (const firstRowsValue of ['null', 'false', '1', '"rows"', '{"rows":[]}'])
  test(
    'bounded HTTP rejects a non-array first rows occurrence before yielding: ' +
      firstRowsValue,
    async () => {
      const control = fixture({ firstRowsValue })
      try {
        const batch = await control.owner.transport.snapshotPartBatch!(
          control.request({
            descriptor: control.descriptor,
            part: control.firstPart,
          }),
        )
        await assert.rejects(batch.parts[Symbol.asyncIterator]().next(), {
          code: 'snapshot_invalid',
        })
      } finally {
        await control.owner.close()
        assert.equal(control.timers.size, 0)
      }
    },
  )
