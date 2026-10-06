import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSynloquent, SynloquentError } from '../src/index.js'
import type { CanonicalRecord, Manifest, PushReceipt } from '../src/index.js'
import type {
  BindValue,
  DatabaseAdapter,
  TransactionExecutor,
} from '../src/core/database.js'
import { configuration, item, manifest, snapshotFor } from './fixtures.js'
import { testTransport } from './transport-fixture.js'

function cancellationSchema(deletion: 'cascade' | 'nullify'): Manifest {
  const integer = manifest.models.Tag!.fields.id!
  const string = {
    type: 'string' as const,
    nullable: false,
    readable: true,
    writable: true,
  }
  return {
    ...manifest,
    fingerprint: `delete-cancellation-${deletion}`,
    models: {
      ...manifest.models,
      Parent: {
        resource: 'parents',
        table: 'parents',
        primaryKey: 'id',
        keyType: 'integer',
        incrementing: true,
        fields: { id: integer, name: string },
        operations: ['create', 'update', 'delete', 'pivot'],
        relations: {
          children: {
            type: 'hasMany',
            model: 'Child',
            foreignKey: 'parent_id',
          },
          otherChildren: {
            type: 'hasMany',
            model: 'Child',
            foreignKey: 'other_parent_id',
          },
          grandchildren: {
            type: 'hasManyThrough',
            model: 'Grandchild',
            through: 'Child',
            foreignKey: 'parent_id',
            secondKey: 'child_id',
          },
          tags: {
            type: 'belongsToMany',
            model: 'Tag',
            pivot: {
              table: 'parent_tag',
              foreignKey: 'parent_id',
              relatedKey: 'tag_id',
              fields: {},
            },
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
          id: integer,
          parent_id: { ...integer, writable: true, nullable: true },
          other_parent_id: { ...integer, writable: true, nullable: true },
          note: string,
        },
        operations: ['create', 'update', 'delete'],
        indexes: [['parent_id'], ['other_parent_id']],
        relations: {
          parent: {
            type: 'belongsTo',
            model: 'Parent',
            foreignKey: 'parent_id',
            onDelete: deletion,
          },
          otherParent: {
            type: 'belongsTo',
            model: 'Parent',
            foreignKey: 'other_parent_id',
            onDelete: deletion,
          },
          grandchildren: {
            type: 'hasMany',
            model: 'Grandchild',
            foreignKey: 'child_id',
          },
        },
      },
      Grandchild: {
        resource: 'grandchildren',
        table: 'grandchildren',
        primaryKey: 'id',
        keyType: 'integer',
        incrementing: true,
        fields: {
          id: integer,
          child_id: { ...integer, writable: true },
          title: string,
        },
        operations: ['create', 'update', 'delete'],
        indexes: [['child_id']],
        relations: {
          child: {
            type: 'belongsTo',
            model: 'Child',
            foreignKey: 'child_id',
            onDelete: 'cascade',
          },
        },
      },
    },
  }
}

const records: CanonicalRecord[] = [
  {
    model: 'Parent',
    id: '1',
    revision: '1',
    attributes: { id: '1', name: 'Parent one' },
  },
  {
    model: 'Parent',
    id: '2',
    revision: '1',
    attributes: { id: '2', name: 'Parent two' },
  },
  {
    model: 'Child',
    id: '10',
    revision: '1',
    attributes: {
      id: '10',
      parent_id: '1',
      other_parent_id: '2',
      note: 'Canonical child',
    },
  },
  {
    model: 'Grandchild',
    id: '100',
    revision: '1',
    attributes: { id: '100', child_id: '10', title: 'Canonical grandchild' },
  },
  {
    model: 'Tag',
    id: '1',
    revision: '1',
    attributes: { id: '1', label: 'Canonical tag' },
  },
  item('9', { name: 'Soft delete control' }),
]

function snapshot(schema: Manifest, retained = true) {
  return snapshotFor(
    retained
      ? records
      : records.filter(
          (record) => !['Child', 'Grandchild'].includes(record.model),
        ),
    schema,
    [
      {
        model: 'Parent',
        relation: 'tags',
        parentId: '1',
        revision: '1',
        completeness: 'complete',
        targets: [{ id: '1', attributes: {} }],
      },
    ],
  )
}

const hasCode = (code: string) => (error: unknown) =>
  error instanceof SynloquentError && error.code === code

test('C51 C52 C55 C57 C58 delete cancellation restores only confirmed membership across cascade nullify snapshot pull and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synloquent-delete-cancel-'))
  try {
    for (const deletion of ['cascade', 'nullify'] as const)
      for (const boundary of [
        'unchanged',
        'snapshot-retained',
        'snapshot-revoked',
        'snapshot-parent-revoked',
        'pull-revoked',
        'restart',
      ] as const) {
        const schema = cancellationSchema(deletion)
        const server = testTransport()
        const filename = join(directory, `${deletion}-${boundary}.sqlite`)
        let client = await createSynloquent({
          ...configuration(filename, server.transport),
          schema,
        })
        try {
          await client.sync.installSnapshot(snapshot(schema))
          const parent = await client.models.Parent!.findOrFail('1')
          const child = await client.models.Child!.findOrFail('10')
          await child.update({ note: 'Independent retained child edit' })
          const childOperation = child.lastOperationId!
          await parent.delete()
          const deletionOperation = parent.lastOperationId!
          assert.equal(
            await client.models.Parent!.withTrashed().find('1'),
            null,
          )
          assert.equal(await client.models.Parent!.count(), 1)
          assert.equal(
            (
              await client.models
                .Child!.whereHas('parent', (query) => query)
                .get()
            ).length,
            0,
          )
          assert.equal(
            (
              await client.models
                .Child!.join('Parent', 'owner', 'parent_id', 'id')
                .get()
            ).length,
            0,
          )
          assert.equal((await parent.relation('grandchildren').get()).length, 0)
          const pending = await client.storage.read((executor) =>
            client.storage.findStored('Child', '10', executor),
          )
          assert.equal(pending?.visible, true)
          assert.equal(pending?.deleted, deletion === 'cascade')
          assert.equal(pending?.canonical.parent_id, '1')
          assert.equal(
            pending?.proposal.note,
            'Independent retained child edit',
          )
          if (deletion === 'nullify')
            assert.equal(pending?.proposal.parent_id, null)
          if (boundary.startsWith('snapshot')) {
            const replacement = snapshot(
              schema,
              boundary === 'snapshot-retained',
            )
            const parentRevoked = boundary === 'snapshot-parent-revoked'
            const document = parentRevoked
              ? snapshotFor(
                  replacement.records.filter(
                    (record) => record.model !== 'Parent' || record.id !== '1',
                  ),
                  schema,
                )
              : replacement
            await client.sync.installSnapshot({
              ...document,
              generation: 'snapshot-2',
            })
          } else if (boundary === 'pull-revoked') {
            server.transport.pull = async () => ({
              batches: [
                {
                  cursor: 'cursor-2',
                  relationSets: [],
                  changes: [
                    { kind: 'remove', model: 'Child', id: '10' },
                    { kind: 'remove', model: 'Grandchild', id: '100' },
                  ],
                },
              ],
              cursor: 'cursor-2',
              highWater: 'cursor-2',
              scanComplete: true,
              scope: snapshot(schema).scope,
            })
            await client.sync.pull('default')
          } else if (boundary === 'restart') {
            await client.close()
            client = await createSynloquent({
              ...configuration(filename, server.transport),
              schema,
            })
            assert.equal(await client.models.Parent!.find('1'), null)
          }
          await client.sync.cancel(deletionOperation)
          assert.equal(await client.sync.status(deletionOperation), 'cancelled')
          const parentAuthorized = boundary !== 'snapshot-parent-revoked'
          if (parentAuthorized)
            assert.equal(
              (await client.models.Parent!.findOrFail('1')).attributes.name,
              'Parent one',
            )
          else
            assert.equal(
              await client.models.Parent!.withTrashed().find('1'),
              null,
            )
          const revoked =
            boundary === 'snapshot-revoked' ||
            boundary === 'pull-revoked' ||
            boundary === 'snapshot-parent-revoked'
          assert.equal(await client.models.Child!.count(), revoked ? 0 : 1)
          assert.equal(await client.models.Grandchild!.count(), revoked ? 0 : 1)
          assert.equal(
            (
              await client.models
                .Parent!.where('id', '1')
                .whereHas('children', (query) => query)
                .get()
            ).length,
            revoked ? 0 : 1,
          )
          if (!revoked) {
            const restored = await client.models
              .Child!.with('parent', 'grandchildren')
              .findOrFail('10')
            assert.equal(restored.attributes.parent_id, '1')
            assert.equal(restored.attributes.other_parent_id, '2')
            assert.equal(
              restored.attributes.note,
              'Independent retained child edit',
            )
            assert.equal(restored.relation('parent').current?.first()?.id, '1')
            assert.equal(restored.relation('grandchildren').current?.length, 1)
            assert.equal(
              (await client.models.Parent!.findOrFail('1')).relation('tags')
                .definition.pivot?.table,
              'parent_tag',
            )
            assert.equal(
              (
                await (
                  await client.models.Parent!.findOrFail('1')
                )
                  .relation('tags')
                  .get()
              ).length,
              1,
            )
          } else {
            const hidden = await client.storage.read((executor) =>
              client.storage.findStored('Child', '10', executor),
            )
            assert.equal(hidden?.visible, false)
            assert.equal(hidden?.canonical.note, 'Canonical child')
            assert.equal(
              (await client.sync.recovery()).find(
                (record) => record.model === 'Child',
              )?.proposal.note,
              'Independent retained child edit',
            )
          }
          const retained = (
            await client.storage.read((executor) =>
              client.storage.pending(executor),
            )
          ).find((entry) => entry.operation.operationId === childOperation)
          assert.equal(
            retained?.operation.values.note,
            'Independent retained child edit',
          )
          assert.equal(retained?.status, 'pending')
          assert.equal(
            (
              await client.storage.read((executor) =>
                executor.execute('PRAGMA foreign_key_check'),
              )
            ).rows.length,
            0,
          )
          await client.close()
          client = await createSynloquent({
            ...configuration(filename, server.transport),
            schema,
          })
          assert.equal(await client.models.Child!.count(), revoked ? 0 : 1)
          if (parentAuthorized)
            assert.equal(
              (await client.models.Parent!.findOrFail('1')).attributes.name,
              'Parent one',
            )
          else assert.equal(await client.models.Parent!.find('1'), null)
        } finally {
          await client.close()
        }
      }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('C57 C58 cancellation retains other parent deletions own child deletion and explicit foreign-key proposals', async () => {
  for (const deletion of ['cascade', 'nullify'] as const) {
    const schema = cancellationSchema(deletion)
    const client = await createSynloquent({ ...configuration(), schema })
    try {
      await client.sync.installSnapshot(snapshot(schema))
      const first = await client.models.Parent!.findOrFail('1')
      const second = await client.models.Parent!.findOrFail('2')
      const child = await client.models.Child!.findOrFail('10')
      await child.update({ note: 'Independent own proposal' })
      const ownEdit = child.lastOperationId!
      await first.delete()
      const firstDelete = first.lastOperationId!
      await second.delete()
      const secondDelete = second.lastOperationId!
      await client.sync.cancel(firstDelete)
      assert.equal(await client.sync.status(secondDelete), 'pending')
      const stillDeleted = await client.storage.read((executor) =>
        client.storage.findStored('Child', '10', executor),
      )
      assert.equal(stillDeleted?.visible, true)
      assert.equal(stillDeleted?.proposal.note, 'Independent own proposal')
      assert.equal(stillDeleted?.deleted, deletion === 'cascade')
      if (deletion === 'nullify') {
        assert.equal(stillDeleted?.attributes.parent_id, '1')
        assert.equal(stillDeleted?.attributes.other_parent_id, null)
      }
      await client.sync.cancel(secondDelete)
      const restored = await client.models.Child!.findOrFail('10')
      assert.equal(restored.attributes.parent_id, '1')
      assert.equal(restored.attributes.other_parent_id, '2')
      assert.equal(restored.attributes.note, 'Independent own proposal')
      await client.sync.cancel(ownEdit)
      await (await client.models.Child!.findOrFail('10')).delete()
      const ownDelete = (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      ).find(
        (entry) =>
          entry.operation.model === 'Child' &&
          entry.operation.action === 'delete',
      )!.operation.operationId
      await (await client.models.Parent!.findOrFail('1')).delete()
      const parentDelete = (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      )
        .filter(
          (entry) =>
            entry.operation.model === 'Parent' && entry.status === 'pending',
        )
        .at(-1)!.operation.operationId
      await client.sync.cancel(parentDelete)
      assert.equal(await client.models.Child!.find('10'), null)
      assert.equal(await client.models.Grandchild!.find('100'), null)
      await client.sync.cancel(ownDelete)
      assert.equal(
        (await client.models.Grandchild!.findOrFail('100')).attributes.title,
        'Canonical grandchild',
      )
      const explicit = await client.models.Child!.findOrFail('10')
      await explicit.update({ parent_id: null, note: 'Explicit own null' })
      const remaining = explicit.lastOperationId!
      await (await client.models.Parent!.findOrFail('1')).delete()
      const latest = (
        await client.storage.read((executor) =>
          client.storage.pending(executor),
        )
      )
        .filter(
          (entry) =>
            entry.operation.model === 'Parent' && entry.status === 'pending',
        )
        .at(-1)!.operation.operationId
      await client.sync.cancel(latest)
      assert.equal(
        (await client.models.Child!.findOrFail('10')).attributes.parent_id,
        null,
      )
      assert.equal(
        (await client.models.Child!.findOrFail('10')).attributes.note,
        'Explicit own null',
      )
      assert.equal(await client.sync.status(remaining), 'pending')
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

test('C16 C17 C43 C51 C57 physical overlay filters every local query route while soft lifecycle and conflict discard remain authorized', async () => {
  const schema = cancellationSchema('cascade')
  const server = testTransport()
  for (const record of records)
    server.records.set(`${record.model}:${record.id}`, record)
  const push = server.transport.push
  server.transport.push = async (request) => {
    const receipts: PushReceipt[] = []
    for (const operation of request.payload.operations)
      if (operation.model === 'Child')
        receipts.push({
          operationId: operation.operationId,
          localIdentity: operation.localIdentity,
          status: 'rejected',
          error: {
            code: 'validation_failed',
            message: 'Retain independent child proposal',
          },
        })
      else
        receipts.push(
          ...(await push({ ...request, payload: { operations: [operation] } }))
            .receipts,
        )
    return { receipts }
  }
  const client = await createSynloquent({
    ...configuration(':memory:', server.transport),
    schema,
  })
  const observation = client.observe(client.models.Child!.where('id', '10'))
  const unsubscribe = observation.subscribe(() => {})
  try {
    await client.sync.installSnapshot(snapshot(schema))
    const child = await client.models.Child!.findOrFail('10')
    await child.update({ note: 'Independent rejected proposal' })
    const childEdit = child.lastOperationId!
    const parent = await client.models.Parent!.findOrFail('1')
    await parent.delete()
    const parentDelete = parent.lastOperationId!
    await observation.refresh()
    assert.equal(observation.getSnapshot().data.length, 0)
    assert.equal(await client.models.Child!.withTrashed().find('10'), null)
    assert.equal(await client.models.Child!.count(), 0)
    assert.equal(
      (await client.models.Child!.groupBy('parent_id').aggregateGroups('count'))
        .groups.length,
      0,
    )
    assert.equal(
      (await client.models.Parent!.whereHas('children', (query) => query).get())
        .length,
      0,
    )
    assert.equal(
      (
        await client.models
          .Parent!.whereHas('grandchildren', (query) => query)
          .get()
      ).length,
      0,
    )
    assert.equal(
      (
        await client.models
          .Grandchild!.join('Child', 'child', 'child_id', 'id')
          .get()
      ).length,
      0,
    )
    assert.equal((await parent.relation('tags').get()).length, 0)
    await assert.rejects(
      parent.update({ name: 'Forbidden invisible edit' }),
      hasCode('forbidden_operation'),
    )
    const soft = await client.models.Item!.findOrFail('9')
    await soft.delete()
    const softDelete = soft.lastOperationId!
    assert.equal(await client.models.Item!.find('9'), null)
    assert.equal(
      (await client.models.Item!.withTrashed().findOrFail('9')).id,
      '9',
    )
    assert.equal(await client.models.Item!.onlyTrashed().count(), 1)
    await client.sync.cancel(softDelete)
    assert.equal(await client.models.Item!.onlyTrashed().count(), 0)
    server.records.set('Parent:1', {
      ...records[0]!,
      revision: '2',
      attributes: { id: '1', name: 'Concurrent server parent' },
    })
    await client.sync.flush()
    assert.equal(await client.sync.status(parentDelete), 'conflicted')
    assert.equal(await client.sync.status(childEdit), 'rejected')
    assert.equal(await client.models.Parent!.find('1'), null)
    await client.sync.resolveConflict(parentDelete, 'discard')
    const restored = await client.models.Child!.findOrFail('10')
    assert.equal(restored.attributes.note, 'Independent rejected proposal')
    assert.equal(restored.syncState, 'rejected')
    assert.equal(
      (await client.models.Parent!.findOrFail('1')).attributes.name,
      'Concurrent server parent',
    )
    assert.equal((await restored.relation('parent').get()).first()?.id, '1')
    await observation.refresh()
    assert.equal(
      observation.getSnapshot().data.first()?.attributes.note,
      'Independent rejected proposal',
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
    observation.dispose()
    await client.close()
  }
})

test('C55 C57 C58 new bulk snapshot descendants inherit pending delete overlays before publication in either record order', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'synloquent-new-snapshot-child-'),
  )
  try {
    for (const deletion of ['cascade', 'nullify'] as const)
      for (const ordering of ['parent-first', 'child-first'] as const) {
        const schema = cancellationSchema(deletion)
        const filename = join(directory, `${deletion}-${ordering}.sqlite`)
        const server = testTransport()
        let client = await createSynloquent({
          ...configuration(filename, server.transport),
          schema,
        })
        const explicit: CanonicalRecord[] = [
          {
            model: 'Child',
            id: '20',
            revision: '1',
            attributes: {
              id: '20',
              parent_id: '1',
              other_parent_id: '2',
              note: 'Explicit canonical child',
            },
          },
          {
            model: 'Grandchild',
            id: '200',
            revision: '1',
            attributes: {
              id: '200',
              child_id: '20',
              title: 'Explicit child descendant',
            },
          },
          {
            model: 'Child',
            id: '30',
            revision: '1',
            attributes: {
              id: '30',
              parent_id: '1',
              other_parent_id: '2',
              note: 'Explicit nullable child',
            },
          },
        ]
        const added: CanonicalRecord[] = [
          {
            model: 'Child',
            id: '11',
            revision: '1',
            attributes: {
              id: '11',
              parent_id: '1',
              other_parent_id: '2',
              note: 'New canonical child',
            },
          },
          {
            model: 'Grandchild',
            id: '101',
            revision: '1',
            attributes: {
              id: '101',
              child_id: '11',
              title: 'New child descendant',
            },
          },
          {
            model: 'Grandchild',
            id: '102',
            revision: '1',
            attributes: {
              id: '102',
              child_id: '10',
              title: 'New existing-child descendant',
            },
          },
        ]
        try {
          await client.sync.installSnapshot(
            snapshotFor([...records, ...explicit], schema),
          )
          const retained = await client.models.Child!.findOrFail('10')
          await retained.update({ note: 'Retained existing child edit' })
          const retainedOperation = retained.lastOperationId!
          const reassociated = await client.models.Child!.findOrFail('20')
          await reassociated.update({
            parent_id: '2',
            note: 'Explicit pending reassociation',
          })
          const reassociationOperation = reassociated.lastOperationId!
          const nullable = await client.models.Child!.findOrFail('30')
          await nullable.update({ parent_id: null })
          const nullableOperation = nullable.lastOperationId!
          const parent = await client.models.Parent!.findOrFail('1')
          await parent.delete()
          const parentDeletion = parent.lastOperationId!
          const expanded = [...records, ...explicit, ...added]
          const document = snapshotFor(
            ordering === 'child-first' ? [...expanded].reverse() : expanded,
            schema,
          )
          await client.sync.installSnapshot({
            ...document,
            generation: 'snapshot-new-descendants',
          })
          const expectedChildren =
            deletion === 'cascade' ? ['20', '30'] : ['10', '11', '20', '30']
          assert.deepEqual(
            (await client.models.Child!.orderBy('id').get())
              .map((model) => String(model.id))
              .all(),
            expectedChildren,
            `${deletion}/${ordering} visible children`,
          )
          assert.deepEqual(
            (await client.models.Grandchild!.orderBy('id').get())
              .map((model) => String(model.id))
              .all(),
            deletion === 'cascade' ? ['200'] : ['100', '101', '102', '200'],
            `${deletion}/${ordering} recursive descendants`,
          )
          const newChild = await client.storage.read((executor) =>
            client.storage.findStored('Child', '11', executor),
          )
          assert.equal(newChild?.visible, true)
          assert.equal(newChild?.deleted, deletion === 'cascade')
          assert.equal(newChild?.canonical.parent_id, '1')
          if (deletion === 'nullify')
            assert.equal(newChild?.proposal.parent_id, null)
          assert.equal(
            (await client.models.Child!.findOrFail('20')).attributes.parent_id,
            '2',
          )
          assert.equal(
            (await client.models.Child!.findOrFail('30')).attributes.parent_id,
            null,
          )
          const pulledChild: CanonicalRecord = {
            model: 'Child',
            id: '12',
            revision: '1',
            attributes: {
              id: '12',
              parent_id: '1',
              other_parent_id: '2',
              note: 'New pull child',
            },
          }
          const pulledGrandchild: CanonicalRecord = {
            model: 'Grandchild',
            id: '103',
            revision: '1',
            attributes: {
              id: '103',
              child_id: '12',
              title: 'Child-first pull descendant',
            },
          }
          server.transport.pull = async () => ({
            batches: [
              {
                cursor: 'new-descendants-pull',
                changes: [
                  pulledGrandchild,
                  pulledChild,
                  records.find((record) => record.model === 'Child')!,
                  ...explicit.filter((record) => record.model === 'Child'),
                ].map((record) => ({
                  kind: 'upsert' as const,
                  model: record.model,
                  id: record.id,
                  record,
                })),
                relationSets: [],
              },
              {
                cursor: 'revoked-new-child',
                changes: [
                  { kind: 'remove' as const, model: 'Child', id: '11' },
                  { kind: 'remove' as const, model: 'Grandchild', id: '101' },
                ],
                relationSets: [],
              },
            ],
            cursor: 'revoked-new-child',
            highWater: 'revoked-new-child',
            scanComplete: true,
            scope: document.scope,
          })
          await client.sync.pull()
          const expectedAfterPull =
            deletion === 'cascade' ? ['20', '30'] : ['10', '12', '20', '30']
          assert.deepEqual(
            (await client.models.Child!.orderBy('id').get())
              .map((model) => String(model.id))
              .all(),
            expectedAfterPull,
          )
          assert.equal(await client.models.Child!.find('11'), null)
          assert.equal(
            (await client.models.Child!.findOrFail('20')).attributes.parent_id,
            '2',
          )
          assert.equal(
            (await client.models.Child!.findOrFail('30')).attributes.parent_id,
            null,
          )
          await client.close()
          client = await createSynloquent({
            ...configuration(filename, server.transport),
            schema,
          })
          assert.deepEqual(
            (await client.models.Child!.orderBy('id').get())
              .map((model) => String(model.id))
              .all(),
            expectedAfterPull,
          )
          await client.sync.cancel(parentDeletion)
          assert.deepEqual(
            (await client.models.Child!.orderBy('id').get())
              .map((model) => String(model.id))
              .all(),
            ['10', '12', '20', '30'],
          )
          assert.equal(
            (await client.models.Child!.findOrFail('12')).attributes.parent_id,
            '1',
          )
          assert.equal(
            (await client.models.Child!.findOrFail('10')).attributes.note,
            'Retained existing child edit',
          )
          assert.equal(
            (await client.models.Child!.findOrFail('20')).attributes.parent_id,
            '2',
          )
          assert.equal(await client.models.Grandchild!.count(), 4)
          assert.equal(await client.models.Child!.find('11'), null)
          assert.equal(await client.models.Grandchild!.find('101'), null)
          assert.equal(
            (await client.models.Child!.findOrFail('30')).attributes.parent_id,
            null,
          )
          assert.equal(await client.sync.status(nullableOperation), 'pending')
          assert.equal(await client.sync.status(retainedOperation), 'pending')
          assert.equal(
            await client.sync.status(reassociationOperation),
            'pending',
          )
          assert.equal(
            (
              await client.storage.read((executor) =>
                executor.execute('PRAGMA foreign_key_check'),
              )
            ).rows.length,
            0,
          )
          await client.close()
          client = await createSynloquent({
            ...configuration(filename, server.transport),
            schema,
          })
          assert.deepEqual(
            (await client.models.Child!.orderBy('id').get())
              .map((model) => String(model.id))
              .all(),
            ['10', '12', '20', '30'],
          )
          assert.equal(await client.models.Grandchild!.find('101'), null)
          assert.equal(
            (await client.models.Child!.findOrFail('30')).attributes.parent_id,
            null,
          )
        } finally {
          await client.close()
        }
      }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('C54 C55 C57 C58 rejected and conflicted hard deletes retain descendants until discard across snapshot pull and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synloquent-delete-retained-'))
  try {
    for (const deletion of ['cascade', 'nullify'] as const)
      for (const status of ['rejected', 'conflicted'] as const) {
        const schema = cancellationSchema(deletion)
        const filename = join(directory, `${deletion}-${status}.sqlite`)
        const server = testTransport()
        const canonicalParent = { ...records[0]!, revision: '2' }
        server.transport.push = async (request) => ({
          receipts: request.payload.operations.map((operation) => ({
            operationId: operation.operationId,
            localIdentity: operation.localIdentity,
            status,
            ...(operation.model === 'Parent' && status === 'conflicted'
              ? { canonical: canonicalParent }
              : {}),
            error: {
              code: status === 'conflicted' ? 'conflict' : 'validation_failed',
              message: 'Retain the local lifecycle until explicit discard',
            },
          })),
        })
        let client = await createSynloquent({
          ...configuration(filename, server.transport),
          schema,
        })
        const moved: CanonicalRecord = {
          model: 'Child',
          id: '20',
          revision: '1',
          attributes: {
            id: '20',
            parent_id: '1',
            other_parent_id: '2',
            note: 'Canonical reassociation control',
          },
        }
        const newChild: CanonicalRecord = {
          ...moved,
          id: '11',
          attributes: { ...moved.attributes, id: '11', note: 'New descendant' },
        }
        try {
          await client.sync.installSnapshot(
            snapshotFor([...records, moved], schema),
          )
          const explicit = await client.models.Child!.findOrFail('20')
          await explicit.update({ parent_id: '2', note: 'Retained own FK' })
          const explicitOperation = explicit.lastOperationId!
          const parent = await client.models.Parent!.findOrFail('1')
          await parent.delete()
          const parentOperation = parent.lastOperationId!
          await client.sync.flush()
          assert.equal(await client.sync.status(parentOperation), status)
          const expanded = [
            canonicalParent,
            ...records.slice(1),
            moved,
            newChild,
          ]
          const document = snapshotFor([...expanded].reverse(), schema)
          await client.sync.installSnapshot(document)
          const expected = deletion === 'cascade' ? ['20'] : ['10', '11', '20']
          assert.deepEqual(
            (await client.models.Child!.orderBy('id').get())
              .map((model) => String(model.id))
              .all(),
            expected,
          )
          const retainedParent = await client.storage.read((executor) =>
            client.storage.findStored('Parent', '1', executor),
          )
          assert.equal(retainedParent?.state, status)
          assert.equal(retainedParent?.visible, true)
          assert.equal(retainedParent?.deleted, true)
          server.transport.pull = async () => ({
            batches: [
              {
                cursor: 'retained-delete-pull',
                changes: [...expanded].reverse().map((record) => ({
                  kind: 'upsert' as const,
                  model: record.model,
                  id: record.id,
                  record,
                })),
                relationSets: [],
              },
            ],
            cursor: 'retained-delete-pull',
            highWater: 'retained-delete-pull',
            scanComplete: true,
            scope: document.scope,
          })
          await client.sync.pull()
          assert.deepEqual(
            (await client.models.Child!.orderBy('id').get())
              .map((model) => String(model.id))
              .all(),
            expected,
          )
          if (deletion === 'nullify')
            assert.equal(
              (await client.models.Child!.findOrFail('11')).attributes
                .parent_id,
              null,
            )
          assert.equal(
            (await client.models.Child!.findOrFail('20')).attributes.parent_id,
            '2',
          )
          await client.close()
          client = await createSynloquent({
            ...configuration(filename, server.transport),
            schema,
          })
          assert.equal(await client.sync.status(parentOperation), status)
          assert.deepEqual(
            (await client.models.Child!.orderBy('id').get())
              .map((model) => String(model.id))
              .all(),
            expected,
          )
          await client.sync.resolveConflict(parentOperation, 'discard')
          assert.equal(await client.models.Child!.count(), 3)
          assert.equal(await client.models.Grandchild!.count(), 1)
          assert.equal(
            (await client.models.Child!.findOrFail('10')).attributes.parent_id,
            '1',
          )
          assert.equal(
            (await client.models.Child!.findOrFail('20')).attributes.parent_id,
            '2',
          )
          assert.equal(await client.sync.status(explicitOperation), status)
          assert.equal(await client.sync.status(parentOperation), 'cancelled')
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
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('C52 C57 C58 revoked pending-delete parents cannot reapply a local cascade during child cancellation', async () => {
  const schema = cancellationSchema('cascade')
  const client = await createSynloquent({ ...configuration(), schema })
  try {
    await client.sync.installSnapshot(snapshot(schema))
    const child = await client.models.Child!.findOrFail('10')
    await child.update({ note: 'Own retained edit' })
    const ownOperation = child.lastOperationId!
    await (await client.models.Parent!.findOrFail('1')).delete()
    await client.sync.installSnapshot(
      snapshotFor(
        records.filter(
          (record) => !(record.model === 'Parent' && record.id === '1'),
        ),
        schema,
      ),
    )
    assert.equal(
      (await client.models.Child!.findOrFail('10')).attributes.note,
      'Own retained edit',
    )
    await client.sync.cancel(ownOperation)
    assert.equal(
      (await client.models.Child!.findOrFail('10')).attributes.note,
      'Canonical child',
    )
    assert.equal(await client.models.Grandchild!.count(), 1)
    assert.equal(await client.models.Parent!.find('1'), null)
  } finally {
    await client.close()
  }
})

test('C55 C58 indexed delete replay touches only matching descendants and preserves restrict for already deleted children', async () => {
  const schema = cancellationSchema('cascade')
  const original = configuration()
  const statements: {
    statement: string
    parameters: readonly BindValue[]
    rows: number
  }[] = []
  const wrap = (executor: TransactionExecutor): TransactionExecutor => ({
    async execute(statement, parameters = []) {
      const result = await executor.execute(statement, parameters)
      statements.push({ statement, parameters, rows: result.rows.length })
      return result
    },
    transaction: (callback) =>
      executor.transaction((transaction) => callback(wrap(transaction))),
  })
  const database: DatabaseAdapter = {
    ...original.database,
    execute: wrap(original.database).execute,
    transaction: (callback, mode) =>
      original.database.transaction(
        (transaction) => callback(wrap(transaction)),
        mode,
      ),
  }
  const client = await createSynloquent({ ...original, database, schema })
  try {
    await client.sync.installSnapshot(snapshot(schema))
    await (await client.models.Parent!.findOrFail('1')).delete()
    const unrelated: CanonicalRecord[] = Array.from(
      { length: 4096 },
      (_value, position) => ({
        model: 'Child',
        id: String(1000 + position),
        revision: '1',
        attributes: {
          id: String(1000 + position),
          parent_id: '2',
          other_parent_id: '2',
          note: 'Unrelated catalog child',
        },
      }),
    )
    const added: CanonicalRecord[] = Array.from(
      { length: 5 },
      (_value, position) => ({
        model: 'Child',
        id: String(20 + position),
        revision: '1',
        attributes: {
          id: String(20 + position),
          parent_id: '1',
          other_parent_id: '2',
          note: 'Matching new child',
        },
      }),
    )
    statements.length = 0
    await client.sync.installSnapshot(
      snapshotFor([...records, ...unrelated, ...added], schema),
    )
    const lookups = statements.filter(
      ({ statement }) =>
        statement.startsWith('SELECT * FROM "syn_model_Child"') &&
        statement.includes('"_order_parent_id" IN'),
    )
    assert.equal(lookups.length, 1)
    assert.equal(lookups[0]?.rows, 6)
    const lookup = lookups[0]!
    const plan = await client.storage.read((executor) =>
      executor.execute(
        `EXPLAIN QUERY PLAN ${lookup.statement}`,
        lookup.parameters,
      ),
    )
    assert.ok(
      plan.rows.some(
        (row) =>
          String(row.detail).includes('syn_ordered_index_Child_0') &&
          String(row.detail).includes('_order_parent_id=?'),
      ),
    )
    assert.ok(!plan.rows.some((row) => String(row.detail).startsWith('SCAN ')))
    assert.ok(
      statements.filter(({ statement }) =>
        statement.startsWith('INSERT INTO "syn_model_Child"'),
      ).length < 80,
    )
    assert.equal(await client.models.Child!.count(), 4096)
  } finally {
    await client.close()
  }
  const restricted: Manifest = {
    ...schema,
    fingerprint: 'delete-replay-restrict',
    models: {
      ...schema.models,
      Child: {
        ...schema.models.Child!,
        relations: {
          ...schema.models.Child!.relations,
          parent: {
            ...schema.models.Child!.relations.parent!,
            onDelete: 'restrict',
          },
        },
      },
    },
  }
  const restrictedClient = await createSynloquent({
    ...configuration(),
    schema: restricted,
  })
  try {
    await restrictedClient.sync.installSnapshot(
      snapshotFor(records, restricted),
    )
    await (await restrictedClient.models.Child!.findOrFail('10')).delete()
    await (await restrictedClient.models.Parent!.findOrFail('1')).delete()
    await restrictedClient.sync.installSnapshot(
      snapshotFor([...records].reverse(), restricted),
    )
    assert.equal(await restrictedClient.models.Child!.count(), 0)
    assert.equal(
      await restrictedClient.models.Parent!.where('id', '1').count(),
      0,
    )
  } finally {
    await restrictedClient.close()
  }
})
