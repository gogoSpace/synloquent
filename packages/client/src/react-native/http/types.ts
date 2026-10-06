import type { DigestLifecycle, Session, Transport } from '../../core/types.js'

export interface HttpRequestIdentity {
  readonly requestId: string
  readonly kind: string
  readonly schemaFingerprint: string
  readonly session: Session
}
export interface HttpAuthentication {
  readonly session: Session
  readonly headers: Readonly<Record<string, string>>
}
export interface HttpStage {
  readonly kind: string
  readonly phase:
    'responseAvailable' | 'responseText' | 'jsonDecode' | 'shapeValidation'
  readonly boundary?: string
  readonly elapsedMilliseconds: number
  readonly maximumWorkSliceMilliseconds?: number
  readonly responseCharacters?: number
  readonly serverTiming?: string | null
  readonly serverProfile?: string | null
}
export interface ReactNativeHttpConfiguration {
  /** Required by bounded immutable-part downloads. */
  readonly digest?: (
    content: string,
    lifecycle?: DigestLifecycle,
  ) => Promise<string>
  readonly endpoint: string
  readonly session: Session
  readonly authenticate: (
    identity: HttpRequestIdentity,
    lifecycle: DigestLifecycle,
  ) => Promise<HttpAuthentication> | HttpAuthentication
  readonly timeoutMilliseconds?: number
  readonly nowMilliseconds?: () => number
  readonly schedule?: (
    callback: () => void,
    delayMilliseconds: number,
  ) => () => void
  readonly observePhase?: (phase: HttpStage['phase']) => void
  readonly observeStage?: (stage: HttpStage) => void
  readonly observeNativeContinuation?: (event: {
    readonly statement: string
  }) => void
}
export interface ReactNativeHttpTransport {
  readonly transport: Transport
  /** Stop accepting requests until a new session is explicitly bound. */
  suspend(): void
  setSession(session: Session): void
  cancelPending(): void
  close(): Promise<void>
}
