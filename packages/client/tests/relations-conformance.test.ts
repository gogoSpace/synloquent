import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createSynloquent, SynloquentError } from '../src/index.js'
import type {
  Attributes,
  CanonicalRecord,
  Manifest,
  RelationSet,
} from '../src/index.js'
import { configuration, manifest, snapshotFor } from './fixtures.js'
import { testTransport } from './transport-fixture.js'

async function fixtureClient() {
  const manifest = JSON.parse(
    await readFile(
      new URL('../../../protocol/fixtures/manifest.json', import.meta.url),
      'utf8',
    ),
  ) as Manifest
  const client = await createSynloquent({
    ...configuration(),
    schema: manifest,
  })
  await client.storage.write(async (executor, changed) => {
    const record = (
      model: string,
      id: string,
      attributes: Attributes,
    ): CanonicalRecord => ({
      model,
      id,
      revision: '1',
      attributes: { id, created_at: null, updated_at: null, ...attributes },
    })
    for (const entry of [
      record('Category', '1', { title: 'Category' }),
      record('Item', '1', {
        title: 'Item',
        category_id: '1',
        price: '12.50',
        active: true,
        quantity: 1,
        metadata: null,
      }),
      record('Tag', '1', { title: 'Tag one' }),
      record('Tag', '2', { title: 'Tag two' }),
      record('Image', '1', { item_id: '1', url: 'old.jpg' }),
      record('Image', '2', { item_id: '1', url: 'new.jpg' }),
      record('Note', '1', {
        notable_id: '1',
        notable_type: 'item',
        body: 'Item note',
      }),
      record('Note', '2', {
        notable_id: '1',
        notable_type: 'category',
        body: 'Category note',
      }),
    ])
      await client.storage.ingest(entry, executor, changed)
    const set = (
      model: string,
      relation: string,
      parentId: string,
      targets: RelationSet['targets'],
    ): RelationSet => ({
      model,
      relation,
      parentId,
      revision: '3',
      completeness: 'complete',
      targets,
    })
    for (const membership of [
      set('Item', 'tags', '1', [{ id: '1', attributes: { position: 1 } }]),
      set('Tag', 'items', '1', [{ id: '1', attributes: { position: 1 } }]),
      set('Tag', 'items', '2', []),
      set('Item', 'classifications', '1', [
        { id: '1', attributes: { position: 1 } },
      ]),
      set('Tag', 'classifiedItems', '1', [
        { id: '1', attributes: { position: 1 } },
      ]),
    ])
      await client.storage.ingestRelationSet(membership, executor, changed)
    await client.storage.rebuildRelationOverlays(executor, changed)
    await client.storage.setMetadata(
      'scope',
      JSON.stringify({ completeness: 'complete' }),
      executor,
    )
  })
  return client
}

test('C28-C36 actual generated metadata hydrates belongsTo/hasMany/through/morph/all pivot directions and deterministic ofMany', async () => {
  const client = await fixtureClient()
  try {
    const item = await client.models
      .Item!.with(
        'category',
        'images',
        'latestImage',
        'notes',
        'firstNote',
        'tags',
        'classifications',
      )
      .findOrFail('1')
    assert.equal(
      item.relation('category').current?.first()?.attributes.title,
      'Category',
    )
    assert.deepEqual(
      item
        .relation('images')
        .current?.map((model) => model.id)
        .all(),
      ['1', '2'],
    )
    assert.equal(item.relation('latestImage').current?.first()?.id, '2')
    assert.equal(
      item.relation('notes').current?.first()?.attributes.body,
      'Item note',
    )
    assert.equal(item.relation('firstNote').current?.length, 1)
    assert.equal(item.relation('tags').current?.length, 1)
    assert.equal(item.relation('classifications').current?.length, 1)
    const category = await client.models
      .Category!.with('imagesThrough', 'firstImageThrough', 'notes')
      .findOrFail('1')
    assert.equal(category.relation('imagesThrough').current?.length, 2)
    assert.equal(
      category.relation('firstImageThrough').current?.first()?.id,
      '1',
    )
    assert.equal(
      category.relation('notes').current?.first()?.attributes.body,
      'Category note',
    )
    const tag = await client.models
      .Tag!.with('items', 'classifiedItems')
      .findOrFail('1')
    assert.equal(tag.relation('items').current?.length, 1)
    assert.equal(tag.relation('classifiedItems').current?.length, 1)
    const notes = await client.models.Note!.with('notable').get()
    assert.equal(
      notes.items[0]?.relation('notable').current?.first()?.modelName,
      'Item',
    )
    assert.equal(
      notes.items[1]?.relation('notable').current?.first()?.modelName,
      'Category',
    )
    await item.loadMissing('images')
    await item.load('tags')
    assert.equal(item.relation('tags').current?.length, 1)
    assert.deepEqual(await item.loadCount('images'), { images: 2 })
  } finally {
    await client.close()
  }
})

test('C40-C42 bidirectional canonical membership replay keeps pending attach/detach/toggle and revision-bound sync', async () => {
  const client = await fixtureClient()
  try {
    const parent = await client.models.Item!.findOrFail('1')
    const tag = await client.models.Tag!.findOrFail('2')
    await parent.relation('tags').attach([tag], { position: 2 })
    assert.equal((await parent.relation('tags').get()).length, 2)
    await client.storage.write(async (executor, changed) => {
      await client.storage.ingestRelationSet(
        {
          model: 'Item',
          relation: 'tags',
          parentId: '1',
          revision: '3',
          completeness: 'complete',
          targets: [{ id: '1', attributes: { position: 1 } }],
        },
        executor,
        changed,
      )
      await client.storage.ingestRelationSet(
        {
          model: 'Tag',
          relation: 'items',
          parentId: '2',
          revision: '3',
          completeness: 'complete',
          targets: [],
        },
        executor,
        changed,
      )
      await client.storage.rebuildRelationOverlays(executor, changed)
    })
    assert.equal((await parent.relation('tags').get()).length, 2)
    await parent.relation('tags').detach(['1'])
    await parent.relation('tags').toggle(['2'])
    assert.equal((await parent.relation('tags').get()).length, 0)
    await client.storage.write(async (executor, changed) => {
      await client.storage.ingestRelationSet(
        {
          model: 'Tag',
          relation: 'items',
          parentId: '1',
          revision: '3',
          completeness: 'complete',
          targets: [{ id: '1', attributes: { position: 1 } }],
        },
        executor,
        changed,
      )
      await client.storage.rebuildRelationOverlays(executor, changed)
    })
    assert.equal((await parent.relation('tags').get()).length, 0)
    await assert.rejects(
      parent
        .relation('tags')
        .sync(['1'], { completeSet: true, expectedRelationRevision: 'wrong' }),
      (error) => error instanceof SynloquentError && error.code === 'conflict',
    )
    await parent
      .relation('tags')
      .sync(['1'], { completeSet: true, expectedRelationRevision: '3' })
    assert.equal(
      (
        await parent
          .relation('tags')
          .orderByPivot('position')
          .withPivot('position')
          .get()
      ).length,
      1,
    )
  } finally {
    await client.close()
  }
})

test('C58 declared cascade/restrict and real deferred SQLite constraints preserve atomic deletion and alias remapping', async () => {
  const client = await fixtureClient()
  try {
    const foreignKeys = await client.storage.read((executor) =>
      executor.execute('PRAGMA foreign_keys'),
    )
    assert.equal(foreignKeys.rows[0]?.foreign_keys, 1)
    const category = await client.models.Category!.findOrFail('1')
    await assert.rejects(
      category.delete(),
      (error) =>
        error instanceof SynloquentError &&
        error.code === 'forbidden_operation',
    )
    const item = await client.models.Item!.findOrFail('1')
    await item.delete()
    assert.equal(await client.models.Image!.find('1'), null)
    assert.equal(
      (await client.models.Tag!.with('items').findOrFail('1')).relation('items')
        .current?.length,
      0,
    )
    assert.equal(
      (
        await client.storage.read((executor) =>
          executor.execute('PRAGMA foreign_key_check'),
        )
      ).rows.length,
      0,
    )
  } finally {
    await client.close()
  }
})

test('C29 C34 custom primary/foreign/local keys and ordered one-of-many ties select the same declared winner', async () => {
  const field = { nullable: false, readable: true, writable: true }
  const ownerKey = { ...field, type: 'string' as const }
  const childKey = { ...field, type: 'integer' as const, writable: false }
  const relation = {
    model: 'FixtureChild',
    foreignKey: 'owner_code',
    localKey: 'catalog_key',
  }
  const schema: Manifest = {
    ...manifest,
    fingerprint: 'custom-relations-v1',
    models: {
      FixtureOwner: {
        resource: 'FixtureOwner',
        table: 'fixture_owners',
        primaryKey: 'catalog_key',
        keyType: 'string',
        incrementing: false,
        fields: { catalog_key: ownerKey, title: { ...field, type: 'string' } },
        operations: ['create', 'update', 'delete'],
        unique: [['catalog_key']],
        relations: {
          children: { ...relation, type: 'hasMany' },
          ranked: {
            ...relation,
            type: 'ofMany',
            oneOfMany: [
              { field: 'rank', aggregate: 'max' },
              { field: 'id', aggregate: 'min' },
            ],
          },
          latest: {
            ...relation,
            type: 'latestOfMany',
            oneOfMany: [
              { field: 'rank', aggregate: 'max' },
              { field: 'id', aggregate: 'max' },
            ],
          },
          oldest: {
            ...relation,
            type: 'oldestOfMany',
            oneOfMany: [
              { field: 'rank', aggregate: 'min' },
              { field: 'id', aggregate: 'max' },
            ],
          },
        },
      },
      FixtureChild: {
        resource: 'FixtureChild',
        table: 'fixture_children',
        primaryKey: 'id',
        keyType: 'integer',
        incrementing: true,
        fields: {
          id: childKey,
          owner_code: { ...ownerKey, nullable: true },
          rank: { ...field, type: 'integer' },
          title: { ...field, type: 'string' },
        },
        operations: ['create', 'update', 'delete'],
        unique: [['id']],
        indexes: [['owner_code', 'rank']],
        relations: {
          owner: {
            type: 'belongsTo',
            model: 'FixtureOwner',
            foreignKey: 'owner_code',
            ownerKey: 'catalog_key',
            onDelete: 'cascade',
          },
        },
      },
    },
  }
  const client = await createSynloquent({ ...configuration(), schema })
  try {
    await client.storage.write(async (executor, changed) => {
      await client.storage.ingest(
        {
          model: 'FixtureOwner',
          id: 'owner-é',
          revision: '1',
          attributes: { catalog_key: 'owner-é', title: 'Owner' },
        },
        executor,
        changed,
      )
      for (const [identifier, rank] of [
        [1, 1],
        [2, 9],
        [3, 9],
        [4, 1],
      ])
        await client.storage.ingest(
          {
            model: 'FixtureChild',
            id: String(identifier),
            revision: '1',
            attributes: {
              id: identifier!,
              owner_code: 'owner-é',
              rank: rank!,
              title: `Child ${identifier}`,
            },
          },
          executor,
          changed,
        )
    })
    const owner = await client.models
      .FixtureOwner!.with('children', 'ranked', 'latest', 'oldest')
      .findOrFail('owner-é')
    assert.deepEqual(
      owner
        .relation('children')
        .current?.items.map((child) => Number(child.id)),
      [1, 2, 3, 4],
    )
    assert.equal(Number(owner.relation('ranked').current?.first()?.id), 2)
    assert.equal(Number(owner.relation('latest').current?.first()?.id), 3)
    assert.equal(Number(owner.relation('oldest').current?.first()?.id), 4)
    assert.equal(
      (
        await client.models
          .FixtureOwner!.whereHas('ranked', (query) => query.where('id', 3))
          .get()
      ).length,
      0,
    )
    assert.equal(
      (
        await client.models
          .FixtureOwner!.whereHas('ranked', (query) => query.where('id', 2))
          .get()
      ).length,
      1,
    )
    assert.equal(
      (
        await client.models
          .FixtureOwner!.withConstrained('latest', (query) =>
            query.where('id', 2),
          )
          .findOrFail('owner-é')
      ).relation('latest').current?.length,
      0,
    )
    const child = await owner
      .relation('children')
      .create({ rank: 5, title: 'Offline custom foreign key' })
    assert.equal(child.attributes.owner_code, 'owner-é')
    await child.relation('owner').dissociate()
    assert.equal(child.attributes.owner_code, null)
    await child.relation('owner').associate(owner)
    await child.save()
    assert.equal(child.attributes.owner_code, 'owner-é')
    assert.equal((await child.relation('owner').get()).first()?.id, 'owner-é')
    assert.equal(
      (
        await client.storage.read((executor) =>
          executor.execute('PRAGMA foreign_key_check'),
        )
      ).rows.length,
      0,
    )
  } finally {
    await client.close()
  }
})

function nonprimaryManifest(
  deletion: 'cascade' | 'nullify' | 'restrict',
): Manifest {
  const writable = { nullable: false, readable: true, writable: true }
  const identifier = { ...writable, writable: false, type: 'integer' as const }
  return {
    ...manifest,
    fingerprint: `nonprimary-owner-${deletion}`,
    models: {
      Owner: {
        resource: 'owners',
        table: 'owners',
        primaryKey: 'id',
        keyType: 'integer',
        incrementing: true,
        fields: {
          id: identifier,
          code: { ...writable, type: 'string' },
          title: { ...writable, type: 'string' },
        },
        unique: [['code']],
        operations: ['create', 'update', 'delete'],
        relations: {
          children: {
            type: 'hasMany',
            model: 'Child',
            foreignKey: 'owner_code',
            localKey: 'code',
          },
        },
      },
      Child: {
        resource: 'children',
        table: 'children',
        primaryKey: 'id',
        keyType: 'integer',
        incrementing: true,
        fields: {
          id: identifier,
          owner_code: { ...writable, type: 'string', nullable: true },
          title: { ...writable, type: 'string' },
        },
        operations: ['create', 'update', 'delete'],
        relations: {
          owner: {
            type: 'belongsTo',
            model: 'Owner',
            foreignKey: 'owner_code',
            ownerKey: 'code',
            onDelete: deletion,
            onUpdate: 'restrict',
          },
        },
      },
    },
  }
}

test('C29 C58 nonprimary unique owner keys enforce SQLite references preserve natural values across aliases and retire deleted keys', async () => {
  for (const deletion of ['cascade', 'nullify', 'restrict'] as const) {
    const schema = nonprimaryManifest(deletion)
    const server = testTransport()
    const client = await createSynloquent({
      ...configuration(':memory:', server.transport),
      schema,
    })
    try {
      const owner = await client.models.Owner!.create({
        code: 'identity-1',
        title: 'Natural owner',
      })
      assert.equal(owner.localIdentity, 'identity-1')
      const child = await owner
        .relation('children')
        .create({ title: 'Natural child' })
      let entries = await client.storage.read((executor) =>
        client.storage.pending(executor),
      )
      const childIntent = entries.find(
        (entry) => entry.operation.model === 'Child',
      )!
      assert.equal(childIntent.operation.values.owner_code, 'identity-1')
      assert.deepEqual(childIntent.operation.dependsOn, [owner.lastOperationId])
      await client.sync.flush()
      await owner.refresh()
      await child.refresh()
      assert.notEqual(String(owner.id), owner.attributes.code)
      assert.equal(child.attributes.owner_code, 'identity-1')
      assert.equal(
        (await child.relation('owner').get()).first()?.localIdentity,
        owner.localIdentity,
      )
      assert.equal(
        (await owner.relation('children').get()).first()?.localIdentity,
        child.localIdentity,
      )
      const before = entries.length
      await assert.rejects(
        client.models.Child!.create({
          owner_code: 'missing-owner',
          title: 'Orphan',
        }),
        /FOREIGN KEY/,
      )
      entries = await client.storage.read((executor) =>
        client.storage.pending(executor),
      )
      assert.equal(entries.length, before)
      assert.equal(
        (await client.models.Child!.where('title', 'Orphan').get()).length,
        0,
      )
      await assert.rejects(
        owner.update({ code: 'changed-owner' }),
        /FOREIGN KEY/,
      )
      assert.equal(
        (await client.models.Owner!.findOrFail(owner.localIdentity)).attributes
          .code,
        'identity-1',
      )
      if (deletion === 'restrict') {
        await assert.rejects(
          owner.delete(),
          (error) =>
            error instanceof SynloquentError &&
            error.code === 'forbidden_operation',
        )
        assert.equal((await child.relation('owner').get()).length, 1)
      } else {
        const currentOwner = await client.models.Owner!.findOrFail(
          owner.localIdentity,
        )
        await currentOwner.delete()
        const storedChild = await client.storage.read((executor) =>
          client.storage.findStored('Child', child.localIdentity, executor),
        )
        assert.equal(storedChild?.canonical.owner_code, 'identity-1')
        assert.equal(storedChild?.visible, true)
        assert.equal(storedChild?.deleted, deletion === 'cascade')
        if (deletion === 'nullify')
          assert.equal(storedChild?.proposal.owner_code, null)
        const replacement = await client.models.Owner!.create({
          code: 'identity-1',
          title: 'Reused after physical deletion',
        })
        assert.notEqual(replacement.localIdentity, owner.localIdentity)
        assert.equal(
          (await client.models.Owner!.where('code', 'identity-1').get()).length,
          1,
        )
      }
      assert.equal(
        (
          await client.storage.read((executor) =>
            executor.execute('PRAGMA foreign_key_check'),
          )
        ).rows.length,
        0,
      )
    } finally {
      await client.close()
    }
  }
})

test('C29 C52 C55 hidden canonical custom owners release reused keys while retaining proposals and enforcing visible references', async () => {
  const schema = nonprimaryManifest('cascade')
  const canonical = (
    model: string,
    id: string,
    attributes: Attributes,
  ): CanonicalRecord => ({
    model,
    id,
    revision: '1',
    attributes: { id, ...attributes },
  })
  for (const reason of ['delete', 'remove'] as const) {
    const client = await createSynloquent({ ...configuration(), schema })
    try {
      await client.sync.installSnapshot(
        snapshotFor(
          [
            canonical('Owner', '1', {
              code: 'reused-key',
              title: 'Historical owner',
            }),
            canonical('Child', '10', {
              owner_code: 'reused-key',
              title: 'Historical child',
            }),
          ],
          schema,
        ),
      )
      const owner = await client.models.Owner!.findOrFail('1')
      await owner.update({ title: 'Retained private proposal' })
      const operationId = owner.lastOperationId!
      await client.storage.write(async (executor, changed) => {
        if (reason === 'remove')
          await client.storage.remove(
            'Child',
            '10',
            'remove',
            executor,
            changed,
          )
        await client.storage.remove('Owner', '1', reason, executor, changed)
        await client.storage.ingest(
          canonical('Owner', '2', {
            code: 'reused-key',
            title: 'Replacement owner',
          }),
          executor,
          changed,
        )
      })
      const replacement = [
        canonical('Owner', '2', {
          code: 'reused-key',
          title: 'Replacement owner',
        }),
        canonical('Child', '20', {
          owner_code: 'reused-key',
          title: 'Replacement child',
        }),
      ]
      await client.sync.installSnapshot(snapshotFor(replacement, schema))
      assert.deepEqual(
        (await client.models.Owner!.get())
          .map((model) => String(model.id))
          .all(),
        ['2'],
      )
      assert.deepEqual(
        (await client.models.Child!.get())
          .map((model) => String(model.id))
          .all(),
        ['20'],
      )
      const current = await client.models.Child!.findOrFail('20')
      assert.equal(
        (await current.relation('owner').get()).first()?.attributes.title,
        'Replacement owner',
      )
      const historical = await client.storage.read((executor) =>
        client.storage.findStored('Owner', '1', executor),
      )
      assert.equal(historical?.visible, false)
      assert.equal(historical?.canonical.title, 'Historical owner')
      if (reason === 'delete')
        assert.equal(historical?.proposal.title, 'Retained private proposal')
      else
        assert.equal(
          (await client.sync.recovery()).find(
            (entry) => entry.model === 'Owner',
          )?.proposal.title,
          'Retained private proposal',
        )
      const retained = (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).find((entry) => entry.operation.operationId === operationId)
      assert.equal(
        retained?.operation.values.title,
        'Retained private proposal',
      )
      const generation = client.storage.owner.generation
      await assert.rejects(
        client.sync.installSnapshot(
          snapshotFor(
            [
              ...replacement,
              canonical('Owner', '3', {
                code: 'reused-key',
                title: 'Invalid visible duplicate',
              }),
            ],
            schema,
          ),
        ),
        /UNIQUE/,
      )
      assert.equal(client.storage.owner.generation, generation)
      assert.equal(
        (await client.models.Owner!.findOrFail('2')).attributes.title,
        'Replacement owner',
      )
      await assert.rejects(
        client.models.Child!.create({
          owner_code: 'missing',
          title: 'Invalid visible orphan',
        }),
        /FOREIGN KEY/,
      )
      assert.equal(
        (
          await client.storage.read((executor) =>
            executor.execute('PRAGMA foreign_key_check'),
          )
        ).rows.length,
        0,
      )
    } finally {
      await client.close()
    }
  }
})

test('C29 C51 C58 natural owner key update cascades canonical and local overlays without losing independent child intent', async () => {
  const base = nonprimaryManifest('cascade')
  const schema: Manifest = {
    ...base,
    models: {
      ...base.models,
      Child: {
        ...base.models.Child!,
        relations: {
          owner: {
            ...base.models.Child!.relations.owner!,
            onUpdate: 'cascade',
          },
        },
      },
    },
  }
  const server = testTransport()
  const push = server.transport.push
  server.transport.push = async (request) => {
    const receipts: import('../src/index.js').PushReceipt[] = []
    for (const operation of request.payload.operations) {
      const response = await push({
        ...request,
        payload: { operations: [operation] },
      })
      receipts.push(...response.receipts)
      if (
        operation.model === 'Owner' &&
        operation.values.code !== undefined &&
        response.receipts[0]?.status === 'accepted'
      )
        for (const [key, child] of server.records)
          if (child.model === 'Child')
            server.records.set(key, {
              ...child,
              revision: String(Number(child.revision) + 1),
              attributes: {
                ...child.attributes,
                owner_code: operation.values.code as string,
              },
            })
    }
    return { receipts }
  }
  const records: CanonicalRecord[] = [
    {
      model: 'Owner',
      id: '1',
      revision: '1',
      attributes: { id: '1', code: 'old-code', title: 'Owner' },
    },
    {
      model: 'Child',
      id: '10',
      revision: '1',
      attributes: { id: '10', owner_code: 'old-code', title: 'Child' },
    },
  ]
  for (const record of records)
    server.records.set(`${record.model}:${record.id}`, record)
  const client = await createSynloquent({
    ...configuration(':memory:', server.transport),
    schema,
  })
  const subscription = client.observe(client.models.Child!.where('id', '10'))
  const unsubscribe = subscription.subscribe(() => {})
  try {
    await client.sync.installSnapshot(snapshotFor(records, schema))
    const owner = await client.models.Owner!.findOrFail('1')
    await owner.update({ code: 'temporary-code' })
    assert.equal(
      (await client.models.Child!.findOrFail('10')).attributes.owner_code,
      'temporary-code',
    )
    await client.sync.cancel(owner.lastOperationId!)
    assert.equal(
      (await client.models.Child!.findOrFail('10')).attributes.owner_code,
      'old-code',
    )
    assert.equal(
      (await client.models.Child!.findOrFail('10')).syncState,
      'synced',
    )
    await owner.refresh()
    await owner.update({ code: 'new-code' })
    await subscription.refresh()
    assert.equal(
      subscription.getSnapshot().data.first()?.attributes.owner_code,
      'new-code',
    )
    const child = await client.models.Child!.findOrFail('10')
    await child.update({ title: 'Independent child proposal' })
    const childOperation = child.lastOperationId!
    const before = await client.storage.read((executor) =>
      client.storage.findStored('Child', '10', executor),
    )
    assert.equal(before?.canonical.owner_code, 'old-code')
    assert.equal(before?.proposal.owner_code, 'new-code')
    assert.equal(before?.proposal.title, 'Independent child proposal')
    await client.sync.flush()
    const after = await client.storage.read((executor) =>
      client.storage.findStored('Child', '10', executor),
    )
    assert.equal(after?.canonical.owner_code, 'new-code')
    assert.equal(after?.proposal.owner_code, undefined)
    assert.equal(after?.proposal.title, 'Independent child proposal')
    assert.equal(after?.state, 'conflicted')
    assert.equal(await client.sync.status(childOperation), 'conflicted')
    assert.equal(
      (await client.models.Child!.findOrFail('10')).relation('owner').definition
        .ownerKey,
      'code',
    )
    await client.sync.resolveConflict(childOperation, 'retry')
    await client.sync.flush()
    const confirmed = await client.models.Child!.findOrFail('10')
    assert.equal(confirmed.attributes.owner_code, 'new-code')
    assert.equal(confirmed.attributes.title, 'Independent child proposal')
    assert.equal(confirmed.syncState, 'synced')
    assert.equal(
      (await confirmed.relation('owner').get()).first()?.attributes.code,
      'new-code',
    )
    assert.equal(
      (
        await client.storage.read((executor) =>
          executor.execute('PRAGMA foreign_key_check'),
        )
      ).rows.length,
      0,
    )
  } finally {
    unsubscribe()
    subscription.dispose()
    await client.close()
  }
})
