import type {
  Attributes,
  DigestLifecycle,
  Envelope,
  Manifest,
  Operation,
  PullResponse,
  PushReceipt,
  QueryOptions,
  QueryResponse,
  Session,
  Snapshot,
  SnapshotPartBatch,
  SnapshotPartsDescriptor,
  SnapshotPartsConfirmation,
  Transport,
  WireValue,
} from '../../core/types.js'
import {
  monotonicMilliseconds,
  scheduleApplication,
  assertNativeScheduler,
} from '../scheduler.js'
import { HttpWorkBudget } from './work-budget.js'
import { decodeHttpJson } from './json.js'
import { isRecord, validateHttpPayload } from './validation.js'
import { utf8Length } from '../../core/snapshot-content.js'
import {
  createSnapshotPartBatch,
  isSnapshotPartIdentity,
  isSnapshotPartsDescriptor,
} from './parts.js'
import type {
  HttpStage,
  ReactNativeHttpConfiguration,
  ReactNativeHttpTransport,
} from './types.js'

export class ReactNativeHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly retryAfterMilliseconds?: number,
  ) {
    super(message)
    this.name = 'ReactNativeHttpError'
  }
}

const sessionFields = [
  'accountId',
  'tenantId',
  'deviceId',
  'deviceEpoch',
  'generation',
] as const
function sameSession(left: Session, right: Session): boolean {
  return sessionFields.every((field) => left[field] === right[field])
}
export function copySession(session: Session): Session {
  if (
    !session ||
    sessionFields
      .slice(0, 4)
      .some(
        (field) =>
          typeof session[field] !== 'string' ||
          String(session[field]).length < 1 ||
          String(session[field]).length > 1024,
      ) ||
    !Number.isSafeInteger(session.generation) ||
    session.generation < 0
  )
    throw new ReactNativeHttpError(
      'session_changed',
      'Invalid HTTP session binding.',
    )
  return Object.freeze({
    accountId: session.accountId,
    tenantId: session.tenantId,
    deviceId: session.deviceId,
    deviceEpoch: session.deviceEpoch,
    generation: session.generation,
  })
}
function authenticationHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  if (!isRecord(headers))
    throw new ReactNativeHttpError(
      'unauthenticated',
      'Authentication must provide headers.',
    )
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      typeof value !== 'string' ||
      /[\r\n\0]/.test(value)
    )
      throw new ReactNativeHttpError(
        'unauthenticated',
        'Invalid authentication header.',
      )
    if (
      [
        'content-type',
        'accept',
        'x-synloquent-device',
        'x-synloquent-device-epoch',
        'x-synloquent-continuation',
        'host',
        'content-length',
      ].includes(name.toLowerCase())
    )
      throw new ReactNativeHttpError(
        'unauthenticated',
        'Authentication cannot replace protocol headers.',
      )
    Object.defineProperty(result, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return result
}
function observe(callback: (() => void) | undefined): void {
  try {
    callback?.()
  } catch {
    /* Diagnostics cannot change request outcomes. */
  }
}

/** Native fetch buffers the response. Decode and validation yield to the application. */
export function createReactNativeHttpTransport(
  configuration: ReactNativeHttpConfiguration,
): ReactNativeHttpTransport {
  if (configuration.schedule === undefined) assertNativeScheduler()
  if (!/^https?:\/\/[^\s]+$/.test(configuration.endpoint))
    throw new ReactNativeHttpError(
      'transport_failed',
      'An absolute HTTP protocol endpoint is required.',
    )
  const timeoutMilliseconds = configuration.timeoutMilliseconds ?? 30000
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 ||
    timeoutMilliseconds > 2147483647
  )
    throw new ReactNativeHttpError('transport_failed', 'Invalid HTTP deadline.')
  const now = configuration.nowMilliseconds ?? monotonicMilliseconds
  const schedule = configuration.schedule ?? scheduleApplication
  let session = copySession(configuration.session)
  let epoch = 0
  let suspended = false
  let closed = false
  let closing: Promise<void> | undefined
  let boundedOperationActive = false
  const operations = new Set<{
    cancel(code: string): void
    readonly settled: Promise<void>
  }>()
  const cancelPending = (code = 'session_changed') => {
    epoch += 1
    for (const operation of operations) operation.cancel(code)
  }
  const phase = (value: HttpStage['phase']) =>
    observe(() => configuration.observePhase?.(value))
  const stage = (value: HttpStage) =>
    observe(() => configuration.observeStage?.(value))
  const continuation = (statement: string) =>
    observe(() => configuration.observeNativeContinuation?.({ statement }))

  async function post<Payload, Result>(
    request: Envelope<Payload>,
    expectedKind: string,
    options: {
      readonly endpoint?: string
      readonly method?: 'GET' | 'POST'
      readonly body?: unknown
      readonly headers?: Readonly<Record<string, string>>
      readonly representation?: 'descriptor' | 'bundle' | 'confirmation'
      readonly lifecycle?: DigestLifecycle | undefined
    } = {},
  ): Promise<Result> {
    const requestedSession = copySession(request.session)
    if (closed || suspended || !sameSession(requestedSession, session))
      throw new ReactNativeHttpError(
        'session_changed',
        'The HTTP session is inactive.',
      )
    if (
      request.protocolVersion !== 1 ||
      request.kind !== expectedKind ||
      typeof request.requestId !== 'string' ||
      !request.requestId ||
      request.requestId.length > 1024 ||
      typeof request.schemaFingerprint !== 'string' ||
      !request.schemaFingerprint ||
      request.schemaFingerprint.length > 1024
    )
      throw new ReactNativeHttpError(
        'schema_mismatch',
        'Invalid HTTP request identity.',
      )
    const identity = Object.freeze({
      requestId: request.requestId,
      kind: request.kind,
      schemaFingerprint: request.schemaFingerprint,
      session: requestedSession,
    })
    const boundedOperation = options.representation !== undefined
    if (boundedOperation && boundedOperationActive)
      throw new ReactNativeHttpError(
        'snapshot_admission_required',
        'A bounded snapshot operation is still releasing its work.',
      )
    if (boundedOperation) boundedOperationActive = true
    const pendingOwnedWork = new Set<Promise<unknown>>()
    const trackOwnedWork = <Value>(pending: Promise<Value>): Promise<Value> => {
      if (boundedOperation) {
        pendingOwnedWork.add(pending)
        void pending.then(
          () => pendingOwnedWork.delete(pending),
          () => pendingOwnedWork.delete(pending),
        )
      }
      return pending
    }
    const requestEpoch = epoch
    const controller = new AbortController()
    const deadline = now() + timeoutMilliseconds
    const listeners = new Set<() => void>()
    let cancellationFailure: ReactNativeHttpError | undefined
    const cancellationListeners = new Set<(failure: Error) => void>()
    const aborted = () => {
      cancellationFailure ??= new ReactNativeHttpError(
        'transport_failed',
        'The HTTP request was aborted.',
      )
      cancellationFailure.name = 'AbortError'
      for (const listener of cancellationListeners)
        listener(cancellationFailure)
      cancellationListeners.clear()
      for (const listener of listeners) observe(listener)
      listeners.clear()
    }
    controller.signal.addEventListener('abort', aborted)
    let resolveSettled: () => void = () => undefined
    let releaseResponse: (() => void) | undefined
    let deferredCleanup = false
    let unsubscribeLifecycle: () => void = () => undefined
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    const operation = {
      settled,
      cancel(code: string) {
        if (controller.signal.aborted) return
        cancellationFailure = new ReactNativeHttpError(
          code,
          'The HTTP request was aborted.',
        )
        controller.abort()
        releaseResponse?.()
      },
    }
    operations.add(operation)
    const timeout = setTimeout(
      () => operation.cancel('transport_failed'),
      timeoutMilliseconds,
    )
    const active = () => {
      if (now() >= deadline) operation.cancel('transport_failed')
      if (
        closed ||
        suspended ||
        requestEpoch !== epoch ||
        !sameSession(identity.session, session)
      )
        operation.cancel('session_changed')
      if (
        !sameSession(request.session, identity.session) ||
        request.requestId !== identity.requestId ||
        request.kind !== identity.kind ||
        request.schemaFingerprint !== identity.schemaFingerprint
      )
        operation.cancel('session_changed')
      if (controller.signal.aborted) throw cancellationFailure
    }
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', aborted)
      listeners.clear()
      cancellationListeners.clear()
      unsubscribeLifecycle()
      const released = () => {
        operations.delete(operation)
        if (boundedOperation) boundedOperationActive = false
        resolveSettled()
      }
      if (pendingOwnedWork.size)
        void Promise.allSettled(pendingOwnedWork).then(released)
      else released()
    }
    const race = async <Value>(
      pending: PromiseLike<Value> | Value,
    ): Promise<Value> => {
      active()
      const value = await new Promise<Value>((resolveValue, rejectValue) => {
        let rejectCurrentCancellation: (failure: Error) => void = () =>
          undefined
        const cancellation = new Promise<never>((_, reject) => {
          rejectCurrentCancellation = reject
        })
        Promise.resolve(pending).then(
          (result) => {
            cancellationListeners.delete(rejectCurrentCancellation)
            resolveValue(result)
          },
          (failure) => {
            cancellationListeners.delete(rejectCurrentCancellation)
            rejectValue(failure)
          },
        )
        void cancellation.catch((failure) => {
          cancellationListeners.delete(rejectCurrentCancellation)
          rejectValue(failure)
        })
        if (cancellationFailure) rejectCurrentCancellation(cancellationFailure)
        else cancellationListeners.add(rejectCurrentCancellation)
      })
      active()
      return value
    }
    const releasedBlobs = new WeakSet<Blob>()
    const supportsBlobRelease =
      typeof Blob === 'function' &&
      typeof (Blob.prototype as Blob & { close?: unknown }).close ===
        'function' &&
      typeof Response === 'function'
    const releaseBlob = (blob: Blob) => {
      if (
        !(blob instanceof Blob) ||
        typeof (blob as Blob & { close?: unknown }).close !== 'function' ||
        releasedBlobs.has(blob)
      )
        return
      releasedBlobs.add(blob)
      try {
        ;(blob as Blob & { close(): void }).close()
      } catch {
        /* Release diagnostics cannot replace request outcomes. */
      }
    }
    const discardResponse = async (response: Response) => {
      if (
        !supportsBlobRelease ||
        !(response instanceof Response) ||
        response.blob !== Response.prototype.blob ||
        response.text !== Response.prototype.text ||
        typeof response.blob !== 'function' ||
        response.bodyUsed
      )
        return
      try {
        releaseBlob(await response.blob())
      } catch {
        /* A failed body acquisition has no public Blob to close. */
      }
    }
    const readNativeBlobText = async (response: Response) => {
      const blob = await response.blob()
      if (controller.signal.aborted) {
        releaseBlob(blob)
        throw cancellationFailure
      }
      try {
        return await new Response(blob).text()
      } finally {
        releaseBlob(blob)
      }
    }
    const readOwnedResponseText = (response: Response) => {
      if (
        !supportsBlobRelease ||
        !(response instanceof Response) ||
        response.blob !== Response.prototype.blob ||
        response.text !== Response.prototype.text ||
        typeof response.blob !== 'function'
      )
        return response.text()
      return readNativeBlobText(response)
    }
    try {
      if (options.lifecycle) {
        unsubscribeLifecycle = options.lifecycle.subscribe(() =>
          operation.cancel('snapshot_install_cancelled'),
        )
        if (options.lifecycle.cancelled)
          operation.cancel('snapshot_install_cancelled')
      }
      active()
      const authentication = await race(
        configuration.authenticate(identity, {
          get cancelled() {
            return controller.signal.aborted
          },
          subscribe(listener) {
            if (controller.signal.aborted) {
              observe(listener)
              return () => undefined
            }
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
        }),
      )
      if (
        !authentication ||
        !sameSession(copySession(authentication.session), identity.session)
      )
        throw new ReactNativeHttpError(
          'session_changed',
          'Authentication belongs to another session.',
        )
      const headers = authenticationHeaders(authentication.headers)
      active()
      const readResponse = async () => {
        let ownedResponse: Response | undefined
        let textReadStarted = false
        try {
          phase('responseAvailable')
          let stageStarted = now()
          const pendingResponse = trackOwnedWork(
            Promise.resolve(
              fetch(options.endpoint ?? configuration.endpoint, {
                method: options.method ?? 'POST',
                headers: {
                  ...headers,
                  'Content-Type': 'application/json',
                  Accept:
                    options.representation === 'bundle'
                      ? 'application/x-ndjson'
                      : 'application/json',
                  'X-Synloquent-Device': identity.session.deviceId,
                  'X-Synloquent-Device-Epoch': identity.session.deviceEpoch,
                  ...options.headers,
                },
                ...(options.method === 'GET'
                  ? {}
                  : { body: JSON.stringify(options.body ?? request) }),
                signal: controller.signal,
              }),
            ).then(async (value) => {
              ownedResponse = value
              if (controller.signal.aborted) await discardResponse(value)
              return value
            }),
          )
          const response = await race(pendingResponse)
          if (
            !Number.isInteger(response.status) ||
            response.status < 100 ||
            response.status > 599 ||
            response.ok !== (response.status >= 200 && response.status < 300)
          )
            throw new ReactNativeHttpError(
              'transport_failed',
              'Invalid native HTTP status.',
            )
          phase('responseText')
          continuation('native HTTP response completion')
          stage({
            kind: identity.kind,
            phase: 'responseAvailable',
            boundary: 'complete response availability from React Native fetch',
            elapsedMilliseconds: now() - stageStarted,
            serverTiming: response.headers.get('Server-Timing'),
            serverProfile: response.headers.get('X-Synloquent-Profile'),
          })
          stageStarted = now()
          const maximumResponseBytes =
            options.representation === 'bundle'
              ? 1048576
              : options.representation === undefined
                ? 64 * 1024 * 1024
                : 16384
          const declaredLength =
            options.representation === undefined
              ? null
              : response.headers.get('Content-Length')
          if (
            declaredLength !== null &&
            (!/^\d+$/.test(declaredLength) ||
              Number(declaredLength) > maximumResponseBytes)
          )
            throw new ReactNativeHttpError(
              'schema_mismatch',
              'The response exceeds its bounded representation.',
              response.status,
            )
          textReadStarted = true
          const pendingText = trackOwnedWork(readOwnedResponseText(response))
          void pendingText.catch(() => undefined)
          const content = await race(pendingText)
          continuation('native HTTP response text completion')
          stage({
            kind: identity.kind,
            phase: 'responseText',
            elapsedMilliseconds: now() - stageStarted,
            responseCharacters: content.length,
          })
          if (
            content.length > maximumResponseBytes ||
            (options.representation !== undefined &&
              options.representation !== 'bundle' &&
              utf8Length(content) > maximumResponseBytes)
          )
            throw new ReactNativeHttpError(
              'schema_mismatch',
              'The response exceeds the transport size limit.',
              response.status,
            )
          return {
            status: response.status,
            ok: response.ok,
            headers: response.headers,
            content,
          }
        } finally {
          if (ownedResponse && !textReadStarted)
            void trackOwnedWork(discardResponse(ownedResponse))
        }
      }
      const response = await readResponse()
      let content = response.content
      response.content = ''
      phase('jsonDecode')
      let stageStarted = now()
      const budget = new HttpWorkBudget({
        now,
        deadline,
        cancellation: controller.signal,
        abort: () => operation.cancel('transport_failed'),
        schedule: (callback, delayMilliseconds) =>
          schedule(() => {
            if (delayMilliseconds > 0)
              continuation('HTTP host timer response processing continuation')
            try {
              active()
            } catch {
              operation.cancel('transport_failed')
            }
            callback()
          }, delayMilliseconds),
      })
      budget.beginMeasurement()
      if (response.ok && options.representation === 'bundle') {
        if (!configuration.digest || !isRecord(request.payload))
          throw new ReactNativeHttpError(
            'snapshot_invalid',
            'Bounded downloads require a digest provider.',
          )
        const payload = request.payload as unknown as {
          readonly descriptor: SnapshotPartsDescriptor
          readonly part: import('../../core/types.js').SnapshotPartIdentity
        }
        const owned = createSnapshotPartBatch({
          content,
          headers: response.headers,
          descriptor: payload.descriptor,
          firstPart: payload.part,
          budget,
          assertActive: active,
          digest: (document, lifecycle) =>
            trackOwnedWork(configuration.digest!(document, lifecycle)),
          lifecycle: {
            get cancelled() {
              return controller.signal.aborted
            },
            subscribe(listener) {
              if (controller.signal.aborted) {
                observe(listener)
                return () => undefined
              }
              listeners.add(listener)
              return () => {
                listeners.delete(listener)
              }
            },
          },
          cancel: () => operation.cancel('snapshot_install_cancelled'),
          finish,
          now,
          phase,
          stage,
        })
        content = ''
        releaseResponse = owned.release
        deferredCleanup = true
        return owned.batch as Result
      }
      const body: unknown = await decodeHttpJson(content, budget)
      content = ''
      active()
      stage({
        kind: identity.kind,
        phase: 'jsonDecode',
        maximumWorkSliceMilliseconds: budget.endMeasurement(),
        elapsedMilliseconds: now() - stageStarted,
      })
      if (!response.ok) {
        const error =
          isRecord(body) && isRecord(body.error) ? body.error : undefined
        const retryAfter = response.headers.get('Retry-After')
        const seconds =
          retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : undefined
        const date =
          retryAfter !== null && seconds === undefined
            ? Date.parse(retryAfter)
            : NaN
        const retryAfterMilliseconds =
          seconds !== undefined && Number.isFinite(seconds)
            ? seconds
            : Number.isFinite(date)
              ? Math.max(0, date - Date.now())
              : undefined
        throw new ReactNativeHttpError(
          typeof error?.code === 'string' ? error.code : 'transport_failed',
          typeof error?.message === 'string'
            ? error.message
            : `The Laravel host returned HTTP ${response.status}.`,
          response.status,
          retryAfterMilliseconds,
        )
      }
      if (options.representation === 'confirmation') {
        if (
          !isRecord(body) ||
          body.confirmed !== true ||
          !isRecord(request.payload)
        )
          throw new ReactNativeHttpError(
            'snapshot_invalid',
            'Snapshot confirmation is invalid.',
            response.status,
          )
        const descriptor = request.payload.descriptor
        if (
          !isSnapshotPartsDescriptor(descriptor) ||
          [
            'schemaFingerprint',
            'dataset',
            'generation',
            'cursor',
            'hash',
            'byteSize',
          ].some(
            (field) =>
              body[field] !==
              descriptor[field as keyof SnapshotPartsDescriptor],
          ) ||
          !isRecord(body.scope) ||
          [
            'dataset',
            'authorizationGeneration',
            'projectionGeneration',
            'schemaFingerprint',
          ].some(
            (field) =>
              (body.scope as Record<string, unknown>)[field] !==
              descriptor.scope[field as keyof typeof descriptor.scope],
          )
        )
          throw new ReactNativeHttpError(
            'snapshot_invalid',
            'Snapshot confirmation belongs to another acquisition.',
            response.status,
          )
        return body as Result
      }
      if (
        !isRecord(body) ||
        body.protocolVersion !== 1 ||
        body.requestId !== identity.requestId ||
        body.kind !== identity.kind ||
        !isRecord(body.session)
      )
        throw new ReactNativeHttpError(
          'schema_mismatch',
          'The response envelope does not match its request.',
          response.status,
        )
      for (const field of sessionFields)
        if (body.session[field] !== identity.session[field])
          throw new ReactNativeHttpError(
            'session_changed',
            'The response belongs to another actor or device session.',
            response.status,
          )
      if (
        identity.kind !== 'manifest' &&
        body.schemaFingerprint !== identity.schemaFingerprint
      )
        throw new ReactNativeHttpError(
          'schema_mismatch',
          'The response schema does not match its request.',
          response.status,
        )
      phase('shapeValidation')
      stageStarted = now()
      budget.beginMeasurement()
      const payload: unknown = request.payload
      const valid =
        options.representation === 'descriptor'
          ? isSnapshotPartsDescriptor(body.payload)
          : await validateHttpPayload(
              identity.kind,
              body.payload,
              budget,
              isRecord(payload) && typeof payload.operationId === 'string'
                ? payload.operationId
                : undefined,
            )
      active()
      stage({
        kind: identity.kind,
        phase: 'shapeValidation',
        maximumWorkSliceMilliseconds: budget.endMeasurement(),
        elapsedMilliseconds: now() - stageStarted,
      })
      if (!valid)
        throw new ReactNativeHttpError(
          'schema_mismatch',
          'The response payload has an invalid shape.',
          response.status,
        )
      return body.payload as Result
    } catch (failure) {
      if (controller.signal.aborted) throw cancellationFailure
      throw failure
    } finally {
      if (!deferredCleanup) finish()
    }
  }
  const transport: Transport = {
    manifest: (request: Envelope<Record<string, never>>) =>
      post<Record<string, never>, Manifest>(request, 'manifest'),
    query: (request: Envelope<QueryOptions>) =>
      post<QueryOptions, QueryResponse>(request, 'query'),
    push: (request: Envelope<{ readonly operations: readonly Operation[] }>) =>
      post<
        { readonly operations: readonly Operation[] },
        { readonly receipts: readonly PushReceipt[] }
      >(request, 'push'),
    pull: (
      request: Envelope<{
        readonly cursor: string | null
        readonly dataset: string
      }>,
    ) =>
      post<
        { readonly cursor: string | null; readonly dataset: string },
        PullResponse
      >(request, 'pull'),
    snapshot: (request: Envelope<{ readonly dataset: string }>) =>
      post<{ readonly dataset: string }, Snapshot>(request, 'snapshot'),
    snapshotParts: (request, lifecycle) =>
      post<{ readonly dataset: string }, SnapshotPartsDescriptor>(
        request,
        'snapshot',
        {
          representation: 'descriptor',
          lifecycle,
          body: {
            ...request,
            payload: { ...request.payload, delivery: 'parts-v1' },
          },
        },
      ),
    snapshotPartBatch: (request, lifecycle) => {
      const { descriptor, part } = request.payload
      const prefix = configuration.endpoint.replace(/\/protocol$/, '')
      if (
        prefix === configuration.endpoint ||
        !isSnapshotPartsDescriptor(descriptor) ||
        !isSnapshotPartIdentity(part) ||
        !/^[a-f0-9]{64}$/.test(descriptor.generation)
      )
        throw new ReactNativeHttpError(
          'snapshot_invalid',
          'Snapshot acquisition identity is invalid.',
        )
      return post<unknown, SnapshotPartBatch>(request, 'snapshot', {
        endpoint: `${prefix}/snapshots/${descriptor.generation}/${descriptor.hash}/parts/${part.ordinal}/bundle`,
        method: 'GET',
        representation: 'bundle',
        lifecycle,
        headers: { 'X-Synloquent-Continuation': part.continuation },
      })
    },
    confirmSnapshotParts: (request, lifecycle) => {
      const { descriptor, confirmationToken } = request.payload
      const prefix = configuration.endpoint.replace(/\/protocol$/, '')
      if (
        prefix === configuration.endpoint ||
        !isSnapshotPartsDescriptor(descriptor) ||
        !/^[a-f0-9]{64}$/.test(descriptor.generation)
      )
        throw new ReactNativeHttpError(
          'snapshot_invalid',
          'Snapshot acquisition identity is invalid.',
        )
      return post<unknown, SnapshotPartsConfirmation>(request, 'snapshot', {
        endpoint: `${prefix}/snapshots/${descriptor.generation}/${descriptor.hash}/confirm`,
        representation: 'confirmation',
        lifecycle,
        body: { confirmationToken },
      })
    },
    command: async <Result extends WireValue>(
      request: Envelope<{
        readonly name: string
        readonly operationId: string
        readonly arguments: Attributes
      }>,
    ) =>
      (await post<unknown, { readonly result: Result }>(request, 'command'))
        .result,
  }
  return {
    transport,
    suspend() {
      suspended = true
      cancelPending()
    },
    setSession(value) {
      if (closed)
        throw new ReactNativeHttpError(
          'closed_database',
          'The HTTP transport is closed.',
        )
      const next = copySession(value)
      cancelPending()
      session = next
      suspended = false
    },
    cancelPending() {
      cancelPending()
    },
    close() {
      if (closing) return closing
      closed = true
      suspended = true
      const pending = [...operations]
      cancelPending('closed_database')
      closing = Promise.all(pending.map((operation) => operation.settled)).then(
        () => undefined,
      )
      return closing
    },
  }
}
