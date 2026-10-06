import { Platform } from 'react-native'
import {
  createNativeCryptoProvider,
  createNativeDigestLifecycle,
  callingThreadCpuMilliseconds,
  type NativeDigestMeasurement,
} from '@synloquent/client/native-crypto'
import {
  digest,
  digestChunks,
  nativeClock,
  yieldToApplication,
} from './platform'
import type { NativeSpikeResult } from '../../../packages/client/tests/native/driver-spike'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function rejected(callback: () => Promise<unknown>): Promise<boolean> {
  try {
    await callback()
    return false
  } catch {
    return true
  }
}

export async function verifyNativeCryptography() {
  const cpuStarted = callingThreadCpuMilliseconds()
  const busyStarted = nativeClock.now()
  const maximumBusyIterations = 1_048_576
  let busyIterations = 0
  let busyChecksum = 0x811c9dc5
  while (busyIterations < maximumBusyIterations) {
    busyChecksum = Math.imul(busyChecksum ^ busyIterations, 16777619)
    busyIterations += 1
  }
  const busyWallMilliseconds = nativeClock.now() - busyStarted
  const busyCpuMilliseconds = callingThreadCpuMilliseconds() - cpuStarted
  const idleCpuStarted = callingThreadCpuMilliseconds()
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  const idleCpuMilliseconds = callingThreadCpuMilliseconds() - idleCpuStarted
  assert(
    busyIterations === maximumBusyIterations &&
      busyChecksum === 724344261 &&
      busyIterations > 0 &&
      busyCpuMilliseconds >= 1 &&
      busyCpuMilliseconds <= busyWallMilliseconds * 1.5 &&
      idleCpuMilliseconds < busyCpuMilliseconds * 0.5,
    `The diagnostic CPU clock must sample the calling Hermes thread across busy and awaited idle controls. ${JSON.stringify({ busyWallMilliseconds, busyCpuMilliseconds, idleCpuMilliseconds, busyIterations, busyChecksum })}`,
  )
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'Žluťoučký 🧭',
      'a17a209398270f3520aa7254cdc26406e26d8464d47e3a741caf4a34d2d221d5',
    ],
    [
      '\ud800',
      '83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097',
    ],
    [
      'A'.repeat(65536),
      '156c38442089c1323d3e3ba549a6ac24341c47e8b6367bec4740c9b8c865826e',
    ],
  ] as const
  for (const [content, expected] of vectors)
    assert(
      (await digest(content)) === expected,
      'System SHA256 must match independent UTF8 vectors.',
    )
  async function* splitSurrogate(): AsyncIterable<string> {
    yield 'Žluťoučký \ud83e'
    yield '\udded'
  }
  assert(
    (await digestChunks(splitSurrogate())) === vectors[2][1],
    'Native streaming must retain a split surrogate pair.',
  )
  const simultaneous = await Promise.all([digest('first'), digest('second')])
  assert(
    simultaneous[0] ===
      'a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e' &&
      simultaneous[1] ===
        '16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4',
    'Concurrent SHA256 streams must retain isolated contexts.',
  )
  const defaultProvider = createNativeCryptoProvider()
  try {
    assert(
      (await defaultProvider.digest('abc')) === vectors[1][1],
      'The public provider must support its bounded default native yield.',
    )
    async function* failing(): AsyncIterable<string> {
      yield 'abc'
      throw new Error('Deliberate producer failure.')
    }
    assert(
      await rejected(() => defaultProvider.digestChunks(failing())),
      'Producer failures must reject and release their native context.',
    )
    const constructionFailure: AsyncIterable<string> = {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        throw new Error('Deliberate iterator construction failure.')
      },
    }
    assert(
      await rejected(() => defaultProvider.digestChunks(constructionFailure)),
      'Iterator construction failures must release their native context.',
    )
    let producerFinally = false
    let artificialClock = 0
    const failingConsumer = createNativeCryptoProvider({
      nowMilliseconds: () => (artificialClock += 2),
      yieldToApplication: async () => {
        throw new Error('Deliberate consumer yield failure.')
      },
    })
    async function* producer(): AsyncIterable<string> {
      try {
        for (let index = 0; index < 10; index += 1) yield 'abc'
      } finally {
        producerFinally = true
      }
    }
    try {
      assert(
        await rejected(() => failingConsumer.digestChunks(producer())),
        'Consumer failures must reject the digest.',
      )
      await yieldToApplication()
      assert(
        producerFinally,
        'Consumer failures must request producer iterator.return().',
      )
    } finally {
      await failingConsumer.close()
    }
    let returnRequested = false
    let markReadStarted: () => void = () => undefined
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    let deliverLate: (value: IteratorResult<string>) => void = () => undefined
    const pendingRead = new Promise<IteratorResult<string>>((resolve) => {
      deliverLate = resolve
    })
    const stuckProducer: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            markReadStarted()
            return pendingRead
          },
          return() {
            returnRequested = true
            return new Promise<IteratorResult<string>>(() => undefined)
          },
        }
      },
    }
    const lifecycle = createNativeDigestLifecycle()
    const pending = defaultProvider.digestChunks(
      stuckProducer,
      lifecycle.lifecycle,
    )
    const pendingRejected = pending.then(
      () => false,
      () => true,
    )
    await readStarted
    const cancelStarted = nativeClock.now()
    lifecycle.cancel()
    assert(
      await pendingRejected,
      'Cancellation must race a stuck producer.next().',
    )
    assert(
      returnRequested && nativeClock.now() - cancelStarted < 1000,
      'Cancellation must release native state without waiting for a stuck producer.return().',
    )
    deliverLate({ done: false, value: 'late producer result' })
    await yieldToApplication()
    assert(
      (await defaultProvider.digest('abc')) === vectors[1][1],
      'Late producer results must not reactivate cancelled contexts.',
    )
  } finally {
    await defaultProvider.close()
  }
  const closingProvider = createNativeCryptoProvider()
  let closeReadStarted: () => void = () => undefined
  const closeReady = new Promise<void>((resolve) => {
    closeReadStarted = resolve
  })
  const closeSource: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          closeReadStarted()
          return new Promise<IteratorResult<string>>(() => undefined)
        },
      }
    },
  }
  const closingDigest = closingProvider.digestChunks(closeSource).then(
    () => false,
    () => true,
  )
  await closeReady
  await closingProvider.close()
  assert(
    (await closingDigest) &&
      (await rejected(() => closingProvider.digest('abc'))),
    'Provider close must cancel pending reads and reject new work.',
  )
  const capacityProvider = createNativeCryptoProvider()
  const capacityLifecycles = Array.from(
    { length: 8 },
    createNativeDigestLifecycle,
  )
  const streams: Promise<boolean>[] = []
  let readyStreams = 0
  let prematurelyRejected = false
  try {
    for (const lifecycle of capacityLifecycles) {
      const source: AsyncIterable<string> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              readyStreams += 1
              return new Promise<IteratorResult<string>>(() => undefined)
            },
          }
        },
      }
      streams.push(
        capacityProvider.digestChunks(source, lifecycle.lifecycle).then(
          () => false,
          () => {
            prematurelyRejected = true
            return true
          },
        ),
      )
    }
    const deadline = nativeClock.now() + 2000
    while (
      readyStreams < 8 &&
      !prematurelyRejected &&
      nativeClock.now() < deadline
    )
      await yieldToApplication()
    assert(
      readyStreams === 8 && !prematurelyRejected,
      'Every failed or cancelled prior stream must release its native context.',
    )
    assert(
      await rejected(() => capacityProvider.digest('abc')),
      'The native worker must enforce its eight-context admission limit.',
    )
    for (const lifecycle of capacityLifecycles) lifecycle.cancel()
    assert(
      (await Promise.all(streams)).every(Boolean),
      'All capacity streams must cancel.',
    )
  } finally {
    await capacityProvider.close()
  }
  let measurement: NativeDigestMeasurement | undefined
  const measuredProvider = createNativeCryptoProvider({
    observeDigest: (result) => {
      measurement = result
    },
  })
  try {
    assert(
      (await measuredProvider.digest(vectors[4][0])) === vectors[4][1],
      'Reused native capacity must retain system SHA correctness.',
    )
  } finally {
    await measuredProvider.close()
  }
  assert(
    measurement &&
      measurement.nativeHashBytes === 65536 &&
      measurement.maximumBufferedUtf16Units === 65536 &&
      measurement.nativeHashCpuMilliseconds >= 0,
    'The bounded public provider must report actual native byte and CPU evidence.',
  )
  return {
    vectors: vectors.length,
    splitSurrogate: true,
    simultaneousStreams: 2,
    producerErrorCleanup: true,
    consumerErrorIteratorReturn: true,
    failedIteratorConstructionCancelled: true,
    stuckIteratorCancelled: true,
    stuckReturnDoesNotBlockCleanup: true,
    lateResultIgnored: true,
    providerCloseCancelsPendingReads: true,
    publicDefaultProvider: true,
    contextCapacity: 8,
    maximumBufferedUtf16Units: measurement.maximumBufferedUtf16Units,
    workerCpuMilliseconds: measurement.nativeHashCpuMilliseconds,
    workerWallMilliseconds: measurement.nativeHashWallMilliseconds,
    callingThreadCpuControl: {
      busyWallMilliseconds,
      busyCpuMilliseconds,
      idleCpuMilliseconds,
      busyIterations,
      busyChecksum,
    },
  }
}

export async function runNativeCryptoValidation(): Promise<NativeSpikeResult> {
  const startedAt = new Date().toISOString()
  const started = nativeClock.now()
  try {
    const detail = await verifyNativeCryptography()
    return {
      platform: Platform.OS,
      hermes: true,
      status: 'passed',
      checks: [
        {
          name: 'system native SHA256 streaming lifecycle',
          durationMilliseconds: nativeClock.now() - started,
          detail,
        },
      ],
      startedAt,
      finishedAt: new Date().toISOString(),
    }
  } catch (failure) {
    return {
      platform: Platform.OS,
      hermes: true,
      status: 'failed',
      checks: [],
      error: String(failure),
      startedAt,
      finishedAt: new Date().toISOString(),
    }
  }
}
