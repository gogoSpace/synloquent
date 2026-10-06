import type {
  ClientConfiguration,
  Envelope,
  Transport,
} from '@synloquent/client'
import {
  createReactNativeHttpTransport,
  ReactNativeHttpError,
  type ReactNativeHttpTransport,
} from '@synloquent/client/react-native'
import {
  nativeClock,
  setApplicationWorkPhase,
  observeNativeContinuation,
  schedule,
  digest,
} from './platform'

export interface ExampleTransportConfiguration {
  readonly digest?: ClientConfiguration['digest']
  readonly address: string
  readonly timeoutMilliseconds?: number
}

export type NativeHttpStageEvent = Parameters<
  NonNullable<
    Parameters<typeof createReactNativeHttpTransport>[0]['observeStage']
  >
>[0]
let sourceStageObserver: ((stage: NativeHttpStageEvent) => void) | undefined
export function observeNativeHttpStages(
  receive: (stage: NativeHttpStageEvent) => void,
): () => void {
  if (sourceStageObserver)
    throw new Error(
      'The original native HTTP stage stream already has an owner.',
    )
  sourceStageObserver = receive
  return () => {
    if (sourceStageObserver === receive) sourceStageObserver = undefined
  }
}

export interface NativeHttpFailure {
  readonly kind: string
  readonly status: number | null
  readonly code: string
  readonly itemIdWireType: string
}
let firstNativeHttpFailure: NativeHttpFailure | undefined
export interface NativeHttpStage {
  readonly kind: string
  readonly phase:
    'responseAvailable' | 'responseText' | 'jsonDecode' | 'shapeValidation'
  readonly boundary?: string
  readonly elapsedMilliseconds: number
  readonly maximumWorkSliceMilliseconds?: number
  readonly maximumWorkSliceBoundary?: string | undefined
  readonly responseCharacters?: number
  readonly serverTiming?: string | null
  readonly serverProfile?: string | null
  readonly heapBytes?: number | undefined
  readonly callCount: number
  readonly aggregation: NativeHttpStageDiagnostics & {
    readonly method: 'sum by request kind and phase'
    readonly responseCharactersUnit: 'UTF-16 code units'
    readonly boundarySelection: 'first retained event boundary'
  }
}
export interface NativeHttpStageDiagnostics {
  readonly maximumRetainedGroups: number
  readonly retainedGroups: number
  readonly observedEvents: number
  readonly droppedGroupAdmissions: number
  readonly discardedEvents: number
  readonly discardedFields: number
  readonly maximumObservedHeapBytes?: number | undefined
}
const maximumRetainedGroups = 64
const maximumKindCharacters = 128
const maximumBoundaryCharacters = 256
const maximumHeaderCharacters = 4096
const httpStages: Omit<NativeHttpStage, 'aggregation'>[] = []
let observedEvents = 0
let droppedGroupAdmissions = 0
let discardedEvents = 0
let discardedFields = 0
let maximumObservedHeapBytes: number | undefined

function recordNativeHttpStage(
  stage: Omit<NativeHttpStage, 'callCount' | 'aggregation' | 'heapBytes'>,
): void {
  observedEvents++
  const heapBytes = nativeClock.memory.usedJSHeapSize
  if (heapBytes !== undefined)
    maximumObservedHeapBytes = Math.max(
      maximumObservedHeapBytes ?? 0,
      heapBytes,
    )
  if (stage.kind.length > maximumKindCharacters) {
    discardedEvents++
    discardedFields++
    return
  }
  const index = httpStages.findIndex(
    (existing) =>
      existing.kind === stage.kind && existing.phase === stage.phase,
  )
  if (index < 0 && httpStages.length === maximumRetainedGroups) {
    droppedGroupAdmissions++
    discardedEvents++
    return
  }
  const retained = {
    kind: stage.kind,
    phase: stage.phase,
    elapsedMilliseconds: stage.elapsedMilliseconds,
    ...(stage.boundary === undefined ? {} : { boundary: stage.boundary }),
    ...(stage.maximumWorkSliceMilliseconds === undefined
      ? {}
      : { maximumWorkSliceMilliseconds: stage.maximumWorkSliceMilliseconds }),
    ...(stage.responseCharacters === undefined
      ? {}
      : { responseCharacters: stage.responseCharacters }),
    ...(stage.serverTiming === undefined
      ? {}
      : { serverTiming: stage.serverTiming }),
    ...(stage.serverProfile === undefined
      ? {}
      : { serverProfile: stage.serverProfile }),
  }
  for (const [field, limit] of [
    ['boundary', maximumBoundaryCharacters],
    ['serverTiming', maximumHeaderCharacters],
    ['serverProfile', maximumHeaderCharacters],
  ] as const)
    if (typeof retained[field] === 'string' && retained[field].length > limit) {
      delete retained[field]
      discardedFields++
    }
  const existing = httpStages[index]
  if (!existing) {
    httpStages.push({
      ...retained,
      ...(retained.maximumWorkSliceMilliseconds === undefined ||
      retained.boundary === undefined
        ? {}
        : { maximumWorkSliceBoundary: retained.boundary }),
      heapBytes,
      callCount: 1,
    })
    return
  }
  httpStages[index] = {
    ...existing,
    elapsedMilliseconds:
      existing.elapsedMilliseconds + stage.elapsedMilliseconds,
    callCount: existing.callCount + 1,
    ...(stage.maximumWorkSliceMilliseconds === undefined
      ? {}
      : {
          maximumWorkSliceMilliseconds: Math.max(
            existing.maximumWorkSliceMilliseconds ?? 0,
            stage.maximumWorkSliceMilliseconds,
          ),
          maximumWorkSliceBoundary:
            existing.maximumWorkSliceMilliseconds === undefined ||
            stage.maximumWorkSliceMilliseconds >
              existing.maximumWorkSliceMilliseconds
              ? retained.boundary
              : existing.maximumWorkSliceBoundary,
        }),
    ...(stage.responseCharacters === undefined
      ? {}
      : {
          responseCharacters:
            (existing.responseCharacters ?? 0) + stage.responseCharacters,
        }),
    ...(heapBytes === undefined
      ? {}
      : { heapBytes: Math.max(existing.heapBytes ?? 0, heapBytes) }),
    ...(existing.boundary === undefined && retained.boundary !== undefined
      ? { boundary: retained.boundary }
      : {}),
    ...(existing.serverTiming == null && retained.serverTiming != null
      ? { serverTiming: retained.serverTiming }
      : {}),
    ...(existing.serverProfile == null && retained.serverProfile != null
      ? { serverProfile: retained.serverProfile }
      : {}),
  }
}

export function resetNativeHttpStages(): void {
  httpStages.length = 0
  observedEvents = 0
  droppedGroupAdmissions = 0
  discardedEvents = 0
  discardedFields = 0
  maximumObservedHeapBytes = undefined
}
export function nativeHttpStageDiagnostics(): NativeHttpStageDiagnostics {
  return {
    maximumRetainedGroups,
    retainedGroups: httpStages.length,
    observedEvents,
    droppedGroupAdmissions,
    discardedEvents,
    discardedFields,
    maximumObservedHeapBytes,
  }
}
export function nativeHttpStages(): readonly NativeHttpStage[] {
  return httpStages.map((stage) => ({
    ...stage,
    aggregation: {
      ...nativeHttpStageDiagnostics(),
      method: 'sum by request kind and phase',
      responseCharactersUnit: 'UTF-16 code units',
      boundarySelection: 'first retained event boundary',
    },
  }))
}
export function nativeHttpFailure(): NativeHttpFailure | undefined {
  return firstNativeHttpFailure
}

export { ReactNativeHttpError as ExampleTransportError }

/** Only this synthetic witness supplies local fixture credentials. */
export function createExampleTransport(
  configuration: ExampleTransportConfiguration,
): Transport & { suspend(): void; close(): Promise<void> } {
  let binding: ReactNativeHttpTransport | undefined
  let sessionIdentity = ''
  const transportFor = (request: Envelope<unknown>): Transport => {
    const identity = JSON.stringify(request.session)
    if (!binding)
      binding = createReactNativeHttpTransport({
        endpoint: `${configuration.address}/synloquent/v1/protocol`,
        session: request.session,
        digest: configuration.digest ?? digest,
        authenticate: (identity) => ({
          session: identity.session,
          headers: {
            Authorization: `Bearer synthetic-actor-${identity.session.accountId}`,
          },
        }),
        ...(configuration.timeoutMilliseconds === undefined
          ? {}
          : { timeoutMilliseconds: configuration.timeoutMilliseconds }),
        nowMilliseconds: () => nativeClock.now(),
        schedule,
        observeNativeContinuation,
        observePhase(phase) {
          setApplicationWorkPhase(
            {
              responseAvailable: 'http-transfer',
              responseText: 'http-response-text',
              jsonDecode: 'http-json-decode',
              shapeValidation: 'http-shape-validation',
            }[phase],
          )
        },
        observeStage(stage) {
          sourceStageObserver?.(Object.freeze({ ...stage }))
          recordNativeHttpStage(stage)
        },
      })
    else if (sessionIdentity !== identity) binding.setSession(request.session)
    sessionIdentity = identity
    return binding.transport
  }
  const invoke = async <Result>(
    request: Envelope<unknown>,
    callback: (transport: Transport) => Promise<Result>,
  ): Promise<Result> => {
    try {
      return await callback(transportFor(request))
    } catch (failure) {
      if (!firstNativeHttpFailure) {
        const payload: unknown = request.payload
        const argumentsValue =
          typeof payload === 'object' &&
          payload !== null &&
          'arguments' in payload
            ? payload.arguments
            : undefined
        const itemId =
          typeof argumentsValue === 'object' &&
          argumentsValue !== null &&
          'item_id' in argumentsValue
            ? argumentsValue.item_id
            : undefined
        firstNativeHttpFailure = {
          kind: request.kind,
          status:
            failure instanceof ReactNativeHttpError
              ? (failure.status ?? null)
              : null,
          code:
            failure instanceof ReactNativeHttpError
              ? failure.code
              : 'transport_failed',
          itemIdWireType:
            itemId === null
              ? 'null'
              : Array.isArray(itemId)
                ? 'array'
                : typeof itemId,
        }
      }
      throw failure
    }
  }
  return {
    manifest: (request) =>
      invoke(request, (transport) => transport.manifest(request)),
    query: (request) =>
      invoke(request, (transport) => transport.query(request)),
    push: (request) => invoke(request, (transport) => transport.push(request)),
    pull: (request) => invoke(request, (transport) => transport.pull(request)),
    snapshot: (request) =>
      invoke(request, (transport) => transport.snapshot(request)),
    snapshotParts: (request, lifecycle) =>
      invoke(request, (transport) =>
        transport.snapshotParts!(request, lifecycle),
      ),
    snapshotPartBatch: (request, lifecycle) =>
      invoke(request, (transport) =>
        transport.snapshotPartBatch!(request, lifecycle),
      ),
    confirmSnapshotParts: (request, lifecycle) =>
      invoke(request, (transport) =>
        transport.confirmSnapshotParts!(request, lifecycle),
      ),
    suspend() {
      binding?.suspend()
      sessionIdentity = ''
    },
    close() {
      return binding?.close() ?? Promise.resolve()
    },
    command: (request) =>
      invoke(request, (transport) => transport.command(request)),
  }
}
