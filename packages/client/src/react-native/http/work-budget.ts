export interface HttpCancellation {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void): void
  removeEventListener(type: 'abort', listener: () => void): void
}

/** One budget covers decode, envelope checks and payload validation. */
export class HttpWorkBudget {
  private sliceStarted: number
  private workUnits = 0
  private clockUnits = 0
  private maximumMeasurementSlice = 0
  private measurementStarted: number
  private hostTurnStarted: number
  constructor(
    private readonly configuration: {
      readonly now: () => number
      readonly deadline: number
      readonly cancellation: HttpCancellation
      readonly abort: () => void
      readonly schedule: (
        callback: () => void,
        delayMilliseconds: number,
      ) => () => void
    },
  ) {
    this.sliceStarted = configuration.now()
    this.measurementStarted = this.sliceStarted
    this.hostTurnStarted = this.sliceStarted
  }

  assertActive(): void {
    if (this.configuration.now() >= this.configuration.deadline)
      this.configuration.abort()
    if (this.configuration.cancellation.aborted) {
      const failure = new Error('The HTTP response processing was aborted.')
      failure.name = 'AbortError'
      throw failure
    }
  }

  beginMeasurement(): void {
    this.maximumMeasurementSlice = 0
    this.measurementStarted = this.configuration.now()
  }

  endMeasurement(): number {
    this.maximumMeasurementSlice = Math.max(
      this.maximumMeasurementSlice,
      this.configuration.now() -
        Math.max(this.sliceStarted, this.measurementStarted),
    )
    return this.maximumMeasurementSlice
  }

  shouldYield(workUnits = 1): boolean {
    this.workUnits += workUnits
    this.clockUnits += workUnits
    if (this.clockUnits < 256 && this.workUnits < 8192) return false
    this.clockUnits = 0
    this.assertActive()
    return (
      this.workUnits >= 8192 ||
      this.configuration.now() - this.sliceStarted >= 2
    )
  }

  async yield(): Promise<void> {
    this.assertActive()
    this.endMeasurement()
    // Native scheduler tasks can drain one host turn indefinitely. Periodic
    // timer turns let the native display link deliver frames and input.
    const delayMilliseconds =
      this.configuration.now() - this.hostTurnStarted >= 8 ? 1 : 0
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let cancelTask: () => void = () => undefined
      const cancellation = this.configuration.cancellation
      const finish = (failure?: unknown): void => {
        if (settled) return
        settled = true
        cancellation.removeEventListener('abort', aborted)
        if (failure === undefined) resolve()
        else {
          cancelTask()
          reject(failure)
        }
      }
      const aborted = (): void => {
        try {
          this.assertActive()
        } catch (failure) {
          finish(failure)
        }
      }
      cancellation.addEventListener('abort', aborted)
      try {
        cancelTask = this.configuration.schedule(() => {
          this.sliceStarted = this.configuration.now()
          if (delayMilliseconds > 0) this.hostTurnStarted = this.sliceStarted
          this.workUnits = 0
          this.clockUnits = 0
          finish()
        }, delayMilliseconds)
        if (settled) cancelTask()
        else if (cancellation.aborted) aborted()
        this.endMeasurement()
      } catch (failure) {
        finish(failure)
      }
    })
    this.assertActive()
  }
}
