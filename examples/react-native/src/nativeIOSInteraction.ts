import type {
  GestureResponderEvent,
  NativeSyntheticEvent,
  NativeScrollEvent,
  TextInputChangeEvent,
} from 'react-native'

import { calibrationInteractionBinding } from './nativeCalibrationInteractionBinding'

const address = 'http://127.0.0.1:8767'
let probeSequence = 0
const probeRegistry: { current: IOSInteractionProbe | undefined } = {
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

function scalar(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function iosProbeIdentity(): string | undefined {
  return probeRegistry.current?.identity
}
export function updateIOSInteractionPhase(phase: string): void {
  probeRegistry.current?.changePhase(phase)
}

export class IOSInteractionProbe {
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
  private focusedTarget: number | null = null
  private focusReceipt: Promise<void> = Promise.resolve()
  private acknowledgedAction: Action | undefined
  private armingAction: Action | undefined
  private pendingRequests = 0

  constructor(
    private readonly clearInput: () => void,
    private readonly readScrollTarget: () =>
      { node: number | undefined; current: unknown } | undefined,
  ) {}

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
    if (this.pendingRequests >= 64) {
      if (!this.receiptOverflow) {
        this.receiptOverflow = true
        void fetch(address + '/ui/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phase: this.phase,
            probeIdentity: this.identity,
            type: 'input',
            actionId: null,
            acceptedCandidate: false,
            reason: 'bounded-receipt-overflow',
            applicationReceivedAt: Date.now(),
          }),
        }).catch(() => undefined)
      }
      throw new Error(
        'The strict iOS receipt producer exceeded bounded capacity.',
      )
    }
    this.pendingRequests += 1
    try {
      const response = await fetch(address + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      })
      if (!response.ok)
        throw new Error('The native interaction receipt was refused.')
    } finally {
      this.pendingRequests -= 1
    }
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
      await this.acknowledgeArm(this.armed)
      // The next offer remains pending until the previous host action is closed.
    }
  }

  private async acknowledgeArm(action: Action | undefined): Promise<void> {
    if (
      !action ||
      this.closed ||
      this.armed !== action ||
      action.phase !== this.phase ||
      this.acknowledgedAction === action ||
      this.armingAction === action
    )
      return
    this.armingAction = action
    try {
      await this.focusReceipt
      if (this.closed || this.armed !== action || action.phase !== this.phase)
        return
      const target =
        action.type === 'input'
          ? this.focusedTarget
          : this.readScrollTarget()?.node
      if (
        !Number.isSafeInteger(target) ||
        target === undefined ||
        target === null ||
        target <= 0
      )
        return
      const response = await fetch(address + '/ui/action/armed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phase: action.phase,
          probeIdentity: this.identity,
          actionId: action.id,
          target,
          focused: action.type === 'input',
          targetSource:
            action.type === 'input'
              ? 'native-payload'
              : 'current-target-public-ref',
        }),
      })
      const result: { accepted?: boolean } = await response.json()
      if (!response.ok || result.accepted !== true)
        throw new Error('The strict iOS arm was refused.')
      if (this.armed === action && !this.closed)
        this.acknowledgedAction = action
    } finally {
      if (this.armingAction === action) this.armingAction = undefined
    }
  }

  private scrollIdentity(event: NativeSyntheticEvent<NativeScrollEvent>): {
    target: number | null
    currentTargetMatches: boolean
    rawNativePayloadTarget: number | null
  } {
    const current = this.readScrollTarget()
    const raw = scalar(
      (event.nativeEvent as NativeScrollEvent & { target?: number }).target,
    )
    const matched = Boolean(
      current &&
      event.currentTarget === current.current &&
      Number.isSafeInteger(current.node) &&
      current.node !== undefined &&
      current.node > 0 &&
      (raw === null || raw === current.node),
    )
    return {
      target: matched ? current!.node! : null,
      currentTargetMatches: matched,
      rawNativePayloadTarget: raw,
    }
  }

  onFocus = (event: NativeSyntheticEvent<{ target: number }>): void => {
    const target = scalar(event.nativeEvent.target)
    this.focusedTarget = this.closed ? null : target
    this.focusReceipt = this.post('/ui/ios/focus', {
      phase: this.phase,
      probeIdentity: this.identity,
      target,
      focused: !this.closed,
      targetSource: 'native-payload',
    })
    void this.focusReceipt
      .then(() => this.acknowledgeArm(this.armed))
      .catch(() => undefined)
  }

  onBlur = (event: NativeSyntheticEvent<{ target: number }>): void => {
    this.focusedTarget = null
    this.focusReceipt = this.post('/ui/ios/focus', {
      phase: this.phase,
      probeIdentity: this.identity,
      target: scalar(event.nativeEvent.target),
      focused: false,
      targetSource: 'native-payload',
    })
    void this.focusReceipt.catch(() => undefined)
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
        applicationReceivedAt: Date.now(),
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
      applicationReceivedAt: Date.now(),
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
        targetSource: 'native-payload',
        focused:
          this.focusedTarget !== null &&
          this.focusedTarget === scalar(value.target),
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
        targetSource: 'native-payload',
      },
    )
  }

  onScrollEndDrag = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const value = event.nativeEvent as NativeScrollEvent & {
      timestamp?: number
      target?: number
    }
    const timestamp = scalar(value.timestamp)
    const { target, ...identity } = this.scrollIdentity(event)
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
          targetSource: 'current-target-public-ref',
          ...identity,
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
      targetSource: 'current-target-public-ref',
      ...identity,
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
    const { target, ...identity } = this.scrollIdentity(event)
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
        targetSource: 'current-target-public-ref',
        ...identity,
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
    this.report('scroll', action, false, 'native-drag-begin', {
      nativeTimestamp: timestamp,
      target,
      targetSource: 'current-target-public-ref',
      ...identity,
      gestureStartedNativeMilliseconds: timestamp,
    })
  }

  onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const value = event.nativeEvent as NativeScrollEvent & {
      timestamp?: number
      target?: number
    }
    const timestamp = scalar(value.timestamp)
    const { target, ...identity } = this.scrollIdentity(event)
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
        targetSource: 'current-target-public-ref',
        ...identity,
        gestureStartedNativeMilliseconds:
          association?.startedNativeMilliseconds ?? null,
        offsetX: scalar(value.contentOffset?.x),
        offsetY: scalar(value.contentOffset?.y),
      },
    )
  }
}
