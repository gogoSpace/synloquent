declare module 'scheduler' {
  export interface ScheduledTask {
    readonly __nativeScheduledTask?: never
  }
  export const unstable_NormalPriority: number
  export function unstable_scheduleCallback(
    priority: number,
    callback: (didTimeout: boolean) => void,
  ): ScheduledTask
  export function unstable_cancelCallback(task: ScheduledTask): void
}
