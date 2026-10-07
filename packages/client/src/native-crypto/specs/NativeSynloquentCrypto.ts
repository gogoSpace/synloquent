import type { CodegenTypes, TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

export interface HashResult {
  readonly digest: string
  readonly bytes: number
  readonly cpuMilliseconds: number
  readonly wallMilliseconds: number
}

export type NativeMemorySample = {
  processHeadroomBytes: number | null
  systemAvailableBytes: number | null
  systemLowMemoryThresholdBytes: number | null
  systemLowMemory: boolean | null
  sampledAtMonotonicMilliseconds: number
}

export type NativeMemoryPressure = {
  source?: string
  trimMemoryLevel?: number
  kind: string
  observedAtMonotonicMilliseconds: number
}

export interface Spec extends TurboModule {
  threadCpuMilliseconds(): number
  sampleMemory(): Promise<NativeMemorySample>
  readonly onMemoryPressure: CodegenTypes.EventEmitter<NativeMemoryPressure>
  start(): Promise<string>
  append(identifier: string, content: string): Promise<void>
  finish(identifier: string): Promise<HashResult>
  cancel(identifier: string): Promise<void>
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeSynloquentCrypto')
