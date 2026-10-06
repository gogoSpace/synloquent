import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import typescript from 'typescript'
import type { DigestLifecycle } from '../src/core/types.js'

interface SchedulingConfiguration {
  nowMilliseconds(): number
  yieldToApplication(): Promise<void>
}

interface DigestProvider {
  digestChunks(
    chunks: AsyncIterable<string>,
    lifecycle?: DigestLifecycle,
  ): Promise<string>
  close(): Promise<void>
}

interface NativeDigestStub {
  start(): Promise<string>
  append(identifier: string, content: string): Promise<void>
  finish(identifier: string): Promise<{
    digest: string
    bytes: number
    cpuMilliseconds: number
    wallMilliseconds: number
  }>
  cancel(identifier: string): Promise<void>
}

async function providerFactory(native: NativeDigestStub) {
  const source = await readFile(
    process.env.SYNLOQUENT_NATIVE_CRYPTO_BASELINE
      ? resolve(process.env.SYNLOQUENT_NATIVE_CRYPTO_BASELINE)
      : new URL('../src/native-crypto/index.ts', import.meta.url),
    'utf8',
  )
  const withoutBindingImport = source.replace(
    /^import NativeSynloquentCrypto from '[^']+'\n/,
    '',
  )
  assert.notEqual(withoutBindingImport, source)
  const compiled = typescript.transpileModule(withoutBindingImport, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.CommonJS,
    },
  }).outputText
  const exported: {
    createNativeCryptoProvider?: (
      configuration: SchedulingConfiguration,
    ) => DigestProvider
    createNativeDigestLifecycle?: () => {
      lifecycle: DigestLifecycle
      cancel(): void
    }
  } = {}
  new Function('NativeSynloquentCrypto', 'exports', compiled)(native, exported)
  assert.ok(exported.createNativeCryptoProvider)
  assert.ok(exported.createNativeDigestLifecycle)
  return {
    createProvider: exported.createNativeCryptoProvider,
    createLifecycle: exported.createNativeDigestLifecycle,
  }
}

function nativeStub(onAppend: () => void = () => undefined) {
  const contents: string[] = []
  const cancelled: string[] = []
  const native: NativeDigestStub = {
    async start() {
      return 'owned-hash-stream'
    },
    async append(identifier, content) {
      assert.equal(identifier, 'owned-hash-stream')
      onAppend()
      contents.push(content)
    },
    async finish(identifier) {
      assert.equal(identifier, 'owned-hash-stream')
      const content = contents.join('')
      return {
        digest: createHash('sha256').update(content).digest('hex'),
        bytes: Buffer.byteLength(content),
        cpuMilliseconds: 1,
        wallMilliseconds: 1,
      }
    },
    async cancel(identifier) {
      cancelled.push(identifier)
    },
  }
  return { native, contents, cancelled }
}

test('C55 native append Promise completion cannot indefinitely postpone actual application scheduling during digest production', async () => {
  let milliseconds = 0
  let applicationYields = 0
  let lastApplicationBoundary = 0
  let maximumProductionInterval = 0
  const chunk = 'x'.repeat(65536)
  const binding = nativeStub(() => {
    milliseconds += 1
  })
  const { createProvider } = await providerFactory(binding.native)
  const provider = createProvider({
    nowMilliseconds: () => milliseconds,
    async yieldToApplication() {
      maximumProductionInterval = Math.max(
        maximumProductionInterval,
        milliseconds - lastApplicationBoundary,
      )
      applicationYields += 1
      lastApplicationBoundary = milliseconds
    },
  })
  async function* producing(): AsyncGenerator<string> {
    for (let index = 0; index < 12; index++) {
      milliseconds += 3
      yield chunk
    }
  }
  try {
    const actual = await provider.digestChunks(producing())
    assert.equal(
      actual,
      createHash('sha256').update(chunk.repeat(12)).digest('hex'),
    )
    assert.ok(
      applicationYields >= 10,
      'Native Promise completions starved the application scheduler',
    )
    assert.ok(maximumProductionInterval <= 4)
  } finally {
    await provider.close()
  }
})

test('C51 C55 cancelling at an actual digest scheduling boundary returns its producer and releases the native context', async () => {
  let milliseconds = 0
  let returned = false
  const binding = nativeStub(() => {
    milliseconds += 1
  })
  const { createProvider, createLifecycle } = await providerFactory(
    binding.native,
  )
  const lifecycle = createLifecycle()
  const provider = createProvider({
    nowMilliseconds: () => milliseconds,
    async yieldToApplication() {
      lifecycle.cancel()
    },
  })
  async function* producing(): AsyncGenerator<string> {
    try {
      for (let index = 0; index < 12; index++) {
        milliseconds += 3
        yield 'x'.repeat(65536)
      }
    } finally {
      returned = true
    }
  }
  try {
    await assert.rejects(
      provider.digestChunks(producing(), lifecycle.lifecycle),
      { name: 'NativeDigestCancelledError' },
    )
    assert.equal(returned, true)
    assert.deepEqual(binding.cancelled, ['owned-hash-stream'])
    assert.ok(binding.contents.join('').length > 0)
    assert.ok(binding.contents.join('').length <= 65536)
  } finally {
    await provider.close()
  }
})

test('C55 actual native provider retains canonical Unicode bytes while cooperative scheduling crosses bounded buffers', async () => {
  let milliseconds = 0
  const binding = nativeStub(() => {
    milliseconds += 1
  })
  const { createProvider } = await providerFactory(binding.native)
  const provider = createProvider({
    nowMilliseconds: () => milliseconds,
    yieldToApplication: async () => undefined,
  })
  const pieces = ['a'.repeat(65535) + '\ud83d', '\ude00', '\ud800', 'z']
  try {
    const actual = await provider.digestChunks(
      (async function* () {
        for (const piece of pieces) {
          milliseconds += 3
          yield piece
        }
      })(),
    )
    assert.equal(
      actual,
      createHash('sha256').update(pieces.join('')).digest('hex'),
    )
    assert.ok(binding.contents.every((content) => content.length <= 65536))
  } finally {
    await provider.close()
  }
})
