import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { Ajv2020 } from 'ajv/dist/2020.js'

const validator = new Ajv2020({ strict: true, allErrors: true })
const schemaDirectory = new URL('../schemas/', import.meta.url)
for (const filename of readdirSync(schemaDirectory).filter((name) =>
  name.endsWith('.json'),
)) {
  validator.addSchema(
    JSON.parse(readFileSync(new URL(filename, schemaDirectory), 'utf8')),
  )
}
const check = (name: string, value: unknown): boolean => {
  const validate = validator.getSchema(
    `https://synloquent.local/protocol/1/${name}.schema.json`,
  )
  assert.ok(validate, `Registered schema ${name}`)
  const result = validate(value)
  return result
}
const session = {
  accountId: 'actor-one',
  tenantId: 'tenant-one',
  deviceId: 'device-one',
  deviceEpoch: 'epoch-one',
  generation: 0,
}
const operation = {
  operationId: 'operation-one',
  model: 'Item',
  localIdentity: 'local-one',
  action: 'create',
  values: {
    title: 'Literal $value',
    category_id: { $ref: { model: 'Category', localIdentity: 'category-one' } },
  },
  dependsOn: ['category-operation'],
}
const record = {
  model: 'Item',
  id: '9007199254740993',
  revision: '1',
  attributes: {
    id: '9007199254740993',
    title: 'Český název',
    price: '9007199254740993.01',
    acquired_on: '2026-10-02',
    active: true,
    metadata: { nested: [null, 2] },
  },
}

test('all protocol schemas compile with strict validation', () => {
  const originalSchemaFilenames = [
    'envelope.schema.json',
    'error.schema.json',
    'field.schema.json',
    'manifest.schema.json',
    'operation.schema.json',
    'predicate.schema.json',
    'pull.schema.json',
    'query-response.schema.json',
    'query.schema.json',
    'receipt.schema.json',
    'record.schema.json',
    'relation-set.schema.json',
    'relation.schema.json',
    'scope.schema.json',
    'snapshot.schema.json',
    'value.schema.json',
  ]
  const boundedSchemaFilenames = [
    'snapshot-part-identity.schema.json',
    'snapshot-parts.schema.json',
  ]
  const actualSchemaFilenames = readdirSync(schemaDirectory)
    .filter((filename) => filename.endsWith('.json'))
    .sort()
  assert.deepEqual(
    actualSchemaFilenames,
    [...originalSchemaFilenames, ...boundedSchemaFilenames].sort(),
  )
  assert.equal(
    actualSchemaFilenames.filter((filename) =>
      originalSchemaFilenames.includes(filename),
    ).length,
    16,
  )
  assert.equal(
    actualSchemaFilenames.filter((filename) =>
      boundedSchemaFilenames.includes(filename),
    ).length,
    2,
  )
  assert.equal(actualSchemaFilenames.length, 18)
  for (const filename of actualSchemaFilenames)
    assert.ok(
      validator.getSchema(`https://synloquent.local/protocol/1/${filename}`),
      `Strict compilation of ${filename}`,
    )
})
test('bounded snapshot descriptors require each admission and readiness witness', () => {
  const descriptor = {
    schemaFingerprint: 'fingerprint',
    dataset: 'catalog',
    generation: 'generation-one',
    cursor: 'opaque-cursor',
    hash: 'a'.repeat(64),
    byteSize: 100,
    scope: {
      dataset: 'catalog',
      authorizationGeneration: '1',
      projectionGeneration: '1',
      schemaFingerprint: 'fingerprint',
      completeness: 'complete',
    },
    format: 'canonical-parts-v1',
    status: 'ready',
    partCount: 0,
    recordCount: 0,
    relationSetCount: 0,
    maximumPartBytes: 65536,
    maximumRowBytes: 0,
    partRowLimit: 256,
  }
  const part = {
    ordinal: 0,
    downloadUrl: '/parts/0',
    hash: 'b'.repeat(64),
    byteSize: 100,
    continuation: 'next-part-token',
  }
  assert.ok(check('snapshot-part-identity', part))
  assert.equal(
    check('snapshot-part-identity', { ...part, byteSize: 65537 }),
    false,
  )
  assert.equal(check('snapshot-parts', descriptor), false)
  assert.ok(
    check('snapshot-parts', {
      ...descriptor,
      confirmationToken: 'empty-snapshot-confirmation',
    }),
  )
  assert.equal(check('snapshot-parts', { ...descriptor, partCount: 1 }), false)
  assert.ok(
    check('snapshot-parts', {
      ...descriptor,
      partCount: 1,
      recordCount: 1,
      firstPart: part,
    }),
  )
  assert.equal(
    check('snapshot-parts', {
      ...descriptor,
      partCount: 0.5,
      firstPart: part,
    }),
    false,
  )
  const admission = { ...descriptor, status: 'admission-required' }
  assert.equal(check('snapshot-parts', admission), false)
  for (const reason of ['unsupported-host-contract', 'row-exceeds-part-budget'])
    assert.ok(check('snapshot-parts', { ...admission, reason }))
  assert.equal(
    check('snapshot-parts', { ...admission, reason: 'unexpected-reason' }),
    false,
  )
})
test('canonical operations preserve string identities and explicit references', () => {
  assert.ok(check('operation', operation))
  assert.ok(check('record', record))
  assert.ok(
    check('record', { ...record, localIdentity: 'accepted-offline-uuid' }),
  )
  assert.equal(check('record', { ...record, localIdentity: '' }), false)
  assert.equal(
    check('record', { ...record, localIdentity: 'x'.repeat(129) }),
    false,
  )
  assert.ok(check('operation', { ...operation, eventMode: 'bulk' }))
  assert.equal(
    check('operation', { ...operation, eventMode: 'arbitrary-dispatch' }),
    false,
  )
  assert.ok(
    check('receipt', {
      operationId: 'operation-one',
      localIdentity: 'local-one',
      status: 'accepted',
      canonical: record,
    }),
  )
})
test('envelope rejects executable dispatch, missing identity and wrong protocol version', () => {
  const envelope = {
    protocolVersion: 1,
    requestId: 'request-one',
    kind: 'push',
    schemaFingerprint: 'fingerprint',
    session,
    payload: { operations: [operation] },
  }
  assert.ok(check('envelope', envelope))
  assert.equal(check('envelope', { ...envelope, protocolVersion: 2 }), false)
  assert.equal(check('envelope', { ...envelope, kind: 'php-eval' }), false)
  assert.equal(
    check('envelope', { ...envelope, actor: 'another-actor' }),
    false,
  )
  assert.equal(
    check('envelope', { ...envelope, session: { ...session, generation: -1 } }),
    false,
  )
})
test('bounded query AST supports nested relation predicates and denies raw SQL', () => {
  const query = {
    model: 'Item',
    where: {
      kind: 'group',
      boolean: 'and',
      predicates: [
        { kind: 'comparison', field: 'price', operator: '>=', value: '10.01' },
        {
          kind: 'relation',
          relation: 'images',
          predicate: {
            kind: 'comparison',
            field: 'position',
            operator: 'between',
            value: [1, 4],
          },
        },
      ],
    },
    orderBy: [{ field: 'title', direction: 'asc' }],
    limit: 50,
  }
  assert.ok(check('query', query))
  assert.equal(check('query', { ...query, raw: 'DROP TABLE items' }), false)
  assert.equal(check('query', { ...query, limit: 10001 }), false)
  assert.equal(
    check('query', {
      ...query,
      where: {
        kind: 'comparison',
        field: 'title',
        operator: 'whereRaw',
        value: 'anything',
      },
    }),
    false,
  )
})
test('snapshot schema records immutable digest and complete scope separately from scan state', () => {
  const records = [record]
  const content = JSON.stringify({ records, relationSets: [] })
  const scope = {
    dataset: 'catalog',
    authorizationGeneration: '1',
    projectionGeneration: '1',
    schemaFingerprint: 'fingerprint',
    completeness: 'complete',
  }
  assert.ok(
    check('snapshot', {
      schemaFingerprint: 'fingerprint',
      dataset: 'catalog',
      generation: 'snapshot-one',
      cursor: 'opaque-cursor',
      hash: createHash('sha256').update(content).digest('hex'),
      byteSize: Buffer.byteLength(content),
      records,
      relationSets: [],
      scope,
    }),
  )
  assert.ok(
    check('pull', {
      batches: [
        {
          cursor: 'opaque-cursor',
          relationSets: [],
          changes: [{ kind: 'remove', model: 'Item', id: '1' }],
        },
      ],
      cursor: 'opaque-cursor',
      highWater: 'opaque-high-water',
      scanComplete: true,
      scope,
    }),
  )
  assert.equal(check('snapshot', { records }), false)
})
test('unknown and changed mutation shapes fail closed', () => {
  assert.equal(check('operation', { ...operation, action: 'execute' }), false)
  assert.equal(check('operation', { ...operation, operationId: '' }), false)
  assert.equal(check('operation', { ...operation, php: '<?php' }), false)
  assert.ok(
    check('error', {
      code: 'idempotency_mismatch',
      message: 'Payload identity changed.',
    }),
  )
})
