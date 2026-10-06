import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import typescript from 'typescript'
import * as clientApi from '../src/index.js'
import type { ClientConfiguration, MemoryBudgetPolicy } from '../src/index.js'
import { manifest } from './fixtures.js'
import { openTestDatabase } from './sqlite.js'

async function fixture() {
  const events: string[] = []
  const ownedPolicies: MemoryBudgetPolicy[] = []
  let databaseCount = 0
  const digest = async (content: string) =>
    createHash('sha256').update(content).digest('hex')
  const digestChunks = async (content: AsyncIterable<string>) => {
    const hash = createHash('sha256')
    for await (const chunk of content) hash.update(chunk)
    return hash.digest('hex')
  }
  const dependencies: Record<string, unknown> = {
    '@synloquent/client': clientApi,
    '@synloquent/client/sqlite': {
      createDatabaseAdapter() {
        databaseCount++
        const database = openTestDatabase()
        return {
          ...database,
          async close() {
            databaseCount--
            await database.close()
          },
        }
      },
    },
    '@synloquent/client/react-native': {
      createNativeMemoryBudget() {
        events.push('memory:create')
        const policy = clientApi.createMemoryBudgetPolicy({
          nowMilliseconds: () => performance.now(),
        })
        ownedPolicies.push(policy)
        return {
          policy,
          async refresh() {
            events.push('memory:refresh')
          },
          reset() {
            events.push('memory:reset')
          },
          close() {
            events.push('memory:close')
            policy.close()
          },
        }
      },
    },
    '@op-engineering/op-sqlite': {},
    'react-native': {},
    '../backend.generated': { backendSchema: manifest },
    './httpTransport': {
      createExampleTransport() {
        return {
          suspend() {
            events.push('transport:suspend')
          },
          async close() {
            events.push('transport:close')
          },
        }
      },
    },
    './nativeCrypto': {},
    './nativeMemory': {},
    './platform': {
      nativeClock: { now: () => performance.now() },
      generateIdentity: () => 'controlled-identity',
      createMeasuredCryptoProvider() {
        return {
          digest,
          digestChunks,
          async close() {
            events.push('crypto:close')
          },
        }
      },
      schedule: (callback: () => void) => {
        const timeout = setTimeout(callback, 0)
        return () => clearTimeout(timeout)
      },
    },
    '../../../packages/client/tests/native/driver-spike': {},
  }
  const source = await readFile(
    new URL(
      '../../../examples/react-native/src/nativeQualification.ts',
      import.meta.url,
    ),
    'utf8',
  )
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.CommonJS,
    },
  }).outputText
  const exported = {} as {
    makeExampleClient(
      name: string,
      address: string,
      schema: typeof manifest,
      diagnostics?: Partial<ClientConfiguration>,
    ): Promise<Awaited<ReturnType<typeof clientApi.createSynloquent>>>
  }
  new Function('require', 'exports', compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected source dependency ${name}`)
    return dependencies[name]
  }, exported)
  return {
    events,
    ownedPolicies,
    makeClient: (
      diagnostics?: Partial<ClientConfiguration>,
      schema: typeof manifest = manifest,
    ) =>
      exported.makeExampleClient(
        'owned.sqlite',
        'https://owned.invalid',
        schema,
        diagnostics,
      ),
    get databaseCount() {
      return databaseCount
    },
  }
}

test('ordinary example composition owns one native memory controller and closes it once', async () => {
  const control = await fixture()
  const client = await control.makeClient()
  try {
    assert.deepEqual(control.events, ['memory:create'])
    await client.sync.setSession({
      ...client.storage.session,
      generation: client.storage.session.generation + 1,
    })
    assert.equal(
      control.events.filter((event) => event === 'memory:reset').length,
      1,
    )
  } finally {
    await client.close()
    await client.close()
  }
  assert.equal(
    control.events.filter((event) => event === 'memory:close').length,
    1,
  )
  assert.equal(control.databaseCount, 0)
  assert.equal(control.ownedPolicies[0]!.current().reason, 'closed')
})

test('an injected fixed comparison policy owns no unused native sampler', async () => {
  const control = await fixture()
  const policy = clientApi.createMemoryBudgetPolicy({
    nowMilliseconds: () => performance.now(),
  })
  let refreshes = 0
  const client = await control.makeClient({
    memoryBudget: policy,
    refreshMemoryBudget: async () => {
      refreshes++
    },
  })
  try {
    assert.equal(client.storage.configuration.memoryBudget, policy)
    await client.storage.configuration.refreshMemoryBudget!()
    assert.equal(refreshes, 1)
    assert.equal(control.events.includes('memory:create'), false)
  } finally {
    await client.close()
    await client.close()
  }
  assert.equal(control.events.includes('memory:close'), false)
  assert.equal(policy.current().reason, 'startup')
  assert.equal(control.databaseCount, 0)
  policy.close()
})

test('an injected comparison policy without refresh adds no unrelated default sampler', async () => {
  const control = await fixture()
  const policy = clientApi.createMemoryBudgetPolicy({
    nowMilliseconds: () => performance.now(),
  })
  const client = await control.makeClient({ memoryBudget: policy })
  try {
    assert.equal(client.storage.configuration.refreshMemoryBudget, undefined)
    assert.equal(control.events.includes('memory:create'), false)
  } finally {
    await client.close()
    policy.close()
  }
  assert.equal(control.databaseCount, 0)
})

for (const injected of [false, true]) {
  test(`failed example initialization closes its owned database and preserves caller policy ownership (${injected})`, async () => {
    const control = await fixture()
    const policy = clientApi.createMemoryBudgetPolicy({
      nowMilliseconds: () => performance.now(),
    })
    try {
      await assert.rejects(
        control.makeClient(injected ? { memoryBudget: policy } : undefined, {
          ...manifest,
          fingerprint: '',
        }),
        { code: 'schema_mismatch' },
      )
      assert.equal(
        control.events.filter((event) => event === 'transport:close').length,
        1,
      )
      assert.equal(
        control.events.filter((event) => event === 'crypto:close').length,
        1,
      )
      assert.equal(
        control.events.filter((event) => event === 'memory:close').length,
        injected ? 0 : 1,
      )
      assert.equal(control.databaseCount, 0)
      assert.equal(policy.current().reason, 'startup')
    } finally {
      policy.close()
    }
  })
}
