import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { createNetworkComparisonProxy } from './network-proxy.mjs'

const generation = 'a'.repeat(64)
const catalogHash = 'b'.repeat(64)
const base = `/synloquent/v1/snapshots/${generation}/${catalogHash}`
const session = {
  accountId: '1',
  tenantId: '1',
  deviceId: 'test-device',
  deviceEpoch: 'epoch-1',
  generation: 1,
}
const documents = [
  Buffer.from(
    '{"firstIndex":0,"format":"canonical-parts-v1","ordinal":0,"rowCount":1,"section":"records","rows":[{"attributes":{"id":1,"title":"Český 🌲"},"id":"1","model":"Item","revision":"0"}]}',
  ),
  Buffer.from(
    '{"firstIndex":0,"format":"canonical-parts-v1","ordinal":1,"rowCount":1,"section":"relationSets","rows":[{"completeness":"complete","model":"Item","parentId":"1","relation":"tags","revision":"0","targets":[]}]}',
  ),
]
const identities = documents.map((body, ordinal) => ({
  ordinal,
  downloadUrl: `${base}/parts/${ordinal}`,
  hash: createHash('sha256').update(body).digest('hex'),
  byteSize: body.length,
  continuation: `test-continuation-${ordinal}`,
}))
const descriptor = {
  schemaFingerprint: 'c'.repeat(64),
  dataset: 'catalog',
  generation,
  hash: catalogHash,
  byteSize: 321,
  cursor: 'immutable-cursor',
  scope: {
    dataset: 'catalog',
    authorizationGeneration: '1',
    projectionGeneration: '1',
    schemaFingerprint: 'c'.repeat(64),
  },
  downloadUrl: base,
  format: 'canonical-parts-v1',
  status: 'ready',
  partCount: 2,
  recordCount: 1,
  relationSetCount: 1,
  maximumPartBytes: 65536,
  maximumRowBytes: documents[1].length,
  partRowLimit: 256,
  firstPart: identities[0],
}
const envelope = {
  protocolVersion: 1,
  requestId: 'owned-proxy-control',
  kind: 'snapshot',
  schemaFingerprint: descriptor.schemaFingerprint,
  session,
  payload: { dataset: 'catalog', delivery: 'parts-v1' },
}
async function startServer(callback) {
  const server = createServer(callback)
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  assert(![8765, 8766, 8767].includes(port))
  return {
    server,
    sockets,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      const ended = new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      for (const socket of sockets) socket.destroy()
      await ended
      assert.equal(server.listening, false)
    },
  }
}
function call(origin, path, { method = 'GET', body, headers = {} } = {}) {
  let outgoing
  const completion = new Promise((resolve, reject) => {
    const content =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    outgoing = request(
      origin + path,
      {
        method,
        agent: false,
        headers: {
          Authorization: 'Bearer mock-actor-1',
          ...(content
            ? {
                'Content-Type': 'application/json',
                'Content-Length': content.length,
              }
            : {}),
          ...headers,
        },
      },
      async (response) => {
        try {
          const buffers = []
          for await (const chunk of response) buffers.push(chunk)
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(buffers),
          })
        } catch (error) {
          reject(error)
        }
      },
    )
    outgoing.on('error', reject)
    outgoing.end(content)
  })
  return {
    completion,
    cancel() {
      outgoing.destroy(new Error('Owned client cancelled.'))
    },
  }
}
async function fixture(options = {}) {
  const fixtureDocuments = options.documents ?? documents
  const fixtureIdentities = fixtureDocuments.map((body, ordinal) => ({
    ...identities[0],
    ordinal,
    downloadUrl: `${base}/parts/${ordinal}`,
    hash: createHash('sha256').update(body).digest('hex'),
    byteSize: body.length,
    continuation: `test-continuation-${ordinal}`,
  }))
  const fixtureDescriptor = options.descriptor ?? {
    ...descriptor,
    partCount: fixtureDocuments.length,
    firstPart: fixtureIdentities[0],
  }
  const observed = []
  const logs = []
  const failures = []
  const upstream = await startServer(async (incoming, response) => {
    try {
      const buffers = []
      for await (const chunk of incoming) buffers.push(chunk)
      observed.push({
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
        body: Buffer.concat(buffers),
      })
      if (
        options.respond &&
        (await options.respond(incoming, response, observed.at(-1)))
      )
        return
      if (incoming.url === '/synloquent/v1/protocol') {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'private, no-store',
        })
        response.end(
          JSON.stringify({
            ...envelope,
            session: {
              generation: 1,
              deviceEpoch: 'epoch-1',
              deviceId: 'test-device',
              tenantId: '1',
              accountId: '1',
            },
            payload: fixtureDescriptor,
          }),
        )
        return
      }
      if (incoming.url === `${base}/confirm`) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ ...fixtureDescriptor, confirmed: true }))
        return
      }
      const ordinal = Number(incoming.url.match(/\/parts\/(\d+)/)?.[1])
      if (incoming.url.endsWith('/bundle')) {
        response.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'private, no-store',
          'X-Synloquent-Part-Index': JSON.stringify(
            fixtureIdentities.slice(ordinal),
          ),
          'X-Synloquent-Confirmation-Token': 'final-confirmation',
          'X-Preserved-Header': 'original-value',
        })
        for (const document of fixtureDocuments.slice(ordinal)) {
          response.write(document)
          response.write('\n')
        }
        response.end()
      } else if (fixtureDocuments[ordinal]) {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': fixtureDocuments[ordinal].length,
          'Cache-Control': 'private, no-store',
          ...(ordinal + 1 < fixtureDocuments.length
            ? {
                'X-Synloquent-Next-Part': JSON.stringify(
                  fixtureIdentities[ordinal + 1],
                ),
              }
            : { 'X-Synloquent-Confirmation-Token': 'final-confirmation' }),
          'X-Preserved-Header': 'original-value',
        })
        response.end(fixtureDocuments[ordinal])
      } else {
        response.writeHead(404)
        response.end('Unknown mock route')
      }
    } catch (error) {
      failures.push(error)
      response.destroy()
    }
  })
  const proxy = createNetworkComparisonProxy({
    upstreamOrigin: upstream.origin,
    arm: options.arm ?? 'single',
    platform: 'ios',
    runIdentity: 'owned-proxy-offline-control',
    controlledDelayMilliseconds: options.delay ?? 0,
    appendLog: (measurement) => logs.push(measurement),
  })
  const collector = await startServer((incoming, response) => {
    proxy
      .handle(incoming, response)
      .then((handled) => {
        if (!handled) {
          response.writeHead(404)
          response.end('Unrelated collector path')
        }
      })
      .catch((error) => {
        failures.push(error)
        response.destroy()
      })
  })
  return {
    proxy,
    upstream,
    collector,
    observed,
    logs,
    failures,
    identities: fixtureIdentities,
    descriptor: fixtureDescriptor,
    call(path, options) {
      return call(collector.origin, path, options)
    },
    async prepare() {
      const response = await this.call(
        '/network-proxy/synloquent/v1/protocol',
        { method: 'POST', body: envelope },
      ).completion
      assert.equal(response.status, 200, response.body.toString())
      return response
    },
    part(ordinal, options = {}) {
      return this.call(`/network-proxy${base}/parts/${ordinal}/bundle`, {
        headers: {
          'X-Synloquent-Continuation': fixtureIdentities[ordinal]?.continuation,
          ...options.headers,
        },
        ...options,
      })
    },
    async close() {
      await proxy.close()
      await collector.close()
      await upstream.close()
      assert.deepEqual(failures, [])
      assert.equal(proxy.metrics().activeRequests, 0)
      assert.equal(proxy.metrics().activeTimers, 0)
      assert.equal(proxy.metrics().upstreamSockets, 0)
    },
  }
}
async function usingFixture(options, callback) {
  const owned = await fixture(options)
  try {
    await callback(owned)
  } finally {
    await owned.close()
  }
}
function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000
    const poll = () => {
      if (predicate()) resolve()
      else if (Date.now() > deadline)
        reject(new Error('Owned mock condition did not settle.'))
      else setTimeout(poll, 5)
    }
    poll()
  })
}

test('single arm sends exactly one actual upstream part and preserves bytes, identity, authentication and confirmation', async () => {
  await usingFixture({}, async (owned) => {
    const prepared = await owned.prepare()
    assert.deepEqual(JSON.parse(prepared.body).payload, descriptor)
    const first = await owned.part(0).completion
    assert.equal(first.status, 200)
    assert.equal(first.headers['content-type'], 'application/x-ndjson')
    assert.equal(
      first.headers['content-length'],
      String(documents[0].length + 1),
    )
    assert.equal(first.headers['cache-control'], 'private, no-store')
    assert.equal(first.headers['x-preserved-header'], 'original-value')
    assert.deepEqual(
      first.body,
      Buffer.concat([documents[0], Buffer.from('\n')]),
    )
    assert.deepEqual(JSON.parse(first.headers['x-synloquent-part-index']), [
      identities[0],
    ])
    assert.equal(
      createHash('sha256').update(first.body.subarray(0, -1)).digest('hex'),
      identities[0].hash,
    )
    assert.deepEqual(
      JSON.parse(first.headers['x-synloquent-next-part']),
      identities[1],
    )
    assert.deepEqual(
      owned.observed.map((request) => request.path),
      ['/synloquent/v1/protocol', `${base}/parts/0`],
    )
    assert.equal(owned.observed[1].headers.authorization, 'Bearer mock-actor-1')
    assert.equal(
      owned.observed[1].headers['x-synloquent-continuation'],
      identities[0].continuation,
    )
    const final = await owned.part(1).completion
    assert.deepEqual(
      final.body,
      Buffer.concat([documents[1], Buffer.from('\n')]),
    )
    assert.equal(
      final.headers['x-synloquent-confirmation-token'],
      'final-confirmation',
    )
    const confirmation = await owned.call(`/network-proxy${base}/confirm`, {
      method: 'POST',
      body: { confirmationToken: 'final-confirmation' },
    }).completion
    assert.equal(confirmation.status, 200)
    assert.equal(JSON.parse(confirmation.body).confirmed, true)
    assert.equal(
      owned.logs.filter((measurement) => measurement.category === 'part')
        .length,
      2,
    )
    assert(!JSON.stringify(owned.logs).includes('Bearer mock-actor-1'))
    assert(!JSON.stringify(owned.logs).includes('test-continuation-'))
    assert.equal(owned.proxy.metrics().parts, 2)
  })
})

test('bundle arm forwards the original actual bundle without body or metadata rewriting', async () => {
  await usingFixture({ arm: 'bundle' }, async (owned) => {
    await owned.prepare()
    const result = await owned.part(0).completion
    assert.equal(result.status, 200)
    assert.deepEqual(
      result.body,
      Buffer.concat(
        documents.flatMap((document) => [document, Buffer.from('\n')]),
      ),
    )
    assert.equal(
      result.headers['x-synloquent-part-index'],
      JSON.stringify(identities),
    )
    assert.equal(
      result.headers['x-synloquent-confirmation-token'],
      'final-confirmation',
    )
    assert.equal(result.headers['x-preserved-header'], 'original-value')
    assert.deepEqual(
      owned.observed.map((request) => request.path),
      ['/synloquent/v1/protocol', `${base}/parts/0/bundle`],
    )
    assert.equal(owned.proxy.metrics().retainedIdentities, 0)
  })
})

test('unrelated collector prefix is not handled or sent upstream', async () => {
  await usingFixture({}, async (owned) => {
    assert.equal(
      (
        await owned.call('/network-proxy-other/synloquent/v1/protocol')
          .completion
      ).status,
      404,
    )
    assert.equal((await owned.call('/configuration').completion).status, 404)
    assert.equal(owned.observed.length, 0)
    assert.equal(owned.proxy.metrics().requests, 0)
  })
})

for (const [name, makeRequest] of [
  ['missing prepared identity', (owned) => owned.part(0)],
  [
    'unsupported direct part request',
    async (owned) => {
      await owned.prepare()
      return owned.call(`/network-proxy${base}/parts/0`, {
        headers: { 'X-Synloquent-Continuation': identities[0].continuation },
      })
    },
  ],
  ['old resumed ordinal without preparation', (owned) => owned.part(1)],
  [
    'foreign catalog hash',
    async (owned) => {
      await owned.prepare()
      return owned.call(
        `/network-proxy${base.replace(catalogHash, 'd'.repeat(64))}/parts/0/bundle`,
        {
          headers: { 'X-Synloquent-Continuation': identities[0].continuation },
        },
      )
    },
  ],
  [
    'wrong ordinal',
    async (owned) => {
      await owned.prepare()
      return owned.part(1)
    },
  ],
  [
    'wrong continuation',
    async (owned) => {
      await owned.prepare()
      return owned.part(0, {
        headers: { 'X-Synloquent-Continuation': 'foreign-continuation' },
      })
    },
  ],
  [
    'changed authenticated actor',
    async (owned) => {
      await owned.prepare()
      return owned.part(0, {
        headers: {
          Authorization: 'Bearer foreign-actor',
          'X-Synloquent-Continuation': identities[0].continuation,
        },
      })
    },
  ],
  [
    'premature confirmation',
    async (owned) => {
      await owned.prepare()
      return owned.call(`/network-proxy${base}/confirm`, {
        method: 'POST',
        body: { confirmationToken: 'final-confirmation' },
      })
    },
  ],
  [
    'implicit whole snapshot request',
    (owned) =>
      owned.call('/network-proxy/synloquent/v1/protocol', {
        method: 'POST',
        body: { ...envelope, payload: { dataset: 'catalog' } },
      }),
  ],
])
  test(`rejects ${name} before any corresponding upstream request`, async () => {
    await usingFixture({}, async (owned) => {
      const outgoing = await makeRequest(owned)
      const result = await outgoing.completion
      assert.equal(result.status, 502)
      assert.equal(
        JSON.parse(result.body).error.code,
        'diagnostic_proxy_failed',
      )
      assert(
        owned.observed.every(
          (request) => request.path === '/synloquent/v1/protocol',
        ),
      )
    })
  })

test('403 body and error metadata remain unchanged with no synthesized bundle success', async () => {
  const failure = Buffer.from(
    '{"error":{"code":"forbidden_operation","message":"Revoked owner"}}',
  )
  await usingFixture(
    {
      respond(incoming, response) {
        if (!incoming.url.includes('/parts/')) return false
        response.writeHead(403, {
          'Content-Type': 'application/json',
          'Content-Length': failure.length,
          'Cache-Control': 'private, no-store',
          'X-Error-Witness': 'original',
        })
        response.end(failure)
        return true
      },
    },
    async (owned) => {
      await owned.prepare()
      const result = await owned.part(0).completion
      assert.equal(result.status, 403)
      assert.deepEqual(result.body, failure)
      assert.equal(result.headers['x-error-witness'], 'original')
      assert.equal(result.headers['x-synloquent-part-index'], undefined)
      assert.equal(result.headers['x-synloquent-confirmation-token'], undefined)
      assert.equal(owned.proxy.metrics().retainedIdentities, 1)
    },
  )
})

for (const [name, responseHeaders, content] of [
  ['encoded body', { 'Content-Encoding': 'gzip' }, documents[0]],
  [
    'declared oversized single body',
    { 'Content-Length': 65537 },
    Buffer.alloc(65537),
  ],
  ['streamed oversized single body', {}, Buffer.alloc(65537)],
  ['corrupt body hash', {}, Buffer.from('incorrect immutable body')],
])
  test(`rejects ${name} without returning a successful transformed body`, async () => {
    await usingFixture(
      {
        respond(incoming, response) {
          if (!incoming.url.includes('/parts/')) return false
          response.writeHead(200, {
            'Content-Type': 'application/json',
            'X-Synloquent-Next-Part': JSON.stringify(identities[1]),
            ...responseHeaders,
          })
          response.end(content)
          return true
        },
      },
      async (owned) => {
        await owned.prepare()
        const result = await owned.part(0).completion
        assert.equal(result.status, 502)
        assert.equal(result.headers['x-synloquent-part-index'], undefined)
        assert.equal(owned.proxy.metrics().retainedIdentities, 1)
      },
    )
  })

test('controlled delay is measured separately from upstream wall and body/header bytes', async () => {
  await usingFixture({ delay: 25 }, async (owned) => {
    await owned.prepare()
    await owned.part(0).completion
    const measured = owned.logs.at(-1)
    assert(measured.controlledDelayMilliseconds >= 20)
    assert(
      measured.dispatchedMilliseconds >= measured.delayFinishedMilliseconds,
    )
    assert(measured.upstreamWallMilliseconds >= 0)
    assert.equal(measured.upstreamBodyBytes, documents[0].length)
    assert.equal(measured.deliveredBodyBytes, documents[0].length + 1)
    assert(
      measured.requestHeaderBytes > 0 &&
        measured.upstreamHeaderBytes > 0 &&
        measured.deliveredHeaderBytes > 0,
    )
    assert.equal(measured.backendCpuMilliseconds, null)
    assert.equal(
      measured.requestLineBytes,
      Buffer.byteLength(
        `GET /network-proxy${base}/parts/0/bundle HTTP/1.1\r\n`,
      ),
    )
    assert.equal(
      measured.upstreamRequestLineBytes,
      Buffer.byteLength(`GET ${base}/parts/0 HTTP/1.1\r\n`),
    )
    assert(Buffer.byteLength(JSON.stringify(measured)) <= 16384)
    assert.equal(owned.proxy.metrics().prepareRequests, 1)
    assert.equal(owned.proxy.metrics().partRequests, 1)
  })
})

test('close cancels pending controlled delay, drains work and allows no post-close dispatch', async () => {
  await usingFixture({ delay: 1000 }, async (owned) => {
    const outgoing = owned.call('/network-proxy/synloquent/v1/protocol', {
      method: 'POST',
      body: envelope,
    })
    const rejected = assert.rejects(outgoing.completion)
    await waitFor(() => owned.proxy.metrics().activeTimers === 1)
    const closing = owned.proxy.close()
    assert.equal(owned.proxy.close(), closing)
    await closing
    await rejected
    assert.equal(owned.observed.length, 0)
    assert.equal(owned.proxy.metrics().activeRequests, 0)
    assert.equal(owned.proxy.metrics().activeTimers, 0)
    assert.equal(owned.proxy.metrics().upstreamSockets, 0)
    assert.equal(
      (
        await owned.call('/network-proxy/synloquent/v1/protocol', {
          method: 'POST',
          body: envelope,
        }).completion
      ).status,
      503,
    )
  })
})

test('client cancellation aborts the owned upstream socket and releases in-flight snapshot ownership', async () => {
  let receivedPart
  const reached = new Promise((resolve) => {
    receivedPart = resolve
  })
  await usingFixture(
    {
      respond(incoming, response) {
        if (!incoming.url.includes('/parts/')) return false
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Synloquent-Next-Part': JSON.stringify(identities[1]),
        })
        response.flushHeaders()
        receivedPart()
        return true
      },
    },
    async (owned) => {
      await owned.prepare()
      const outgoing = owned.part(0)
      const rejected = assert.rejects(outgoing.completion)
      await reached
      const overlap = await owned.part(0).completion
      assert.equal(overlap.status, 409)
      outgoing.cancel()
      await rejected
      await waitFor(
        () =>
          owned.proxy.metrics().activeRequests === 0 &&
          owned.proxy.metrics().upstreamSockets === 0,
      )
      assert.equal(owned.proxy.metrics().snapshotActive, false)
      assert.equal(owned.proxy.metrics().cancelled, 1)
    },
  )
})

test('constructor pins a loopback origin and validates diagnostic-only settings', () => {
  const configuration = {
    arm: 'single',
    platform: 'ios',
    runIdentity: 'configuration-control',
    controlledDelayMilliseconds: 0,
  }
  for (const upstreamOrigin of [
    'http://example.com:8766',
    'https://127.0.0.1:8766',
    'http://127.0.0.1:8766/path',
    'http://actor:secret@127.0.0.1:8766',
  ])
    assert.throws(() =>
      createNetworkComparisonProxy({ ...configuration, upstreamOrigin }),
    )
  for (const changes of [
    { arm: 'whole' },
    { platform: 'node' },
    { controlledDelayMilliseconds: -1 },
    { appendLog: 'file' },
  ])
    assert.throws(() =>
      createNetworkComparisonProxy({ ...configuration, ...changes }),
    )
})

test('single arm admits exact 64 KiB and emits only those bytes plus one LF', async () => {
  const content = Buffer.concat([
    documents[0],
    Buffer.alloc(65536 - documents[0].length, ' '),
  ])
  await usingFixture({ documents: [content] }, async (owned) => {
    await owned.prepare()
    const result = await owned.part(0).completion
    assert.equal(result.status, 200)
    assert.equal(result.body.length, 65537)
    assert.deepEqual(result.body.subarray(0, -1), content)
    assert.equal(result.body.at(-1), 10)
    assert.deepEqual(JSON.parse(result.headers['x-synloquent-part-index']), [
      owned.identities[0],
    ])
    assert.equal(
      owned.observed.filter((observed) => observed.path.includes('/parts/'))
        .length,
      1,
    )
    assert.equal(owned.logs.at(-1).upstreamBodyBytes, 65536)
  })
})

test('bundle arm streams exact 1 MiB and preserves all sixteen truthful index entries', async () => {
  const content = Buffer.concat([
    documents[0],
    Buffer.alloc(65535 - documents[0].length, ' '),
  ])
  await usingFixture(
    { arm: 'bundle', documents: Array.from({ length: 16 }, () => content) },
    async (owned) => {
      await owned.prepare()
      const result = await owned.part(0).completion
      assert.equal(result.status, 200)
      assert.equal(result.body.length, 1048576)
      assert.deepEqual(
        result.body,
        Buffer.concat(
          Array.from({ length: 16 }, () =>
            Buffer.concat([content, Buffer.from('\n')]),
          ),
        ),
      )
      assert.deepEqual(
        JSON.parse(result.headers['x-synloquent-part-index']),
        owned.identities,
      )
      assert.equal(owned.logs.at(-1).parts, 16)
      assert.equal(owned.logs.at(-1).upstreamBodyBytes, 1048576)
    },
  )
})

for (const [name, headers, content] of [
  [
    'declared oversized bundle',
    { 'Content-Length': 1048577 },
    Buffer.alloc(1048577),
  ],
  [
    'seventeen index entries',
    {
      'X-Synloquent-Part-Index': JSON.stringify(
        Array.from({ length: 17 }, () => identities[0]),
      ),
    },
    documents[0],
  ],
  [
    'index above 16 KiB',
    {
      'X-Synloquent-Part-Index':
        '[' + ' '.repeat(16384) + JSON.stringify(identities).slice(1),
    },
    documents[0],
  ],
  [
    'foreign first part hash',
    {
      'X-Synloquent-Part-Index': JSON.stringify([
        { ...identities[0], hash: 'd'.repeat(64) },
        identities[1],
      ]),
    },
    documents[0],
  ],
])
  test(`bundle rejects ${name} before streaming successful body bytes`, async () => {
    await usingFixture(
      {
        arm: 'bundle',
        respond(incoming, response) {
          if (!incoming.url.includes('/parts/')) return false
          response.writeHead(200, {
            'Content-Type': 'application/x-ndjson',
            'X-Synloquent-Part-Index': JSON.stringify(identities),
            'X-Synloquent-Confirmation-Token': 'final-confirmation',
            ...headers,
          })
          response.end(content)
          return true
        },
      },
      async (owned) => {
        await owned.prepare()
        const result = await owned.part(0).completion
        assert.equal(result.status, 502)
        assert.equal(owned.proxy.metrics().retainedIdentities, 1)
        assert.equal(owned.logs.at(-1).upstreamBodyBytes, 0)
      },
    )
  })

test('streamed oversized bundle closes the response and cannot advance its continuation', async () => {
  await usingFixture(
    {
      arm: 'bundle',
      respond(incoming, response) {
        if (!incoming.url.includes('/parts/')) return false
        response.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'X-Synloquent-Part-Index': JSON.stringify(identities),
          'X-Synloquent-Confirmation-Token': 'final-confirmation',
        })
        response.write(Buffer.alloc(1048576))
        response.end(Buffer.from('x'))
        return true
      },
    },
    async (owned) => {
      await owned.prepare()
      await assert.rejects(owned.part(0).completion)
      await waitFor(() => owned.proxy.metrics().activeRequests === 0)
      assert.equal(owned.proxy.metrics().retainedIdentities, 1)
      assert.equal(
        owned.logs.at(-1).error,
        'Network comparison proxy: Upstream body byte bound exceeded.',
      )
    },
  )
})

test('next boundary with an out-of-order ordinal is rejected without moving the expected identity', async () => {
  await usingFixture(
    {
      respond(incoming, response) {
        if (!incoming.url.includes('/parts/')) return false
        response.writeHead(200, {
          'X-Synloquent-Next-Part': JSON.stringify({
            ...identities[1],
            ordinal: 0,
          }),
        })
        response.end(documents[0])
        return true
      },
    },
    async (owned) => {
      await owned.prepare()
      assert.equal((await owned.part(0).completion).status, 502)
      assert.equal(owned.proxy.metrics().retainedIdentities, 1)
    },
  )
})

test('prepare with a different returned session fails without retaining acquisition state', async () => {
  await usingFixture(
    {
      respond(incoming, response) {
        if (incoming.url !== '/synloquent/v1/protocol') return false
        response.writeHead(200)
        response.end(
          JSON.stringify({
            ...envelope,
            session: { ...session, tenantId: 'foreign-tenant' },
            payload: descriptor,
          }),
        )
        return true
      },
    },
    async (owned) => {
      const result = await owned.call('/network-proxy/synloquent/v1/protocol', {
        method: 'POST',
        body: envelope,
      }).completion
      assert.equal(result.status, 502)
      assert.equal(owned.proxy.metrics().retainedIdentities, 0)
      assert.equal((await owned.part(0).completion).status, 502)
      assert.equal(owned.observed.length, 1)
    },
  )
})

test('empty descriptor still requires a real upstream final confirmation', async () => {
  const empty = {
    ...descriptor,
    partCount: 0,
    recordCount: 0,
    relationSetCount: 0,
    confirmationToken: 'empty-confirmation',
  }
  delete empty.firstPart
  await usingFixture({ descriptor: empty }, async (owned) => {
    await owned.prepare()
    const result = await owned.call(`/network-proxy${base}/confirm`, {
      method: 'POST',
      body: { confirmationToken: 'empty-confirmation' },
    }).completion
    assert.equal(result.status, 200)
    assert.equal(JSON.parse(result.body).confirmed, true)
    assert.deepEqual(
      owned.observed.map((observed) => observed.path),
      ['/synloquent/v1/protocol', `${base}/confirm`],
    )
    assert.equal(owned.proxy.metrics().parts, 0)
  })
})

test('close drains an active upstream socket before a replacement helper is created', async () => {
  await usingFixture(
    {
      respond(incoming, response) {
        if (!incoming.url.includes('/parts/')) return false
        response.writeHead(200, {
          'X-Synloquent-Next-Part': JSON.stringify(identities[1]),
        })
        response.flushHeaders()
        return true
      },
    },
    async (owned) => {
      await owned.prepare()
      const outgoing = owned.part(0)
      const rejected = assert.rejects(outgoing.completion)
      await waitFor(() => owned.observed.length === 2)
      await owned.proxy.close()
      await rejected
      assert.equal(owned.proxy.metrics().activeRequests, 0)
      assert.equal(owned.proxy.metrics().activeTimers, 0)
      assert.equal(owned.proxy.metrics().upstreamSockets, 0)
      await usingFixture({}, async (replacement) => {
        await replacement.prepare()
        assert.equal((await replacement.part(0).completion).status, 200)
        assert.equal(owned.observed.length, 2)
      })
    },
  )
})

test('malformed continuation metadata does not expose its token in diagnostics', async () => {
  const privateToken = 'private-malformed-token-control'
  await usingFixture(
    {
      respond(incoming, response) {
        if (!incoming.url.includes('/parts/')) return false
        response.writeHead(200, {
          'X-Synloquent-Next-Part': `{"continuation":"${privateToken}"`,
        })
        response.end(documents[0])
        return true
      },
    },
    async (owned) => {
      await owned.prepare()
      const result = await owned.part(0).completion
      assert.equal(result.status, 502)
      assert(!result.body.toString().includes(privateToken))
      assert(!JSON.stringify(owned.logs).includes(privateToken))
      assert.equal(owned.logs.at(-1).error, 'Malformed bounded JSON.')
    },
  )
})

test('server confirmation failure is forwarded unchanged and never synthesized as confirmed', async () => {
  const failure = Buffer.from(
    '{"error":{"code":"forbidden_operation","message":"Final authorization changed"}}',
  )
  await usingFixture(
    {
      arm: 'bundle',
      respond(incoming, response) {
        if (!incoming.url.endsWith('/confirm')) return false
        response.writeHead(403, {
          'Content-Type': 'application/json',
          'Content-Length': failure.length,
          'X-Confirmation-Witness': 'original-failure',
        })
        response.end(failure)
        return true
      },
    },
    async (owned) => {
      await owned.prepare()
      await owned.part(0).completion
      const result = await owned.call(`/network-proxy${base}/confirm`, {
        method: 'POST',
        body: { confirmationToken: 'final-confirmation' },
      }).completion
      assert.equal(result.status, 403)
      assert.deepEqual(result.body, failure)
      assert.equal(result.headers['x-confirmation-witness'], 'original-failure')
      assert.equal(owned.logs.at(-1).confirmed, undefined)
      assert.equal(owned.proxy.metrics().confirmRequests, 1)
      assert.equal(owned.proxy.metrics().upstreamErrorResponses, 1)
    },
  )
})
