import { createHash } from 'node:crypto'
import { Agent, request as upstreamRequest } from 'node:http'
import { performance } from 'node:perf_hooks'
import { URL } from 'node:url'

const prefix = '/network-proxy'
const protocolPrefix = '/synloquent/v1/'
const maximumRequestBytes = 1048576
const maximumDescriptorBytes = 16384
const maximumPartBytes = 65536
const maximumBundleBytes = 1048576
const maximumActiveRequests = 1
const maximumHeaderBytes = 65536
const maximumLogBytes = 16384
const identityFields = [
  'ordinal',
  'downloadUrl',
  'hash',
  'byteSize',
  'continuation',
]
const hopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const hash = (value) => createHash('sha256').update(value).digest('hex')
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const boundedString = (value, maximum = 4096) =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= maximum
const integer = (value, maximum) =>
  Number.isSafeInteger(value) && value >= 0 && value <= maximum
function sessionDigest(session) {
  const fields = ['accountId', 'tenantId', 'deviceId', 'deviceEpoch']
  if (
    !object(session) ||
    !fields.every((field) => boundedString(session[field], 1024)) ||
    !integer(session.generation, 2147483647)
  )
    throw diagnostic('Invalid bounded session identity.')
  return hash(
    JSON.stringify([
      ...fields.map((field) => session[field]),
      session.generation,
    ]),
  )
}
function diagnostic(message) {
  return new Error(`Network comparison proxy: ${message}`)
}
function normalizedHeaderBytes(fields) {
  let bytes = 0
  for (let index = 0; index < fields.length; index += 2)
    bytes += Buffer.byteLength(`${fields[index]}: ${fields[index + 1]}\r\n`)
  return bytes
}
function forwardedHeaders(fields) {
  const removed = new Set(hopHeaders)
  for (let index = 0; index < fields.length; index += 2)
    if (fields[index].toLowerCase() === 'connection')
      for (const name of fields[index + 1].split(','))
        removed.add(name.trim().toLowerCase())
  const result = []
  for (let index = 0; index < fields.length; index += 2)
    if (!removed.has(fields[index].toLowerCase()))
      result.push(fields[index], fields[index + 1])
  return result
}
function replaceHeader(fields, name, value) {
  const result = []
  for (let index = 0; index < fields.length; index += 2)
    if (fields[index].toLowerCase() !== name.toLowerCase())
      result.push(fields[index], fields[index + 1])
  result.push(name, value)
  return result
}
function parseIdentity(value, ordinal, generation, catalogHash) {
  if (
    !object(value) ||
    Object.keys(value).length !== 5 ||
    !identityFields.every((field) => Object.hasOwn(value, field)) ||
    !integer(value.ordinal, 599999) ||
    value.ordinal !== ordinal ||
    value.downloadUrl !==
      `/synloquent/v1/snapshots/${generation}/${catalogHash}/parts/${ordinal}` ||
    !boundedString(value.continuation) ||
    !boundedString(value.hash, 64) ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    !integer(value.byteSize, maximumPartBytes) ||
    value.byteSize === 0
  )
    throw diagnostic('Invalid server part identity.')
  return value
}
function sameIdentity(left, right) {
  return identityFields.every((field) => left[field] === right[field])
}
function scalarIdentity(identity) {
  return {
    ordinal: identity.ordinal,
    hash: identity.hash,
    byteSize: identity.byteSize,
    continuationDigest: hash(identity.continuation),
  }
}
function responseIdentity(state, headers, nextOrdinal) {
  const nextText = headers['x-synloquent-next-part']
  const confirmation = headers['x-synloquent-confirmation-token']
  if (nextOrdinal < state.partCount) {
    if (
      !boundedString(nextText, maximumDescriptorBytes) ||
      confirmation !== undefined
    )
      throw diagnostic('Invalid next part boundary.')
    return {
      next: parseIdentity(
        JSON.parse(nextText),
        nextOrdinal,
        state.generation,
        state.hash,
      ),
      confirmationDigest: null,
    }
  }
  if (
    nextOrdinal !== state.partCount ||
    nextText !== undefined ||
    !boundedString(confirmation, 2048)
  )
    throw diagnostic('Invalid final confirmation boundary.')
  return { next: null, confirmationDigest: hash(confirmation) }
}

/** Owns only a loopback upstream agent and per-request work, never a server. */
export function createNetworkComparisonProxy(options) {
  const configuration = Object.freeze({ ...options })
  const upstream = new URL(
    configuration.upstreamOrigin ?? 'http://127.0.0.1:8766',
  )
  if (
    upstream.protocol !== 'http:' ||
    upstream.hostname !== '127.0.0.1' ||
    !upstream.port ||
    upstream.username ||
    upstream.password ||
    upstream.pathname !== '/' ||
    upstream.search ||
    upstream.hash
  )
    throw diagnostic('A pinned loopback upstream origin is required.')
  if (
    !['single', 'bundle'].includes(configuration.arm) ||
    !['ios', 'android'].includes(configuration.platform) ||
    !boundedString(configuration.runIdentity, 256) ||
    !integer(configuration.controlledDelayMilliseconds, 10000) ||
    (configuration.appendLog !== undefined &&
      typeof configuration.appendLog !== 'function')
  )
    throw diagnostic('Invalid diagnostic configuration.')
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 })
  const work = new Set()
  const timers = new Set()
  const sockets = new Map()
  const totals = {
    requests: 0,
    prepareRequests: 0,
    partRequests: 0,
    confirmRequests: 0,
    otherRequests: 0,
    completed: 0,
    upstreamErrorResponses: 0,
    failed: 0,
    cancelled: 0,
    forwardedRequestHeaderBytes: 0,
    requestBodyBytes: 0,
    upstreamBodyBytes: 0,
    deliveredBodyBytes: 0,
    requestHeaderBytes: 0,
    upstreamHeaderBytes: 0,
    deliveredHeaderBytes: 0,
    controlledDelayMilliseconds: 0,
    upstreamWallMilliseconds: 0,
    parts: 0,
  }
  let acquisition
  let snapshotActive = false
  let closed = false
  let closing

  function trackSocket(socket) {
    if (sockets.has(socket)) return
    const ended = new Promise((resolve) =>
      socket.once('close', () => {
        sockets.delete(socket)
        resolve()
      }),
    )
    sockets.set(socket, ended)
  }
  function failResponse(response, message, status = 502) {
    if (response.destroyed || response.writableEnded) return
    if (response.headersSent) {
      response.destroy()
      return
    }
    const body = Buffer.from(
      JSON.stringify({ error: { code: 'diagnostic_proxy_failed', message } }),
    )
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'Cache-Control': 'private, no-store',
    })
    response.end(body)
  }
  function record(measurement) {
    if (Buffer.byteLength(JSON.stringify(measurement)) > maximumLogBytes)
      throw diagnostic('Diagnostic log byte bound exceeded.')
    totals[`${measurement.category}Requests`]++
    if (measurement.status >= 400) totals.upstreamErrorResponses++
    totals[
      measurement.cancelled
        ? 'cancelled'
        : measurement.error
          ? 'failed'
          : 'completed'
    ]++
    for (const name of [
      'requestBodyBytes',
      'upstreamBodyBytes',
      'deliveredBodyBytes',
      'requestHeaderBytes',
      'forwardedRequestHeaderBytes',
      'upstreamHeaderBytes',
      'deliveredHeaderBytes',
      'controlledDelayMilliseconds',
      'upstreamWallMilliseconds',
      'parts',
    ])
      totals[name] += measurement[name] ?? 0
    const result = configuration.appendLog?.(Object.freeze(measurement))
    if (result && typeof result.then === 'function')
      throw diagnostic('appendLog must be synchronous.')
  }
  async function handle(incoming, response) {
    if (
      typeof incoming.url !== 'string' ||
      !incoming.url.startsWith(`${prefix}${protocolPrefix}`)
    )
      return false
    if (!boundedString(incoming.url)) {
      failResponse(response, 'Public path byte bound exceeded.')
      return true
    }
    if (closed) {
      failResponse(response, 'The diagnostic proxy is closed.', 503)
      return true
    }
    if (work.size >= maximumActiveRequests) {
      failResponse(
        response,
        'The diagnostic proxy work bound was exceeded.',
        409,
      )
      return true
    }
    const path = incoming.url.slice(prefix.length)
    const partRoute =
      /^\/synloquent\/v1\/snapshots\/([a-f0-9]{64})\/([a-f0-9]{64})\/parts\/([0-9]{1,6})\/bundle$/.exec(
        path,
      )
    const confirmRoute =
      /^\/synloquent\/v1\/snapshots\/([a-f0-9]{64})\/([a-f0-9]{64})\/confirm$/.exec(
        path,
      )
    const snapshotRequest = partRoute !== null || confirmRoute !== null
    if (path.startsWith('/synloquent/v1/snapshots/') && !snapshotRequest) {
      failResponse(
        response,
        'Only prepared ordered bundle requests and final confirmation are supported.',
      )
      return true
    }
    let snapshotOwned = snapshotRequest
    if (snapshotRequest && snapshotActive) {
      failResponse(response, 'A snapshot request is already active.', 409)
      return true
    }
    if (snapshotRequest) snapshotActive = true
    let settle
    const ended = new Promise((resolve) => {
      settle = resolve
    })
    const controller = new globalThis.AbortController()
    const current = {
      ended,
      cancel() {
        controller.abort()
        response.destroy()
        incoming.destroy()
      },
    }
    work.add(current)
    const measurement = {
      runIdentity: configuration.runIdentity,
      platform: configuration.platform,
      arm: configuration.arm,
      sequence: ++totals.requests,
      publicPath: incoming.url,
      upstreamPath: path,
      category: partRoute ? 'part' : confirmRoute ? 'confirm' : 'other',
      arrivedMilliseconds: performance.now(),
      requestBodyBytes: 0,
      upstreamBodyBytes: 0,
      deliveredBodyBytes: 0,
      requestHeaderBytes: normalizedHeaderBytes(incoming.rawHeaders),
      upstreamHeaderBytes: 0,
      deliveredHeaderBytes: 0,
      parts: 0,
      transformWallMilliseconds: 0,
      backendCpuMilliseconds: null,
      requestLineBytes: Buffer.byteLength(
        `${incoming.method} ${incoming.url} HTTP/1.1\r\n`,
      ),
    }
    let request
    let received
    let abortListener
    let preparedAcquisition
    let clearAcquisition = false
    const abort = () => {
      if (!response.writableFinished) controller.abort()
    }
    incoming.once('aborted', abort)
    response.once('close', abort)
    try {
      const buffers = []
      for await (const chunk of incoming) {
        measurement.requestBodyBytes += chunk.length
        if (measurement.requestBodyBytes > maximumRequestBytes)
          throw diagnostic('Request byte bound exceeded.')
        buffers.push(chunk)
      }
      const body = Buffer.concat(buffers)
      buffers.length = 0
      let envelope
      if (incoming.method === 'POST' && path === '/synloquent/v1/protocol') {
        envelope = JSON.parse(body.toString('utf8'))
        if (envelope?.kind === 'snapshot') {
          if (envelope?.payload?.delivery !== 'parts-v1')
            throw diagnostic('Only bounded snapshot delivery is supported.')
          measurement.category = 'prepare'
          if (snapshotActive)
            throw diagnostic('A snapshot request is already active.')
          snapshotActive = true
          snapshotOwned = true
        }
      }
      if (
        normalizedHeaderBytes(incoming.rawHeaders) > maximumHeaderBytes ||
        incoming.rawHeaders.filter(
          (field, index) =>
            index % 2 === 0 && field.toLowerCase() === 'authorization',
        ).length !== 1
      )
        throw diagnostic('Invalid bounded request headers.')
      const authorization = incoming.headers.authorization
      if (
        typeof authorization !== 'string' ||
        !boundedString(authorization, 8192)
      )
        throw diagnostic('A bounded authenticated request is required.')
      const authorizationDigest = hash(authorization)
      measurement.authorizationDigest = authorizationDigest
      if (snapshotRequest) {
        if (
          !acquisition ||
          authorizationDigest !== acquisition.authorizationDigest ||
          (partRoute ?? confirmRoute)[1] !== acquisition.generation ||
          (partRoute ?? confirmRoute)[2] !== acquisition.hash
        )
          throw diagnostic(
            'The acquisition session or catalog identity changed.',
          )
        if (partRoute) {
          if (
            incoming.method !== 'GET' ||
            body.length ||
            !acquisition.next ||
            Number(partRoute[3]) !== acquisition.next.ordinal ||
            hash(
              String(incoming.headers['x-synloquent-continuation'] ?? ''),
            ) !== hash(acquisition.next.continuation)
          )
            throw diagnostic('The continuation is unknown or out of order.')
          measurement.firstPart = scalarIdentity(acquisition.next)
          if (configuration.arm === 'single')
            measurement.upstreamPath = path.replace(/\/bundle$/, '')
        } else {
          const confirmation = JSON.parse(body.toString('utf8'))
          if (
            incoming.method !== 'POST' ||
            !object(confirmation) ||
            Object.keys(confirmation).length !== 1 ||
            !boundedString(confirmation.confirmationToken, 2048) ||
            acquisition.next !== null ||
            hash(confirmation.confirmationToken) !==
              acquisition.confirmationDigest
          )
            throw diagnostic('The final confirmation token is unknown.')
          measurement.confirmationTokenDigest = hash(
            confirmation.confirmationToken,
          )
        }
      }
      if (controller.signal.aborted) throw diagnostic('Request cancelled.')
      measurement.delayStartedMilliseconds = performance.now()
      await new Promise((resolve, reject) => {
        let timer
        const cancelled = () => {
          clearTimeout(timer)
          timers.delete(timer)
          reject(diagnostic('Request cancelled.'))
        }
        timer = setTimeout(() => {
          timers.delete(timer)
          controller.signal.removeEventListener('abort', cancelled)
          resolve()
        }, configuration.controlledDelayMilliseconds)
        timers.add(timer)
        controller.signal.addEventListener('abort', cancelled, { once: true })
      })
      measurement.delayFinishedMilliseconds = performance.now()
      measurement.controlledDelayMilliseconds =
        measurement.delayFinishedMilliseconds -
        measurement.delayStartedMilliseconds
      measurement.upstreamRequestCreatedMilliseconds = performance.now()
      let headers = forwardedHeaders(incoming.rawHeaders)
      headers = replaceHeader(headers, 'Host', upstream.host)
      headers = replaceHeader(headers, 'Content-Length', String(body.length))
      measurement.forwardedRequestHeaderBytes = normalizedHeaderBytes(headers)
      measurement.upstreamRequestLineBytes = Buffer.byteLength(
        `${incoming.method} ${measurement.upstreamPath} HTTP/1.1\r\n`,
      )
      received = await new Promise((resolve, reject) => {
        request = upstreamRequest(
          upstream,
          {
            method: incoming.method,
            path: measurement.upstreamPath,
            headers,
            agent,
            maxHeaderSize: maximumHeaderBytes,
          },
          resolve,
        )
        request.once('socket', trackSocket)
        request.once('finish', () => {
          measurement.dispatchedMilliseconds = performance.now()
        })
        request.once('error', reject)
        request.setTimeout(30000, () =>
          request.destroy(diagnostic('Upstream request deadline exceeded.')),
        )
        abortListener = () => request.destroy(diagnostic('Request cancelled.'))
        controller.signal.addEventListener('abort', abortListener, {
          once: true,
        })
        if (controller.signal.aborted) abortListener()
        else request.end(body)
      })
      measurement.headersMilliseconds = performance.now()
      measurement.status = received.statusCode
      measurement.upstreamHeaderBytes = normalizedHeaderBytes(
        received.rawHeaders,
      )
      measurement.predispatchWallMilliseconds =
        measurement.dispatchedMilliseconds - measurement.arrivedMilliseconds
      if (measurement.upstreamHeaderBytes > maximumHeaderBytes)
        throw diagnostic('Upstream header byte bound exceeded.')
      const encoding = received.headers['content-encoding']
      if (received.statusCode >= 300 && received.statusCode < 400)
        throw diagnostic('Upstream redirects are unsupported.')
      if (encoding !== undefined && encoding !== 'identity')
        throw diagnostic('Encoded upstream bodies are unsupported.')
      const prepare =
        measurement.category === 'prepare' && received.statusCode === 200
      const single =
        partRoute &&
        configuration.arm === 'single' &&
        received.statusCode === 200
      const confirmation = confirmRoute && received.statusCode === 200
      const captured = prepare || single || confirmation
      const maximum =
        prepare || confirmation
          ? maximumDescriptorBytes
          : single
            ? maximumPartBytes
            : maximumBundleBytes
      const declared = received.headers['content-length']
      if (
        declared !== undefined &&
        (!/^\d+$/.test(declared) || Number(declared) > maximum)
      )
        throw diagnostic('Upstream body byte bound exceeded.')
      let responseHeaders = forwardedHeaders(received.rawHeaders)
      let boundary
      if (partRoute && received.statusCode === 200) {
        const first = acquisition.next
        if (single) {
          measurement.parts = 1
          boundary = responseIdentity(
            acquisition,
            received.headers,
            first.ordinal + 1,
          )
        } else {
          const indexText = received.headers['x-synloquent-part-index']
          if (!boundedString(indexText, maximumDescriptorBytes))
            throw diagnostic('Bundle index byte bound exceeded.')
          const index = JSON.parse(indexText)
          if (!Array.isArray(index) || index.length < 1 || index.length > 16)
            throw diagnostic('Bundle index count is invalid.')
          for (let offset = 0; offset < index.length; offset++)
            parseIdentity(
              index[offset],
              first.ordinal + offset,
              acquisition.generation,
              acquisition.hash,
            )
          if (!sameIdentity(index[0], first))
            throw diagnostic('Bundle first identity changed.')
          measurement.parts = index.length
          measurement.partIdentities = index.map(scalarIdentity)
          measurement.indexBytes = Buffer.byteLength(indexText)
          boundary = responseIdentity(
            acquisition,
            received.headers,
            first.ordinal + index.length,
          )
        }
      }
      if (!captured) {
        measurement.deliveredHeaderBytes =
          normalizedHeaderBytes(responseHeaders)
        response.writeHead(
          received.statusCode,
          received.statusMessage,
          responseHeaders,
        )
      }
      const capturedBuffers = []
      const bodyHash = createHash('sha256')
      for await (const chunk of received) {
        if (controller.signal.aborted) throw diagnostic('Request cancelled.')
        measurement.upstreamBodyBytes += chunk.length
        if (measurement.upstreamBodyBytes > maximum)
          throw diagnostic('Upstream body byte bound exceeded.')
        bodyHash.update(chunk)
        if (captured) capturedBuffers.push(chunk)
        else {
          measurement.deliveredBodyBytes += chunk.length
          if (!response.write(chunk))
            await new Promise((resolve, reject) => {
              const clear = () => {
                response.off('drain', drained)
                controller.signal.removeEventListener('abort', cancelled)
              }
              const drained = () => {
                clear()
                resolve()
              }
              const cancelled = () => {
                clear()
                reject(diagnostic('Request cancelled.'))
              }
              response.once('drain', drained)
              controller.signal.addEventListener('abort', cancelled, {
                once: true,
              })
              if (controller.signal.aborted) cancelled()
            })
        }
      }
      measurement.upstreamFinishedMilliseconds = performance.now()
      measurement.upstreamWallMilliseconds =
        measurement.upstreamFinishedMilliseconds -
        measurement.dispatchedMilliseconds
      measurement.upstreamBodyHash = bodyHash.digest('hex')
      if (captured) {
        const content = Buffer.concat(capturedBuffers)
        capturedBuffers.length = 0
        const transformStarted = performance.now()
        if (prepare) {
          const document = JSON.parse(content.toString('utf8'))
          const descriptor = document?.payload
          if (
            !object(document) ||
            document.kind !== 'snapshot' ||
            document.requestId !== envelope.requestId ||
            sessionDigest(document.session) !==
              sessionDigest(envelope.session) ||
            !object(descriptor) ||
            descriptor.format !== 'canonical-parts-v1' ||
            !['ready', 'admission-required'].includes(descriptor.status)
          )
            throw diagnostic('Invalid prepare identity.')
          if (descriptor.status === 'ready') {
            if (
              !boundedString(descriptor.schemaFingerprint, 64) ||
              !/^[a-f0-9]{64}$/.test(descriptor.schemaFingerprint) ||
              descriptor.schemaFingerprint !== envelope.schemaFingerprint ||
              !boundedString(descriptor.dataset, 256) ||
              descriptor.dataset !== envelope.payload.dataset ||
              !boundedString(descriptor.cursor) ||
              !object(descriptor.scope) ||
              Buffer.byteLength(JSON.stringify(descriptor.scope)) >
                maximumDescriptorBytes ||
              !boundedString(descriptor.generation, 64) ||
              !/^[a-f0-9]{64}$/.test(descriptor.generation) ||
              !boundedString(descriptor.hash, 64) ||
              !/^[a-f0-9]{64}$/.test(descriptor.hash) ||
              !integer(descriptor.partCount, 600000) ||
              !integer(descriptor.recordCount, 500000) ||
              !integer(descriptor.relationSetCount, 100000) ||
              !integer(descriptor.byteSize, 536870912) ||
              descriptor.maximumPartBytes !== maximumPartBytes ||
              descriptor.partRowLimit !== 256
            )
              throw diagnostic('Invalid prepare descriptor.')
            const next = descriptor.partCount
              ? parseIdentity(
                  descriptor.firstPart,
                  0,
                  descriptor.generation,
                  descriptor.hash,
                )
              : null
            if (!next && !boundedString(descriptor.confirmationToken, 2048))
              throw diagnostic('Missing empty confirmation.')
            preparedAcquisition = {
              generation: descriptor.generation,
              hash: descriptor.hash,
              partCount: descriptor.partCount,
              authorizationDigest,
              sessionDigest: sessionDigest(envelope.session),
              next,
              confirmationDigest: next
                ? null
                : hash(descriptor.confirmationToken),
            }
            measurement.descriptor = {
              generation: descriptor.generation,
              hash: descriptor.hash,
              byteSize: descriptor.byteSize,
              schemaFingerprint: descriptor.schemaFingerprint,
              partCount: descriptor.partCount,
              recordCount: descriptor.recordCount,
              relationSetCount: descriptor.relationSetCount,
              sessionDigest: preparedAcquisition.sessionDigest,
              cursorDigest: hash(descriptor.cursor),
              scopeDigest: hash(
                JSON.stringify(
                  Object.entries(descriptor.scope).sort(([left], [right]) =>
                    left.localeCompare(right),
                  ),
                ),
              ),
            }
          } else clearAcquisition = true
        } else if (single) {
          if (
            content.length !== acquisition.next.byteSize ||
            measurement.upstreamBodyHash !== acquisition.next.hash
          )
            throw diagnostic(
              'Single part bytes contradict their server identity.',
            )
          const indexText = JSON.stringify([acquisition.next])
          if (Buffer.byteLength(indexText) > maximumDescriptorBytes)
            throw diagnostic('Single index byte bound exceeded.')
          responseHeaders = replaceHeader(
            responseHeaders,
            'Content-Type',
            'application/x-ndjson',
          )
          responseHeaders = replaceHeader(
            responseHeaders,
            'Content-Length',
            String(content.length + 1),
          )
          responseHeaders = replaceHeader(
            responseHeaders,
            'X-Synloquent-Part-Index',
            indexText,
          )
          measurement.indexBytes = Buffer.byteLength(indexText)
        } else {
          const document = JSON.parse(content.toString('utf8'))
          if (
            document.confirmed !== true ||
            document.generation !== acquisition.generation ||
            document.hash !== acquisition.hash
          )
            throw diagnostic('Invalid final server confirmation.')
          measurement.confirmed = true
        }
        measurement.transformWallMilliseconds =
          performance.now() - transformStarted
        measurement.deliveredHeaderBytes =
          normalizedHeaderBytes(responseHeaders)
        response.writeHead(
          received.statusCode,
          received.statusMessage,
          responseHeaders,
        )
        response.write(content)
        if (single) response.write('\n')
        measurement.deliveredBodyBytes = content.length + (single ? 1 : 0)
      }
      await new Promise((resolve, reject) => {
        const clear = () => {
          response.off('finish', finished)
          controller.signal.removeEventListener('abort', cancelled)
        }
        const finished = () => {
          clear()
          resolve()
        }
        const cancelled = () => {
          clear()
          reject(diagnostic('Request cancelled.'))
        }
        response.once('finish', finished)
        controller.signal.addEventListener('abort', cancelled, { once: true })
        response.end()
        if (controller.signal.aborted) cancelled()
      })
      if (preparedAcquisition) acquisition = preparedAcquisition
      if (clearAcquisition) acquisition = undefined
      if (boundary) {
        acquisition.next = boundary.next
        acquisition.confirmationDigest = boundary.confirmationDigest
        measurement.nextOrdinal = boundary.next?.ordinal ?? null
        if (boundary.next)
          measurement.nextPartIdentity = scalarIdentity(boundary.next)
        else measurement.confirmationTokenDigest = boundary.confirmationDigest
      }
    } catch (failure) {
      measurement.cancelled = controller.signal.aborted
      measurement.error =
        failure instanceof SyntaxError
          ? 'Malformed bounded JSON.'
          : failure instanceof Error
            ? failure.message.slice(0, 512)
            : 'Unknown proxy failure.'
      if (!measurement.cancelled) failResponse(response, measurement.error)
    } finally {
      if (abortListener)
        controller.signal.removeEventListener('abort', abortListener)
      incoming.off('aborted', abort)
      response.off('close', abort)
      if (received && !received.complete) received.destroy()
      if (request && !request.destroyed && !received?.complete)
        request.destroy()
      measurement.finishedMilliseconds = performance.now()
      try {
        record(measurement)
      } finally {
        if (snapshotOwned) snapshotActive = false
        work.delete(current)
        settle()
      }
    }
    return true
  }
  function close() {
    if (closing) return closing
    closed = true
    acquisition = undefined
    const pending = [...work]
    for (const current of pending) current.cancel()
    agent.destroy()
    closing = (async () => {
      await Promise.all(pending.map((current) => current.ended))
      agent.destroy()
      await Promise.all([...sockets.values()])
    })()
    return closing
  }
  return {
    handle,
    close,
    metrics() {
      return {
        ...totals,
        activeRequests: work.size,
        activeTimers: timers.size,
        upstreamSockets: sockets.size,
        snapshotActive,
        closed,
        retainedIdentities: acquisition?.next ? 1 : 0,
        measurement:
          'Controlled local per-request dispatch delay and upstream wall, not real WAN RTT or backend CPU',
      }
    },
  }
}
