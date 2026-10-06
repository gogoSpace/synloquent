import { readFile } from 'node:fs/promises'
import { createSynloquent, QueryCompiler } from '../src/index.js'
import type { CanonicalRecord, Manifest } from '../src/index.js'
import { configuration } from './fixtures.js'
const schema = JSON.parse(
  await readFile('protocol/fixtures/manifest.json', 'utf8'),
) as Manifest
const client = await createSynloquent({ ...configuration(), schema })
try {
  const records: CanonicalRecord[] = []
  for (let category = 1; category <= 50; category++)
    records.push({
      model: 'Category',
      id: String(category),
      revision: '1',
      attributes: {
        id: category,
        title: `Category ${category}`,
        created_at: null,
        updated_at: null,
      },
    })
  for (let tag = 1; tag <= 64; tag++)
    records.push({
      model: 'Tag',
      id: String(tag),
      revision: '1',
      attributes: {
        id: tag,
        title: `Tag ${tag}`,
        created_at: null,
        updated_at: null,
      },
    })
  for (let item = 1; item <= 17000; item++)
    records.push({
      model: 'Item',
      id: String(item),
      revision: '1',
      attributes: {
        id: item,
        title: `Synthetic item ${String(item).padStart(5, '0')}`,
        category_id: (item % 50) + 1,
        active: item % 7 !== 0,
        price: `${item % 10000}.${String(item % 100).padStart(2, '0')}`,
        quantity: item % 20,
        metadata: null,
        created_at: null,
        updated_at: null,
      },
    })
  for (let image = 1; image <= 100001; image++)
    records.push({
      model: 'Image',
      id: String(image),
      revision: '1',
      attributes: {
        id: image,
        item_id: (image % 17000) + 1,
        url: `image-20261002-${image}.jpg`,
        created_at: null,
        updated_at: null,
      },
    })
  const start = performance.now()
  await client.storage.write((executor, changed) =>
    client.storage.ingestSnapshotRecords(records, executor, changed),
  )
  const sizes = await client.storage.read(async (executor) => ({
    pageCount: (await executor.execute('PRAGMA page_count')).rows,
    pageSize: (await executor.execute('PRAGMA page_size')).rows,
    objects: (
      await executor.execute(
        'SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC',
      )
    ).rows,
  }))
  const compiled = new QueryCompiler(
    schema,
    client.storage.partition,
  ).compileRelation('Item', 'images', ['c:8500'], { model: 'Image' })
  const plan = await client.storage.read((executor) =>
    executor.execute(
      `EXPLAIN QUERY PLAN ${compiled.statement}`,
      compiled.parameters,
    ),
  )
  const readStart = performance.now()
  const result = await client
    .query('Item')
    .with('images', 'category', 'tags')
    .findOrFail(8500)
  console.log(
    JSON.stringify(
      {
        milliseconds: performance.now() - start,
        readMilliseconds: performance.now() - readStart,
        imageCount: result.relation('images').current?.length,
        statement: compiled.statement,
        parameters: compiled.parameters,
        plan: plan.rows,
        ...sizes,
      },
      null,
      2,
    ),
  )
} finally {
  await client.close()
}
