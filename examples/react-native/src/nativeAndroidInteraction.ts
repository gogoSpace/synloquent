import type {
  GestureResponderEvent,
  NativeSyntheticEvent,
  NativeScrollEvent,
  TextInputChangeEvent,
} from 'react-native'

import { calibrationInteractionBinding } from './nativeCalibrationInteractionBinding'

const address = 'http://127.0.0.1:8767'
let probeSequence = 0
const probeRegistry: { current: AndroidInteractionProbe | undefined } = {
  current: undefined,
}

interface Action {
  readonly id: number
  readonly phase: string
  readonly type: 'input' | 'scroll'
  readonly probeIdentity: string
  readonly token: string
}
interface Association {
  readonly action: Action
  readonly startedNativeMilliseconds: number
  readonly target: number
  endedNativeMilliseconds?: number
}

interface ScrollObservation {
  readonly disposition:
    | 'associated'
    | 'closed'
    | 'unarmed'
    | 'non-scroll-action'
    | 'phase-mismatch'
    | 'missing-timestamp'
    | 'missing-target'
    | 'not-after-touch-end'
    | 'not-after-current-scroll'
    | 'touch-end'
  readonly armedActionId: number | null
  readonly armedType: 'input' | 'scroll' | null
  readonly armedPhase: string | null
  readonly currentActionId: number | null
  readonly currentPhase: string | null
  readonly currentStartedNativeMilliseconds: number | null
  readonly currentEndedNativeMilliseconds: number | null
  readonly lastTouchEndNativeMilliseconds: number
  readonly closed: boolean
}

function scalar(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function androidProbeIdentity(): string | undefined {
  return probeRegistry.current?.identity
}
export function updateAndroidInteractionPhase(phase: string): void {
  probeRegistry.current?.changePhase(phase)
}

export class AndroidInteractionProbe {
  readonly identity = 'probe-' + ++probeSequence
  private phase = 'inactive'
  private closed = false
  private controller: AbortController | undefined
  private armed: Action | undefined
  private currentScroll: Association | undefined
  private previousScroll: Association | undefined
  private lastTouchEnd = -1
  private lastEventCount = -1
  private pendingReceipts = 0
  private receiptOverflow = false

  constructor(private readonly clearInput: () => void) {}

  mount(): () => void {
    probeRegistry.current = this
    return () => {
      this.closed = true
      this.controller?.abort()
      this.armed = undefined
      if (probeRegistry.current === this) probeRegistry.current = undefined
    }
  }

  changePhase(phase: string): void {
    this.controller?.abort()
    this.phase = phase
    this.armed = undefined
    if (
      ![
        'idle',
        'sdk-import',
        'reference-import',
        'large-http',
        ...(calibrationInteractionBinding()?.measurementSchemaVersion === 2
          ? ['catalog-read']
          : []),
      ].includes(phase)
    )
      return
    const controller = new AbortController()
    this.controller = controller
    void this.receiveActions(phase, controller).catch(() => undefined)
  }

  private async post(path: string, value: object): Promise<void> {
    const response = await fetch(address + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    })
    if (!response.ok)
      throw new Error('The native interaction receipt was refused.')
  }

  private async receiveActions(
    phase: string,
    controller: AbortController,
  ): Promise<void> {
    while (!this.closed && !controller.signal.aborted && this.phase === phase) {
      const response = await fetch(address + '/ui/action/next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase, probeIdentity: this.identity }),
        signal: controller.signal,
      })
      if (!response.ok) return
      const action: Action = await response.json()
      if (
        this.closed ||
        controller.signal.aborted ||
        this.phase !== phase ||
        action.phase !== phase ||
        action.probeIdentity !== this.identity ||
        !Number.isSafeInteger(action.id) ||
        !['input', 'scroll'].includes(action.type) ||
        !/^u[0-9a-z]{1,12}z$/.test(action.token)
      )
        return
      this.armed = Object.freeze({ ...action })
      if (action.type === 'input') this.clearInput()
      await this.post('/ui/action/armed', {
        phase,
        probeIdentity: this.identity,
        actionId: action.id,
      })
      // The next offer remains pending until the previous host action is closed.
    }
  }

  private scrollObservation(
    disposition: ScrollObservation['disposition'],
  ): ScrollObservation {
    return {
      disposition,
      armedActionId: this.armed?.id ?? null,
      armedType: this.armed?.type ?? null,
      armedPhase: this.armed?.phase ?? null,
      currentActionId: this.currentScroll?.action.id ?? null,
      currentPhase: this.currentScroll?.action.phase ?? null,
      currentStartedNativeMilliseconds:
        this.currentScroll?.startedNativeMilliseconds ?? null,
      currentEndedNativeMilliseconds:
        this.currentScroll?.endedNativeMilliseconds ?? null,
      lastTouchEndNativeMilliseconds: this.lastTouchEnd,
      closed: this.closed,
    }
  }

  private report(
    type: 'input' | 'scroll',
    action: Action | undefined,
    acceptedCandidate: boolean,
    reason: string,
    fields: object,
  ): void {
    if (this.receiptOverflow) return
    if (this.pendingReceipts >= 64) {
      this.receiptOverflow = true
      void this.post('/ui/event', {
        phase: this.phase,
        probeIdentity: this.identity,
        type,
        actionId: null,
        acceptedCandidate: false,
        reason: 'bounded-receipt-overflow',
        applicationReceivedAt:
          reason === 'native-drag-begin-observation' ? null : Date.now(),
      }).catch(() => undefined)
      return
    }
    this.pendingReceipts += 1
    void this.post('/ui/event', {
      phase: action?.phase ?? this.phase,
      type,
      probeIdentity: this.identity,
      actionId: action?.id ?? null,
      acceptedCandidate: acceptedCandidate && !this.closed,
      reason: this.closed ? 'closed-probe' : reason,
      applicationReceivedAt:
        reason === 'native-drag-begin-observation' ? null : Date.now(),
      ...fields,
    })
      .catch(() => undefined)
      .finally(() => {
        this.pendingReceipts -= 1
      })
  }

  onChange = (event: TextInputChangeEvent): void => {
    const value = event.nativeEvent
    const action = this.armed
    const text = typeof value.text === 'string' ? value.text : ''
    const eventCount = scalar(value.eventCount)
    const matches =
      action?.type === 'input' &&
      action.phase === this.phase &&
      text === action.token &&
      eventCount !== null &&
      eventCount > this.lastEventCount
    if (eventCount !== null)
      this.lastEventCount = Math.max(this.lastEventCount, eventCount)
    this.report(
      'input',
      matches ? action : undefined,
      Boolean(matches),
      text.length === 0
        ? 'input-clear'
        : matches
          ? 'input-token'
          : 'input-token-mismatch',
      {
        text: text.length <= 32 ? text : null,
        textUnits: text.length,
        eventCount,
        target: scalar(value.target),
      },
    )
  }

  onTouchEnd = (event: GestureResponderEvent): void => {
    const timestamp = scalar(event.nativeEvent.timestamp)
    if (timestamp === null) return
    this.lastTouchEnd = Math.max(this.lastTouchEnd, timestamp)
    this.report(
      'scroll',
      this.currentScroll?.action,
      false,
      'native-touch-end',
      {
        nativeTimestamp: timestamp,
        target: scalar(event.nativeEvent.target),
        scrollObservation: this.scrollObservation('touch-end'),
      },
    )
  }

  onScrollEndDrag = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const value = event.nativeEvent as NativeScrollEvent & {
      timestamp?: number
      target?: number
    }
    const timestamp = scalar(value.timestamp)
    const target = scalar(value.target)
    const association = this.currentScroll
    if (
      this.closed ||
      !association ||
      timestamp === null ||
      timestamp <= association.startedNativeMilliseconds ||
      target !== association.target
    ) {
      this.report(
        'scroll',
        association?.action,
        false,
        'unassociated-drag-end',
        {
          nativeTimestamp: timestamp,
          target,
        },
      )
      return
    }
    association.endedNativeMilliseconds = timestamp
    void this.post('/ui/action/ended', {
      phase: association.action.phase,
      probeIdentity: this.identity,
      actionId: association.action.id,
      nativeTimestamp: timestamp,
      gestureStartedNativeMilliseconds: association.startedNativeMilliseconds,
      target,
    }).catch(() => undefined)
  }

  onScrollBeginDrag = (
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ): void => {
    const value = event.nativeEvent as NativeScrollEvent & {
      timestamp?: number
      target?: number
    }
    const timestamp = scalar(value.timestamp)
    const target = scalar(value.target)
    const action = this.armed
    if (
      this.closed ||
      !action ||
      action.type !== 'scroll' ||
      action.phase !== this.phase ||
      timestamp === null ||
      target === null ||
      timestamp <= this.lastTouchEnd ||
      (this.currentScroll &&
        timestamp <=
          (this.currentScroll.endedNativeMilliseconds ??
            this.currentScroll.startedNativeMilliseconds))
    ) {
      this.report('scroll', undefined, false, 'unassociated-drag-begin', {
        nativeTimestamp: timestamp,
        target,
        scrollObservation: this.scrollObservation(
          this.closed
            ? 'closed'
            : !action
              ? 'unarmed'
              : action.type !== 'scroll'
                ? 'non-scroll-action'
                : action.phase !== this.phase
                  ? 'phase-mismatch'
                  : timestamp === null
                    ? 'missing-timestamp'
                    : target === null
                      ? 'missing-target'
                      : timestamp <= this.lastTouchEnd
                        ? 'not-after-touch-end'
                        : 'not-after-current-scroll',
        ),
      })
      return
    }
    this.previousScroll = this.currentScroll
      ? Object.freeze({ ...this.currentScroll })
      : undefined
    this.currentScroll = {
      action,
      startedNativeMilliseconds: timestamp,
      target,
    }
    this.report('scroll', action, false, 'native-drag-begin-observation', {
      nativeTimestamp: timestamp,
      target,
      scrollObservation: this.scrollObservation('associated'),
    })
  }

  onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const value = event.nativeEvent as NativeScrollEvent & {
      timestamp?: number
      target?: number
    }
    const timestamp = scalar(value.timestamp)
    const target = scalar(value.target)
    const current = this.currentScroll
    const previous = this.previousScroll
    const association =
      timestamp !== null &&
      current &&
      timestamp > current.startedNativeMilliseconds
        ? current
        : timestamp !== null &&
            previous &&
            timestamp > previous.startedNativeMilliseconds &&
            (!current || timestamp < current.startedNativeMilliseconds)
          ? previous
          : undefined
    const matched = Boolean(
      association &&
      target === association.target &&
      (association.endedNativeMilliseconds === undefined ||
        (timestamp !== null &&
          timestamp <= association.endedNativeMilliseconds)),
    )
    this.report(
      'scroll',
      association?.action,
      matched,
      matched
        ? 'native-scroll-association'
        : association
          ? 'prior-scroll-inertia'
          : 'ambiguous-native-scroll',
      {
        target,
        nativeTimestamp: timestamp,
        gestureStartedNativeMilliseconds:
          association?.startedNativeMilliseconds ?? null,
        offsetX: scalar(value.contentOffset?.x),
        offsetY: scalar(value.contentOffset?.y),
      },
    )
  }
}
