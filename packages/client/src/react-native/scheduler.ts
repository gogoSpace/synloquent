import {
  unstable_NormalPriority,
  unstable_scheduleCallback,
  unstable_cancelCallback,
} from 'scheduler'

export function monotonicMilliseconds(): number {
  const clock = (
    globalThis as typeof globalThis & {
      readonly performance?: { now(): number }
    }
  ).performance
  if (!clock) throw new Error('React Native requires a monotonic clock.')
  const result = clock.now()
  if (!Number.isFinite(result)) throw new Error('Invalid monotonic clock.')
  return result
}

/** The installed scheduler native entry dispatches these public exports to React. */
export function scheduleApplication(
  callback: () => void,
  delayMilliseconds: number,
): () => void {
  if (delayMilliseconds > 0) {
    const timer = setTimeout(callback, delayMilliseconds)
    return () => clearTimeout(timer)
  }
  assertNativeScheduler()
  const task = unstable_scheduleCallback(unstable_NormalPriority, callback)
  return () => unstable_cancelCallback(task)
}

export function assertNativeScheduler(): void {
  const binding = (
    globalThis as typeof globalThis & {
      readonly nativeRuntimeScheduler?: {
        readonly unstable_scheduleCallback?: unknown
        readonly unstable_cancelCallback?: unknown
      }
    }
  ).nativeRuntimeScheduler
  if (
    !binding ||
    typeof binding.unstable_scheduleCallback !== 'function' ||
    typeof binding.unstable_cancelCallback !== 'function'
  )
    throw new Error(
      'React Native requires its native RuntimeScheduler binding.',
    )
}

export function yieldToApplication(): Promise<void> {
  return new Promise((resolve) => scheduleApplication(resolve, 0))
}
