import type { BindValue } from '@synloquent/client'
import type { ExampleClient } from './nativeQualification'
import { canonicalJson, digestChunks, yieldToApplication } from './platform'

export const expectedHttpRecordCounts: Readonly<Record<string, number>> = {
  Category: 50,
  CollectionEntry: 0,
  Country: 0,
  ExternalRecord: 0,
  Image: 100001,
  Item: 17000,
  ItemType: 0,
  Location: 0,
  Note: 0,
  Salespoint: 0,
  Series: 0,
  Tag: 64,
  UlidRecord: 0,
  UuidRecord: 0,
}

export const expectedHttpRelationGroups = [
  { model: 'Item', relation: 'classifications', sets: 17000, targets: 0 },
  { model: 'Item', relation: 'salespoints', sets: 17000, targets: 0 },
  { model: 'Item', relation: 'tags', sets: 17000, targets: 300 },
  { model: 'Tag', relation: 'classifiedItems', sets: 64, targets: 0 },
  { model: 'Tag', relation: 'items', sets: 64, targets: 300 },
] as const

function expectedAttributes(model: string, identity: number) {
  const attributes = { id: identity, created_at: null, updated_at: null }
  if (model === 'Category' || model === 'Tag')
    return { ...attributes, title: model + ' ' + identity }
  if (model === 'Image')
    return {
      ...attributes,
      item_id: (identity % 17000) + 1,
      url: 'image-20261002-' + identity + '.jpg',
    }
  if (model === 'Item') {
    const title = 'Synthetic item ' + String(identity).padStart(5, '0')
    return {
      ...attributes,
      category_id: (identity % 50) + 1,
      title,
      price: `${identity % 10000}.${String(identity % 100).padStart(2, '0')}`,
      active: identity % 7 !== 0,
      quantity: identity % 20,
      metadata: null,
      labels: null,
      item_type_id: null,
      series_id: null,
      location_id: null,
      status: 'draft',
      catalog_code: null,
      published_on: null,
      released_at: null,
      latitude: null,
      display_label: title + ' / draft',
    }
  }
  throw new Error('Unexpected populated HTTP fixture model ' + model)
}

function expectedTargets(model: string, relation: string, parent: number) {
  if (model === 'Item' && relation === 'tags' && parent <= 100)
    return [0, 1, 2]
      .map((position) => ({
        id: String(((parent + position) % 64) + 1),
        attributes: { position },
      }))
      .sort((left, right) => Number(left.id) - Number(right.id))
  if (model === 'Tag' && relation === 'items') {
    const targets = []
    for (let item = 1; item <= 100; item += 1)
      for (let position = 0; position < 3; position += 1)
        if (((item + position) % 64) + 1 === parent)
          targets.push({ id: String(item), attributes: { position } })
    return targets
  }
  return []
}

function* lexicalIdentities(maximum: number, prefix = ''): Generator<string> {
  for (let digit = prefix ? 0 : 1; digit <= 9; digit += 1) {
    const identity = prefix + digit
    if (Number(identity) > maximum) continue
    yield identity
    yield* lexicalIdentities(maximum, identity)
  }
}

function recordContent(model: string, identity: string, canonical: string) {
  return canonicalJson({ model, identity, canonical, revision: '0' }) + '\n'
}

function relationContent(group: string, parent: string, canonical: string) {
  return (
    canonicalJson({
      group,
      parent,
      canonical,
      revision: '0',
      completeness: 'complete',
    }) + '\n'
  )
}

function count(value: BindValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid HTTP fixture SQL count boundary.')
  return value
}

export async function* expectedHttpCatalogContent(
  manifestModels: readonly string[],
): AsyncIterable<string> {
  let content = ''
  for (const model of manifestModels)
    for (const identity of lexicalIdentities(
      expectedHttpRecordCounts[model]!,
    )) {
      content += recordContent(
        model,
        identity,
        canonicalJson(expectedAttributes(model, Number(identity))),
      )
      if (content.length >= 4096) {
        yield content
        content = ''
      }
    }
  for (const definition of expectedHttpRelationGroups)
    for (const identity of lexicalIdentities(definition.sets)) {
      content += relationContent(
        definition.model + '.' + definition.relation,
        identity,
        canonicalJson(
          expectedTargets(
            definition.model,
            definition.relation,
            Number(identity),
          ),
        ),
      )
      if (content.length >= 4096) {
        yield content
        content = ''
      }
    }
  if (content) yield content
}

export async function verifyHttpCatalog(client: ExampleClient) {
  return client.storage.read(async (executor) => {
    const manifestModels = Object.keys(client.storage.manifest.models).sort()
    if (
      canonicalJson(manifestModels) !==
      canonicalJson(Object.keys(expectedHttpRecordCounts).sort())
    )
      throw new Error(
        'HTTP fixture manifest families differ from the independent seed.',
      )
    const models = []
    for (const model of manifestModels) {
      const result = await executor.execute(
        `SELECT COUNT(*) AS records FROM "syn_model_${model}" WHERE _partition=?`,
        [client.storage.partition],
      )
      const records = count(result.rows[0]?.records)
      if (records !== expectedHttpRecordCounts[model])
        throw new Error('HTTP fixture SQL family is incomplete: ' + model)
      models.push({ model, records })
    }
    const sets = await executor.execute(
      'SELECT COUNT(*) AS records FROM syn_relation_sets WHERE partition=?',
      [client.storage.partition],
    )
    if (count(sets.rows[0]?.records) !== 51128)
      throw new Error(
        'HTTP fixture requires exactly 51128 stored relation sets.',
      )
    const relationGroups: { group: string; sets: number; targets: number }[] =
      []
    let checkedRecords = 0
    let checkedRelationSets = 0
    let checkedTargets = 0
    async function* actualContent(): AsyncIterable<string> {
      for (const model of manifestModels) {
        if (!expectedHttpRecordCounts[model]) continue
        let previous = ''
        while (true) {
          const result = await executor.execute(
            `SELECT _server_identity,_revision,_canonical,_proposal,_visible,_deleted,_state FROM "syn_model_${model}" WHERE _partition=? AND id>? ORDER BY id COLLATE BINARY LIMIT 128`,
            [client.storage.partition, previous],
          )
          if (!result.rows.length) break
          let content = ''
          for (const row of result.rows) {
            const identity = String(row._server_identity)
            const numericIdentity = Number(identity)
            if (
              String(numericIdentity) !== identity ||
              !Number.isSafeInteger(numericIdentity) ||
              numericIdentity < 1 ||
              numericIdentity > expectedHttpRecordCounts[model]! ||
              row._revision !== '0' ||
              row._proposal !== '{}' ||
              row._visible !== 1 ||
              row._deleted !== 0 ||
              row._state !== 'synced' ||
              row._canonical !==
                canonicalJson(expectedAttributes(model, numericIdentity))
            )
              throw new Error(
                'HTTP fixture SQL content differs from seed: ' +
                  model +
                  ':' +
                  identity,
              )
            content += recordContent(model, identity, String(row._canonical))
            previous = identity
            checkedRecords += 1
          }
          yield content
          await yieldToApplication()
        }
      }
      for (const definition of expectedHttpRelationGroups) {
        const group = definition.model + '.' + definition.relation
        let previous = ''
        let groupSets = 0
        let groupTargets = 0
        while (true) {
          const result = await executor.execute(
            `SELECT parent._server_identity AS identity, relation.revision, relation.completeness, relation.canonical FROM syn_relation_sets AS relation JOIN "syn_model_${definition.model}" AS parent ON parent._partition=relation.partition AND parent._local_identity=relation.parent_identity WHERE relation.partition=? AND relation.model=? AND relation.relation=? AND parent._server_identity>? ORDER BY parent._server_identity COLLATE BINARY LIMIT 128`,
            [
              client.storage.partition,
              definition.model,
              definition.relation,
              previous,
            ],
          )
          if (!result.rows.length) break
          let content = ''
          for (const row of result.rows) {
            const identity = String(row.identity)
            const parent = Number(identity)
            const targets = expectedTargets(
              definition.model,
              definition.relation,
              parent,
            )
            if (
              String(parent) !== identity ||
              !Number.isSafeInteger(parent) ||
              parent < 1 ||
              parent > expectedHttpRecordCounts[definition.model]! ||
              row.revision !== '0' ||
              row.completeness !== 'complete' ||
              row.canonical !== canonicalJson(targets)
            )
              throw new Error(
                'HTTP fixture relation content differs from seed: ' +
                  group +
                  ':' +
                  identity,
              )
            content += relationContent(group, identity, String(row.canonical))
            previous = identity
            groupSets += 1
            groupTargets += targets.length
          }
          yield content
          await yieldToApplication()
        }
        if (
          groupSets !== definition.sets ||
          groupTargets !== definition.targets
        )
          throw new Error('HTTP fixture relation group is incomplete: ' + group)
        relationGroups.push({ group, sets: groupSets, targets: groupTargets })
        checkedRelationSets += groupSets
        checkedTargets += groupTargets
      }
    }
    const storedContentHash = await digestChunks(actualContent())
    const expectedContentHash = await digestChunks(
      expectedHttpCatalogContent(manifestModels),
    )
    if (
      storedContentHash !== expectedContentHash ||
      checkedRecords !== 117115 ||
      checkedRelationSets !== 51128 ||
      checkedTargets !== 600
    )
      throw new Error(
        'HTTP fixture stored content hash differs from the independent seed.',
      )
    const pivotFamilies = []
    for (const table of ['item_salespoint', 'item_tag', 'taggables']) {
      const live = await executor.execute(
        `SELECT COUNT(*) AS records FROM "syn_pivot_${table}" WHERE _partition=?`,
        [client.storage.partition],
      )
      const canonical = await executor.execute(
        `SELECT COUNT(*) AS records FROM "syn_canonical_pivot_${table}" WHERE _partition=?`,
        [client.storage.partition],
      )
      const expected = table === 'item_tag' ? 300 : 0
      if (
        count(live.rows[0]?.records) !== expected ||
        count(canonical.rows[0]?.records) !== expected
      )
        throw new Error(
          'HTTP fixture physical pivot family differs from seed: ' + table,
        )
      for (const prefix of ['syn_pivot_', 'syn_canonical_pivot_']) {
        if (table !== 'item_tag') continue
        const rows = (
          await executor.execute(
            `SELECT item_id,tag_id,position FROM "${prefix}${table}" WHERE _partition=? ORDER BY CAST(item_id AS INTEGER),CAST(position AS INTEGER)`,
            [client.storage.partition],
          )
        ).rows
        let index = 0
        for (let item = 1; item <= 100; item += 1)
          for (let position = 0; position < 3; position += 1) {
            const row = rows[index++]
            if (
              !row ||
              String(row.item_id) !== String(item) ||
              String(row.tag_id) !== String(((item + position) % 64) + 1) ||
              String(row.position) !== String(position)
            )
              throw new Error(
                'HTTP fixture physical pivot content differs from seed.',
              )
          }
      }
      pivotFamilies.push({ table, live: expected, canonical: expected })
    }
    const foreignKeys = await executor.execute('PRAGMA foreign_key_check')
    const integrity = await executor.execute('PRAGMA integrity_check')
    if (
      foreignKeys.rows.length ||
      integrity.rows.length !== 1 ||
      integrity.rows[0]?.integrity_check !== 'ok'
    )
      throw new Error('HTTP fixture native integrity checks failed.')
    return {
      models,
      relationSets: checkedRelationSets,
      relationTargets: checkedTargets,
      relationGroups,
      pivotFamilies,
      independentContentOracle: {
        source: 'deterministic PostgreSQL seed 20261002',
        checkedRecords,
        checkedRelationSets,
        checkedTargets,
        storedContentHash,
        expectedContentHash,
        independentContentMatches: true,
        foreignKeysValid: true,
        integrityValid: true,
      },
    }
  })
}
