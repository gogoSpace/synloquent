import { Platform } from 'react-native'
import {
  androidProbeIdentity,
  updateAndroidInteractionPhase,
} from './nativeAndroidInteraction'
import {
  iosProbeIdentity,
  updateIOSInteractionPhase,
} from './nativeIOSInteraction'

const address = 'http://127.0.0.1:8767'
import { calibrationInteractionBinding } from './nativeCalibrationInteractionBinding'

let phase = 'inactive'
const listeners = new Set<(phase: string) => void>()
export function subscribeInteractionPhase(
  listener: (phase: string) => void,
): () => void {
  listeners.add(listener)
  listener(phase)
  return () => {
    listeners.delete(listener)
  }
}
export function observeInteraction(type: 'input' | 'scroll'): void {
  if (phase === 'inactive') return
  void fetch(address + '/ui/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase, type, applicationReceivedAt: Date.now() }),
  }).catch(() => undefined)
}
export async function interactionPhase(next: string): Promise<void> {
  phase = next
  for (const listener of listeners) listener(next)
  const response = await fetch(address + '/ui/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phase: next,
      ...calibrationInteractionBinding(),
      probeIdentity:
        Platform.OS === 'android' ? androidProbeIdentity() : iosProbeIdentity(),
    }),
  })
  if (!response.ok)
    throw new Error('The native UI driver phase was not accepted.')
  if (Platform.OS === 'android') updateAndroidInteractionPhase(next)
  if (Platform.OS === 'ios') updateIOSInteractionPhase(next)
}
export async function awaitIdleInteraction(): Promise<void> {
  await interactionPhase('idle')
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const response = await fetch(address + '/ui/report')
    const report: {
      phases: Record<string, { inputEvents: number; scrollEvents: number }>
    } = await response.json()
    if (
      (report.phases.idle?.inputEvents ?? 0) >= 2 &&
      (report.phases.idle?.scrollEvents ?? 0) >= 2
    )
      return
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Actual native idle input and scroll were not delivered.')
}
export async function interactionReport(): Promise<unknown> {
  await interactionPhase('inactive')
  const response = await fetch(address + '/ui/report')
  return response.json()
}
