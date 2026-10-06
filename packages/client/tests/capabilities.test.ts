import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  createSynloquent,
  QueryCompiler,
  SynloquentError,
  isErrorCode,
} from '@synloquent/client'
import type {
  Attributes,
  CanonicalRecord,
  Manifest,
  RelationSet,
} from '@synloquent/client'
import { configuration, snapshotFor } from './fixtures.js'
import { portableReadScenarios } from './capability-scenarios.js'

async function portableFixture() {
  const schema = JSON.parse(
    await readFile(
      new URL('../../../protocol/fixtures/manifest.json', import.meta.url),
      'utf8',
    ),
  ) as Manifest
  const client = await createSynloquent({ ...configuration(), schema })
  const record = (
    model: string,
    identifier: number,
    attributes: Attributes,
  ): CanonicalRecord => ({
    model,
    id: String(identifier),
    revision: '1',
    attributes: {
      ...Object.fromEntries(
        Object.entries(schema.models[model]!.fields)
          .filter(([, field]) => field.nullable || field.default !== undefined)
          .map(([name, field]) => [name, field.default ?? null]),
      ),
      id: identifier,
      ...attributes,
    },
  })
  const records = [
    record('Category', 1, { title: 'Mountains' }),
    record('Country', 1, { title: 'Synthetic Czechia' }),
    record('ItemType', 1, { title: 'Tourist stamp' }),
    record('Series', 1, { title: 'Synthetic 2026' }),
    record('Location', 1, { country_id: 1, title: 'Synthetic summit' }),
    record('Salespoint', 1, { location_id: 1, title: 'Synthetic shop' }),
    record('Tag', 1, { title: 'Scenic' }),
    record('Note', 1, {
      notable_id: 1,
      notable_type: 'item',
      body: 'Synthetic item note',
    }),
    record('Note', 2, {
      notable_id: 1,
      notable_type: 'category',
      body: 'Synthetic category note',
    }),
  ]
  for (const [index, title] of [
    'Alpine stamp',
    'River stamp',
    'Forest stamp',
  ].entries()) {
    records.push(
      record('Item', index + 1, {
        title,
        active: index !== 1,
        quantity: index + 1,
        price: index === 1 ? '7.25' : '12.50',
        category_id: 1,
        item_type_id: 1,
        series_id: 1,
        location_id: 1,
        metadata: { region: 'synthetic' },
        labels:
          index === 0 ? [null, true, 1, 'synthetic'] : index === 1 ? null : [],
        display_label: `${title} / draft`,
      }),
    )
    records.push(
      record('Image', index + 1, {
        item_id: index + 1,
        url: `https://example.invalid/stamp-${index}.jpg`,
      }),
    )
  }
  const relationSets: RelationSet[] = [
    {
      model: 'Item',
      relation: 'tags',
      parentId: '1',
      revision: 'r1',
      completeness: 'complete',
      targets: [{ id: '1', attributes: { position: 1 } }],
    },
    {
      model: 'Item',
      relation: 'classifications',
      parentId: '1',
      revision: 'r1',
      completeness: 'complete',
      targets: [{ id: '1', attributes: { position: 2 } }],
    },
    {
      model: 'Item',
      relation: 'salespoints',
      parentId: '1',
      revision: 'r1',
      completeness: 'complete',
      targets: [{ id: '1', attributes: { id: 1, position: 1 } }],
    },
  ]
  await client.sync.installSnapshot(snapshotFor(records, schema, relationSets))
  return client
}
for (const scenario of portableReadScenarios)
  test(`local ${scenario.name}`, async () => {
    const client = await portableFixture()
    try {
      await scenario.run(client, 'local')
    } finally {
      await client.close()
    }
  })

test('C29 indexed foreign-key relation lookup preserves explicit field selection and numeric primary-key order', async () => {
  const client = await portableFixture()
  try {
    const compiled = new QueryCompiler(
      client.storage.manifest,
      client.storage.partition,
    ).compileRelation('Item', 'images', ['c:1'], { model: 'Image' })
    const plan = await client.storage.read((executor) =>
      executor.execute(
        `EXPLAIN QUERY PLAN ${compiled.statement}`,
        compiled.parameters,
      ),
    )
    assert.ok(
      plan.rows.some(
        (row) =>
          String(row.detail).includes('syn_unique_Image_0') &&
          String(row.detail).includes('_order_item_id=?'),
      ),
    )
    assert.equal(
      (await client.query('Item').with('images').findOrFail(1))
        .relation('images')
        .current?.first()?.attributes.url,
      'https://example.invalid/stamp-0.jpg',
    )
  } finally {
    await client.close()
  }
})

test('network error-code parser accepts declared wire errors and retains a fail-closed unknown boundary', () => {
  assert.equal(isErrorCode('invalid_snapshot'), true)
  assert.equal(isErrorCode('authentication_required'), true)
  assert.equal(isErrorCode('unregistered_executable_error'), false)
  assert.equal(isErrorCode({ code: 'conflict' }), false)
  const wireCode: unknown = 'unregistered_executable_error'
  const failure = new SynloquentError(
    isErrorCode(wireCode) ? wireCode : 'validation_failed',
    'Remote response rejected',
    { wireCode },
  )
  assert.equal(failure.code, 'validation_failed')
  assert.equal(failure.details.wireCode, wireCode)
})
