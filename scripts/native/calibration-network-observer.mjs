import { createHash } from 'node:crypto'
import { request as requestHttp } from 'node:http'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { URL } from 'node:url'

/** Prepared transparent schema2 observer. Every body is streamed exactly once. */
export function createCalibrationNetworkObserver({
  sessionName,
  appendRecord,
  fail,
}) {
  const upstreams = new Map([
    ['/calibration-backend', 'http://127.0.0.1:8765'],
    ['/calibration-large', 'http://127.0.0.1:8766'],
  ])
  const active = new Map()
  const sockets = new Set()
  let retentionFailure = null
  let sequence = 0
  let closed = false
  let failed = 0
  let cancelled = 0
  let completed = 0
  const clock = () => ({
    hostUtc: new Date().toISOString(),
    hostMonotonicMilliseconds: performance.now(),
  })
  appendRecord({
    kind: 'observer-configuration',
    sessionName,
    sequence: 0,
    ...clock(),
    upstreams: [...upstreams],
    artificialDelayMilliseconds: 0,
    bodyPolicy:
      'one stream read, exact payload bytes, scalar byte counts and SHA256',
    maximumActiveRequests: 16,
    maximumPayloadBytesPerStream: 512 * 1024 ** 2,
    serverStageAuthority:
      'only original upstream response headers when actually present',
  })
  async function handle(incoming, outgoing) {
    const mapping = [...upstreams].find(
      ([prefix]) =>
        incoming.url === prefix || incoming.url.startsWith(prefix + '/'),
    )
    if (!mapping) return false
    const identifier = ++sequence
    const [prefix, origin] = mapping
    const path = incoming.url.slice(prefix.length) || '/'
    const started = clock()
    const requestHash = createHash('sha256')
    const responseHash = createHash('sha256')
    let requestBytes = 0
    let responseBytes = 0
    let responseStatus = null
    let responseHeaders = null
    let upstream
    let responseStream
    let settled = false
    let failure = null
    let aborted = false
    let finishRequest
    const finished = new Promise((resolveFinish) => {
      finishRequest = resolveFinish
    })
    const record = {
      identifier,
      incoming,
      outgoing,
      cancel(reason) {
        aborted = true
        failure ??= reason
        upstream?.destroy(new Error(reason))
        responseStream?.destroy(new Error(reason))
        incoming.destroy(new Error(reason))
        outgoing.destroy(new Error(reason))
      },
      finished,
    }
    function retain(kind, detail) {
      appendRecord({
        kind,
        sequence: identifier,
        sessionName,
        ...clock(),
        ...detail,
      })
    }
    async function writeChunk(stream, chunk) {
      if (stream.destroyed)
        throw new Error(
          'Original owned HTTP stream closed before its payload settled.',
        )
      if (stream.write(chunk)) return
      await new Promise((resolveDrain, rejectDrain) => {
        const done = (error) => {
          stream.off('drain', drain)
          stream.off('error', errorEvent)
          stream.off('close', close)
          if (error) rejectDrain(error)
          else resolveDrain()
        }
        const drain = () => done()
        const errorEvent = (error) => done(error)
        const close = () =>
          done(
            new Error('Original owned HTTP stream closed during backpressure.'),
          )
        stream.once('drain', drain)
        stream.once('error', errorEvent)
        stream.once('close', close)
        if (stream.destroyed) close()
      })
    }
    function terminal() {
      if (settled) return
      settled = true
      if (failure) {
        if (aborted) cancelled += 1
        else failed += 1
      } else completed += 1
      const serverStageHeaders = []
      for (
        let index = 0;
        responseHeaders && index < responseHeaders.length;
        index += 2
      )
        if (
          /^(server-timing|x-synloquent-(stage|profile|server).*)$/i.test(
            responseHeaders[index],
          )
        )
          serverStageHeaders.push(
            responseHeaders[index],
            responseHeaders[index + 1],
          )
      try {
        retain('request-completed', {
          method: incoming.method,
          originalUrl: incoming.url,
          upstreamOrigin: origin,
          upstreamPath: path,
          startedAtUtc: started.hostUtc,
          startedAtMonotonicMilliseconds: started.hostMonotonicMilliseconds,
          incomingRawHeaders: incoming.rawHeaders,
          responseStatus,
          responseRawHeaders: responseHeaders,
          requestByteCount: requestBytes,
          requestSha256: requestHash.digest('hex'),
          responseByteCount: responseBytes,
          responseSha256: responseHash.digest('hex'),
          complete: failure === null,
          cancelled: aborted,
          error: failure,
          serverStageHeaders,
          serverStageAvailability: serverStageHeaders.length
            ? 'original headers present'
            : 'unavailable',
        })
      } catch (error) {
        retentionFailure ??= String(error)
        failed += 1
        fail(error)
      } finally {
        active.delete(identifier)
        finishRequest()
      }
    }
    try {
      if (
        closed ||
        active.size >= 16 ||
        !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(
          incoming.method,
        ) ||
        !path.startsWith('/') ||
        path.startsWith('//') ||
        Buffer.byteLength(incoming.url) > 8192 ||
        Buffer.byteLength(incoming.rawHeaders.join('\n')) > 16384
      )
        throw new Error(
          'Closed, unknown or unbounded local schema2 proxy request.',
        )
      active.set(identifier, record)
      const headers = []
      for (let index = 0; index < incoming.rawHeaders.length; index += 2)
        if (incoming.rawHeaders[index].toLowerCase() !== 'host')
          headers.push(
            incoming.rawHeaders[index],
            incoming.rawHeaders[index + 1],
          )
      headers.push('Host', new URL(origin).host)
      retain('request-started', {
        method: incoming.method,
        originalUrl: incoming.url,
        upstreamOrigin: origin,
        upstreamPath: path,
        incomingRawHeaders: incoming.rawHeaders,
        forwardedRawHeaders: headers,
      })
      const upstreamResponse = new Promise(
        (resolveResponse, rejectResponse) => {
          upstream = requestHttp(
            origin,
            { path, method: incoming.method, headers, agent: false },
            resolveResponse,
          )
          upstream.once('error', rejectResponse)
          upstream.once('socket', (socket) => {
            sockets.add(socket)
            socket.once('close', () => sockets.delete(socket))
          })
        },
      )
      upstreamResponse.catch(() => undefined)
      const abort = () =>
        record.cancel('Original app request cancelled before proxy completion.')
      incoming.on('error', () => undefined)
      outgoing.on('error', () => undefined)
      incoming.once('aborted', abort)
      outgoing.once('close', () => {
        if (!outgoing.writableFinished && !settled) abort()
      })
      upstream.setTimeout(60000, () =>
        upstream.destroy(
          new Error(
            'Owned local upstream exceeded its explicit inactivity bound.',
          ),
        ),
      )
      const send = (async () => {
        for await (const chunk of incoming) {
          requestBytes += chunk.length
          if (requestBytes > 512 * 1024 ** 2)
            throw new Error(
              'Original request payload exceeded the bounded stream.',
            )
          requestHash.update(chunk)
          await writeChunk(upstream, chunk)
        }
        upstream.end()
      })()
      send.catch((error) => upstream.destroy(error))
      responseStream = await upstreamResponse
      responseStatus = responseStream.statusCode
      responseHeaders = responseStream.rawHeaders
      if (
        !Number.isInteger(responseStatus) ||
        responseStatus < 100 ||
        responseStatus > 599
      )
        throw new Error('Original upstream response status is unknown.')
      outgoing.writeHead(responseStatus, responseStream.rawHeaders)
      for await (const chunk of responseStream) {
        responseBytes += chunk.length
        if (responseBytes > 512 * 1024 ** 2)
          throw new Error(
            'Original response payload exceeded the bounded stream.',
          )
        responseHash.update(chunk)
        await writeChunk(outgoing, chunk)
      }
      await send
      outgoing.end()
      if (!outgoing.writableFinished) await once(outgoing, 'finish')
      incoming.off('aborted', abort)
    } catch (error) {
      failure ??= String(error)
      upstream?.destroy(error)
      responseStream?.destroy(error)
      if (!outgoing.headersSent)
        outgoing
          .writeHead(502, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: failure }))
      else if (!outgoing.writableFinished) outgoing.destroy(error)
      fail(error)
    } finally {
      terminal()
    }
    return true
  }
  return {
    handle,
    async close() {
      closed = true
      for (const record of active.values())
        record.cancel(
          'Owned schema2 observer closed with unfinished original work.',
        )
      await Promise.all([...active.values()].map((record) => record.finished))
      await Promise.all(
        [...sockets].map(async (socket) => {
          if (socket.closed) return
          const closedSocket = once(socket, 'close')
          socket.destroy()
          await closedSocket
        }),
      )
      appendRecord({
        kind: 'observer-closed',
        sessionName,
        sequence: ++sequence,
        ...clock(),
        completed,
        failed,
        cancelled,
        activeRequests: active.size,
        activeSockets: sockets.size,
        retentionFailure,
        closed: true,
      })
      if (
        active.size ||
        sockets.size ||
        failed ||
        cancelled ||
        retentionFailure
      )
        throw new Error(
          'The complete original HTTP workload lacks successful stream closure.',
        )
      return {
        closed: true,
        activeRequests: 0,
        activeSockets: 0,
        completed,
        failed,
        cancelled,
        artificialDelayMilliseconds: 0,
      }
    },
    metrics() {
      return {
        activeRequests: active.size,
        activeSockets: sockets.size,
        completed,
        failed,
        cancelled,
        closed,
      }
    },
  }
}
