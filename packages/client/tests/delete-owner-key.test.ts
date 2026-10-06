import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSynloquent } from '../src/index.js'
import type {
  CanonicalRecord,
  FieldDefinition,
  Manifest,
  PushReceipt,
} from '../src/index.js'
import { configuration, manifest, snapshotFor } from './fixtures.js'
import { testTransport } from './transport-fixture.js'

function ownerKeySchema(deletion: 'cascade' | 'nullify'): Manifest {
  const string = {
    type: 'string' as const,
    nullable: false,
    readable: true,
    writable: true,
  }
  const integer = manifest.models.Tag!.fields.id!
  return {
    ...manifest,
    fingerprint: `delete-owner-key-${deletion}`,
    models: {
      Owner: {
        resource: 'owners',
        table: 'owners',
        primaryKey: 'id',
        keyType: 'integer',
        incrementing: true,
        fields: { id: integer, code: string, title: string },
        operations: ['create', 'update', 'delete'],
        unique: [['code']],
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
          id: integer,
          owner_code: { ...string, nullable: true },
          title: string,
        },
        operations: ['create', 'update', 'delete'],
        indexes: [['owner_code']],
        relations: {
          owner: {
            type: 'belongsTo',
            model: 'Owner',
            foreignKey: 'owner_code',
            ownerKey: 'code',
            onDelete: deletion,
            onUpdate: 'cascade',
          },
        },
      },
    },
  }
}

function canonicalOwner(
  identifier: string,
  code: string,
  title: string,
): CanonicalRecord {
  return {
    model: 'Owner',
    id: identifier,
    revision: '1',
    attributes: { id: identifier, code, title },
  }
}

function canonicalChild(
  identifier: string,
  ownerCode: string,
  title: string,
): CanonicalRecord {
  return {
    model: 'Child',
    id: identifier,
    revision: '1',
    attributes: { id: identifier, owner_code: ownerCode, title },
  }
}

test('C29 C55 C57 C58 explicit natural foreign key reassociation survives pending rejected and conflicted owner deletion snapshot pull cancel discard and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synloquent-owner-key-move-'))
  try {
    for (const deletion of ['cascade', 'nullify'] as const)
      for (const targetCode of ['second-owner', null] as const)
        for (const ownerStatus of [
          'pending',
          'rejected',
          'conflicted',
        ] as const)
          for (const boundary of ['snapshot', 'pull'] as const) {
            const schema = ownerKeySchema(deletion)
            const server = testTransport()
            const filename = join(
              directory,
              `${deletion}-${targetCode ?? 'explicit-null'}-${ownerStatus}-${boundary}.sqlite`,
            )
            const original = [
              canonicalOwner('1', 'first-owner', 'First owner'),
              canonicalOwner('2', 'second-owner', 'Second owner'),
              canonicalChild('10', 'first-owner', 'Explicit child'),
              canonicalChild('11', 'first-owner', 'Dependent child'),
            ]
            const retainedOwner: CanonicalRecord =
              ownerStatus === 'conflicted'
                ? {
                    ...original[0]!,
                    revision: '2',
                    attributes: {
                      ...original[0]!.attributes,
                      title: 'Concurrent canonical owner',
                    },
                  }
                : original[0]!
            const expanded = [
              retainedOwner,
              ...original.slice(1),
              canonicalChild('12', 'first-owner', 'New canonical child'),
            ]
            let client = await createSynloquent({
              ...configuration(filename, server.transport),
              schema,
            })
            try {
              await client.sync.installSnapshot(snapshotFor(original, schema))
              const movedChild = await client.models.Child!.findOrFail('10')
              await movedChild.update({
                owner_code: targetCode,
                title: 'Independent reassociated child proposal',
              })
              const childOperation = movedChild.lastOperationId!
              const owner = await client.models.Owner!.findOrFail('1')
              await owner.delete()
              const ownerDeletion = owner.lastOperationId!
              const childStatus =
                ownerStatus === 'pending' ? 'pending' : 'rejected'
              if (ownerStatus !== 'pending') {
                server.transport.push = async (request) => ({
                  receipts: request.payload.operations.map<PushReceipt>(
                    (operation) => {
                      if (operation.model === 'Child') {
                        assert.equal(operation.values.owner_code, targetCode)
                        assert.equal(
                          operation.values.title,
                          'Independent reassociated child proposal',
                        )
                        return {
                          operationId: operation.operationId,
                          localIdentity: operation.localIdentity,
                          status: 'rejected',
                          error: {
                            code: 'validation_failed',
                            message: 'Retain the independent child proposal.',
                          },
                        }
                      }
                      assert.equal(operation.model, 'Owner')
                      assert.equal(operation.action, 'delete')
                      return {
                        operationId: operation.operationId,
                        localIdentity: operation.localIdentity,
                        status: ownerStatus,
                        ...(ownerStatus === 'conflicted'
                          ? { canonical: retainedOwner }
                          : {}),
                        error: {
                          code:
                            ownerStatus === 'conflicted'
                              ? 'conflict'
                              : 'forbidden_operation',
                          message: 'Retain the pending owner deletion overlay.',
                        },
                      }
                    },
                  ),
                })
                await client.sync.flush()
                assert.equal(
                  await client.sync.status(ownerDeletion),
                  ownerStatus,
                )
                assert.equal(
                  await client.sync.status(childOperation),
                  childStatus,
                )
              }
              if (boundary === 'snapshot')
                await client.sync.installSnapshot({
                  ...snapshotFor([...expanded].reverse(), schema),
                  generation: 'retained-natural-key-snapshot',
                })
              else {
                server.transport.pull = async () => ({
                  batches: [
                    {
                      cursor: 'retained-natural-key-pull',
                      relationSets: [],
                      changes: [...expanded].reverse().map((record) => ({
                        kind: 'upsert' as const,
                        model: record.model,
                        id: record.id,
                        record,
                      })),
                    },
                  ],
                  cursor: 'retained-natural-key-pull',
                  highWater: 'retained-natural-key-pull',
                  scanComplete: true,
                  scope: snapshotFor(original, schema).scope,
                })
                await client.sync.pull()
              }
              const visible = await client.models.Child!.findOrFail('10')
              assert.equal(visible.attributes.owner_code, targetCode)
              assert.equal(
                visible.attributes.title,
                'Independent reassociated child proposal',
              )
              assert.equal(visible.syncState, childStatus)
              assert.equal(
                (await visible.relation('owner').get()).first()?.id ?? null,
                targetCode === null ? null : '2',
              )
              const stored = await client.storage.read((executor) =>
                client.storage.findStored('Child', '10', executor),
              )
              assert.equal(stored?.visible, true)
              assert.equal(stored?.deleted, false)
              assert.equal(stored?.canonical.owner_code, 'first-owner')
              assert.equal(stored?.proposal.owner_code, targetCode)
              assert.equal(
                await client.sync.status(childOperation),
                childStatus,
              )
              assert.equal(await client.sync.status(ownerDeletion), ownerStatus)
              if (ownerStatus === 'conflicted') {
                const canonical = await client.storage.read((executor) =>
                  client.storage.findStored('Owner', '1', executor),
                )
                assert.equal(canonical?.revision, '2')
                assert.equal(
                  canonical?.canonical.title,
                  'Concurrent canonical owner',
                )
              }
              assert.equal(
                await client.models.Child!.count(),
                deletion === 'cascade' ? 1 : 3,
              )
              for (const identifier of ['11', '12']) {
                const dependent = await client.storage.read((executor) =>
                  client.storage.findStored('Child', identifier, executor),
                )
                assert.equal(dependent?.visible, true)
                assert.equal(dependent?.deleted, deletion === 'cascade')
                assert.equal(dependent?.canonical.owner_code, 'first-owner')
                if (deletion === 'nullify')
                  assert.equal(dependent?.proposal.owner_code, null)
              }
              await client.close()
              client = await createSynloquent({
                ...configuration(filename, server.transport),
                schema,
              })
              assert.equal(await client.models.Owner!.find('1'), null)
              assert.equal(
                (await client.models.Child!.findOrFail('10')).attributes
                  .owner_code,
                targetCode,
              )
              const retainedChild = await client.models.Child!.findOrFail('10')
              assert.equal(retainedChild.syncState, childStatus)
              assert.equal(
                retainedChild.attributes.title,
                'Independent reassociated child proposal',
              )
              const retainedIntent = (
                await client.storage.read((executor) =>
                  client.storage.pending(executor),
                )
              ).find((entry) => entry.operation.operationId === childOperation)
              assert.equal(retainedIntent?.status, childStatus)
              assert.equal(
                retainedIntent?.operation.values.owner_code,
                targetCode,
              )
              assert.equal(
                retainedIntent?.operation.values.title,
                'Independent reassociated child proposal',
              )
              assert.equal(await client.sync.status(ownerDeletion), ownerStatus)
              if (ownerStatus === 'pending')
                await client.sync.cancel(ownerDeletion)
              else await client.sync.resolveConflict(ownerDeletion, 'discard')
              assert.equal(await client.sync.status(ownerDeletion), 'cancelled')
              assert.equal(await client.models.Child!.count(), 3)
              for (const identifier of ['11', '12'])
                assert.equal(
                  (await client.models.Child!.findOrFail(identifier)).attributes
                    .owner_code,
                  'first-owner',
                )
              assert.equal(
                (await client.models.Child!.findOrFail('10')).attributes
                  .owner_code,
                targetCode,
              )
              assert.equal(
                (await client.models.Child!.findOrFail('10')).attributes.title,
                'Independent reassociated child proposal',
              )
              assert.equal(
                await client.sync.status(childOperation),
                childStatus,
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
              assert.equal(await client.models.Child!.count(), 3)
              assert.equal(
                (await client.models.Child!.findOrFail('10')).attributes
                  .owner_code,
                targetCode,
              )
            } finally {
              await client.close()
            }
          }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('C29 C55 C58 a live replacement natural owner retains new canonical children while the historical owner delete remains pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synloquent-owner-key-reuse-'))
  try {
    for (const deletion of ['cascade', 'nullify'] as const) {
      const schema = ownerKeySchema(deletion)
      const server = testTransport()
      const filename = join(directory, `${deletion}.sqlite`)
      const historical = canonicalOwner('1', 'reused-code', 'Historical owner')
      const replacement = canonicalOwner(
        '2',
        'reused-code',
        'Live replacement owner',
      )
      const child = canonicalChild('20', 'reused-code', 'New replacement child')
      let client = await createSynloquent({
        ...configuration(filename, server.transport),
        schema,
      })
      try {
        await client.sync.installSnapshot(snapshotFor([historical], schema))
        const owner = await client.models.Owner!.findOrFail('1')
        await owner.delete()
        const ownerDeletion = owner.lastOperationId!
        await client.sync.installSnapshot({
          ...snapshotFor([child, replacement, historical], schema),
          generation: 'replacement-owner-snapshot',
        })
        const current = await client.models.Child!.findOrFail('20')
        assert.equal(current.attributes.owner_code, 'reused-code')
        assert.equal(current.syncState, 'synced')
        assert.equal((await current.relation('owner').get()).first()?.id, '2')
        assert.equal(await client.models.Owner!.find('1'), null)
        assert.equal(await client.models.Owner!.count(), 1)
        assert.equal(await client.sync.status(ownerDeletion), 'pending')
        server.transport.pull = async () => ({
          batches: [
            {
              cursor: 'replacement-owner-pull',
              relationSets: [],
              changes: [child, historical, replacement].map((record) => ({
                kind: 'upsert' as const,
                model: record.model,
                id: record.id,
                record,
              })),
            },
          ],
          cursor: 'replacement-owner-pull',
          highWater: 'replacement-owner-pull',
          scanComplete: true,
          scope: snapshotFor([historical], schema).scope,
        })
        await client.sync.pull()
        assert.equal(
          (await client.models.Child!.findOrFail('20')).attributes.owner_code,
          'reused-code',
        )
        assert.equal(
          (
            await (
              await client.models.Child!.findOrFail('20')
            )
              .relation('owner')
              .get()
          ).first()?.id,
          '2',
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
        assert.equal(await client.sync.status(ownerDeletion), 'pending')
        assert.equal(await client.models.Owner!.find('1'), null)
        const restarted = await client.models.Child!.findOrFail('20')
        assert.equal(restarted.attributes.owner_code, 'reused-code')
        assert.equal((await restarted.relation('owner').get()).first()?.id, '2')
      } finally {
        await client.close()
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (const deletion of ['cascade', 'nullify'] as const)
  test(`C29 C55 C57 C58 pending natural owner key update then hard delete preserves old canonical children across snapshot child-first pull cancel restart (${deletion})`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'synloquent-owner-key-update-'),
    )
    const schema = ownerKeySchema(deletion)
    const server = testTransport()
    const filename = join(directory, 'pending-owner-key.sqlite')
    const original = [
      canonicalOwner('1', 'old-code', 'Owner with canonical key'),
      canonicalChild('10', 'old-code', 'Existing child'),
    ]
    const added = canonicalChild('11', 'old-code', 'New canonical child')
    let client = await createSynloquent({
      ...configuration(filename, server.transport),
      schema,
    })
    try {
      await client.sync.installSnapshot(snapshotFor(original, schema))
      const owner = await client.models.Owner!.findOrFail('1')
      await owner.update({ code: 'new-code' })
      const ownerUpdate = owner.lastOperationId!
      assert.equal(
        (await client.models.Child!.findOrFail('10')).attributes.owner_code,
        'new-code',
      )
      const child = await client.models.Child!.findOrFail('10')
      await child.update({ title: 'Independent retained child edit' })
      const childOperation = child.lastOperationId!
      await owner.delete()
      const ownerDeletion = owner.lastOperationId!
      await assert.doesNotReject(
        client.sync.installSnapshot({
          ...snapshotFor([added, ...original].reverse(), schema),
          generation: 'updated-owner-new-canonical-child',
        }),
        'Valid canonical children with the original natural key inherit the pending owner update and delete overlay before SQLite integrity checks.',
      )
      for (const identifier of ['10', '11']) {
        const pending = await client.storage.read((executor) =>
          client.storage.findStored('Child', identifier, executor),
        )
        assert.equal(pending?.visible, true)
        assert.equal(pending?.deleted, deletion === 'cascade')
        assert.equal(pending?.canonical.owner_code, 'old-code')
        if (deletion === 'nullify')
          assert.equal(pending?.proposal.owner_code, null)
      }
      const pulledChild = canonicalChild(
        '12',
        'old-code',
        'Child-first pulled canonical child',
      )
      server.transport.pull = async () => ({
        batches: [
          {
            cursor: 'updated-owner-child-first-pull',
            relationSets: [],
            changes: [pulledChild, added, original[1]!, original[0]!].map(
              (record) => ({
                kind: 'upsert' as const,
                model: record.model,
                id: record.id,
                record,
              }),
            ),
          },
        ],
        cursor: 'updated-owner-child-first-pull',
        highWater: 'updated-owner-child-first-pull',
        scanComplete: true,
        scope: snapshotFor(original, schema).scope,
      })
      await assert.doesNotReject(
        client.sync.pull(),
        'A child-first pull with the canonical owner key inherits both retained owner overlays before publication.',
      )
      for (const identifier of ['10', '11', '12']) {
        const pending = await client.storage.read((executor) =>
          client.storage.findStored('Child', identifier, executor),
        )
        assert.equal(pending?.visible, true)
        assert.equal(pending?.deleted, deletion === 'cascade')
        assert.equal(pending?.canonical.owner_code, 'old-code')
        assert.equal(pending?.state, 'pending')
        if (deletion === 'nullify')
          assert.equal(pending?.proposal.owner_code, null)
      }
      await client.close()
      client = await createSynloquent({
        ...configuration(filename, server.transport),
        schema,
      })
      await client.sync.cancel(ownerDeletion)
      assert.equal(await client.models.Child!.count(), 3)
      assert.equal(
        (await client.models.Owner!.findOrFail('1')).attributes.code,
        'new-code',
      )
      for (const identifier of ['10', '11', '12']) {
        const restored = await client.models.Child!.findOrFail(identifier)
        assert.equal(restored.attributes.owner_code, 'new-code')
        assert.equal((await restored.relation('owner').get()).first()?.id, '1')
      }
      assert.equal(
        (await client.models.Child!.findOrFail('10')).attributes.title,
        'Independent retained child edit',
      )
      assert.equal(await client.sync.status(ownerUpdate), 'pending')
      assert.equal(await client.sync.status(childOperation), 'pending')
      await client.close()
      client = await createSynloquent({
        ...configuration(filename, server.transport),
        schema,
      })
      for (const identifier of ['10', '11', '12'])
        assert.equal(
          (await client.models.Child!.findOrFail(identifier)).attributes
            .owner_code,
          'new-code',
        )
      await client.sync.cancel(ownerUpdate)
      assert.equal(
        (await client.models.Owner!.findOrFail('1')).attributes.code,
        'old-code',
      )
      for (const identifier of ['10', '11', '12'])
        assert.equal(
          (await client.models.Child!.findOrFail(identifier)).attributes
            .owner_code,
          'old-code',
        )
      assert.equal(
        (await client.models.Child!.findOrFail('10')).attributes.title,
        'Independent retained child edit',
      )
      assert.equal(await client.sync.status(childOperation), 'pending')
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
      await rm(directory, { recursive: true, force: true })
    }
  })

test('C29 C53 C57 C58 accepted natural key changes survive rejected or conflicted owner deletes with explicit child proposals membership and restart', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'synloquent-accepted-key-rejected-delete-'),
  )
  const string: FieldDefinition = {
    type: 'string',
    nullable: false,
    readable: true,
    writable: true,
  }
  const variants = [
    {
      name: 'string',
      field: string,
      oldValue: 'old-code',
      newValue: 'new-code',
      otherValue: 'second-code',
    },
    {
      name: 'unsafe-integer',
      field: { ...string, type: 'integer' as const },
      oldValue: '9007199254740993',
      newValue: '9007199254740995',
      otherValue: '9007199254740997',
    },
    {
      name: 'exact-decimal',
      field: { ...string, type: 'decimal' as const, precision: 2 },
      oldValue: '90071992547409.91',
      newValue: '90071992547409.92',
      otherValue: '90071992547409.93',
    },
  ]
  try {
    for (const deletion of ['cascade', 'nullify'] as const)
      for (const status of ['rejected', 'conflicted'] as const)
        for (const primary of ['integer', 'custom-string'] as const)
          for (const variant of variants) {
            const base = ownerKeySchema(deletion)
            const primaryKey = primary === 'integer' ? 'id' : 'catalog_key'
            const ownerIdentity = primary === 'integer' ? '1' : 'owner-first'
            const secondOwnerIdentity =
              primary === 'integer' ? '2' : 'owner-second'
            const schema: Manifest = {
              ...base,
              fingerprint: `accepted-key-delete-${deletion}-${status}-${primary}-${variant.name}`,
              models: {
                Owner: {
                  ...base.models.Owner!,
                  primaryKey,
                  keyType: primary === 'integer' ? 'integer' : 'string',
                  incrementing: primary === 'integer',
                  fields: {
                    [primaryKey]:
                      primary === 'integer'
                        ? manifest.models.Tag!.fields.id!
                        : { ...string, writable: false },
                    code: variant.field,
                    title: string,
                  },
                },
                Child: {
                  ...base.models.Child!,
                  fields: {
                    ...base.models.Child!.fields,
                    owner_code: { ...variant.field, nullable: true },
                  },
                },
              },
            }
            const canonical = (
              identifier: string,
              value: string,
              title: string,
              revision = '1',
            ): CanonicalRecord => ({
              model: 'Owner',
              id: identifier,
              revision,
              attributes: { [primaryKey]: identifier, code: value, title },
            })
            const accepted = canonical(
              ownerIdentity,
              variant.newValue,
              'Accepted owner',
              '2',
            )
            const server = testTransport()
            server.transport.push = async (request) => ({
              receipts: request.payload.operations.map<PushReceipt>(
                (operation) => {
                  if (
                    operation.model === 'Owner' &&
                    operation.action === 'update'
                  ) {
                    assert.equal(operation.values.code, variant.newValue)
                    return {
                      operationId: operation.operationId,
                      localIdentity: operation.localIdentity,
                      status: 'accepted',
                      canonical: accepted,
                    }
                  }
                  return {
                    operationId: operation.operationId,
                    localIdentity: operation.localIdentity,
                    status: operation.model === 'Owner' ? status : 'rejected',
                    ...(operation.model === 'Owner' && status === 'conflicted'
                      ? { canonical: { ...accepted, revision: '3' } }
                      : {}),
                    error: {
                      code:
                        status === 'conflicted' && operation.model === 'Owner'
                          ? 'conflict'
                          : 'forbidden_operation',
                      message:
                        'Keep rejected proposals until explicit resolution',
                    },
                  }
                },
              ),
            })
            const filename = join(directory, `${schema.fingerprint}.sqlite`)
            let client = await createSynloquent({
              ...configuration(filename, server.transport),
              schema,
            })
            try {
              await client.sync.installSnapshot(
                snapshotFor(
                  [
                    canonical(
                      ownerIdentity,
                      variant.oldValue,
                      'Original owner',
                    ),
                    canonical(
                      secondOwnerIdentity,
                      variant.otherValue,
                      'Other owner',
                    ),
                    ...['10', '20', '30', '40', '50'].map((identifier) =>
                      canonicalChild(
                        identifier,
                        variant.oldValue,
                        `Canonical child ${identifier}`,
                      ),
                    ),
                  ],
                  schema,
                ),
              )
              const ownTitle = await client.models.Child!.findOrFail('10')
              await ownTitle.update({
                title: 'Independent retained child title',
              })
              const titleOperation = ownTitle.lastOperationId!
              const ownOwner = await client.models.Child!.findOrFail('20')
              await ownOwner.update({ owner_code: variant.otherValue })
              const foreignOperation = ownOwner.lastOperationId!
              const ownNull = await client.models.Child!.findOrFail('30')
              await ownNull.update({ owner_code: null })
              const nullOperation = ownNull.lastOperationId!
              const ownDelete = await client.models.Child!.findOrFail('40')
              await ownDelete.delete()
              const childDeletion = ownDelete.lastOperationId!
              const owner = await client.models.Owner!.findOrFail(ownerIdentity)
              await owner.update({ code: variant.newValue })
              const ownerUpdate = owner.lastOperationId!
              await owner.delete()
              const ownerDeletion = owner.lastOperationId!
              const document = snapshotFor([], schema)
              server.transport.pull = async () => ({
                batches: [
                  {
                    cursor: 'accepted-key-child-revoked',
                    changes: [{ kind: 'remove', model: 'Child', id: '50' }],
                    relationSets: [],
                  },
                ],
                cursor: 'accepted-key-child-revoked',
                highWater: 'accepted-key-child-revoked',
                scanComplete: true,
                scope: document.scope,
              })
              const revokedBeforeReceipt = variant.name === 'unsafe-integer'
              if (revokedBeforeReceipt) await client.sync.pull()
              await client.sync.flush()
              assert.equal(await client.sync.status(ownerUpdate), 'accepted')
              assert.equal(await client.sync.status(ownerDeletion), status)
              for (const identifier of ['10', '20', '30', '40', '50']) {
                const stored = await client.storage.read((executor) =>
                  client.storage.findStored('Child', identifier, executor),
                )
                assert.equal(
                  stored?.canonical.owner_code,
                  identifier === '50' && revokedBeforeReceipt
                    ? variant.oldValue
                    : variant.newValue,
                  `${schema.fingerprint} canonical child ${identifier} follows accepted owner key`,
                )
                assert.equal(
                  stored?.visible,
                  identifier !== '50' || !revokedBeforeReceipt,
                )
              }
              const retained = await client.storage.read((executor) =>
                client.storage.findStored('Child', '10', executor),
              )
              assert.equal(retained?.deleted, deletion === 'cascade')
              assert.equal(
                retained?.attributes.owner_code,
                deletion === 'nullify' ? null : variant.newValue,
              )
              assert.equal(
                retained?.proposal.title,
                'Independent retained child title',
              )
              assert.equal(
                (await client.models.Child!.findOrFail('20')).attributes
                  .owner_code,
                variant.otherValue,
              )
              assert.equal(
                (await client.models.Child!.findOrFail('30')).attributes
                  .owner_code,
                null,
              )
              if (!revokedBeforeReceipt) await client.sync.pull()
              await client.close()
              client = await createSynloquent({
                ...configuration(filename, server.transport),
                schema,
              })
              assert.equal(await client.sync.status(ownerUpdate), 'accepted')
              assert.equal(await client.sync.status(ownerDeletion), status)
              assert.equal(
                (
                  await client.storage.read((executor) =>
                    client.storage.findStored('Child', '10', executor),
                  )
                )?.canonical.owner_code,
                variant.newValue,
              )
              await client.sync.resolveConflict(ownerDeletion, 'discard')
              const restored = await client.models.Child!.findOrFail('10')
              assert.equal(restored.attributes.owner_code, variant.newValue)
              assert.equal(
                restored.attributes.title,
                'Independent retained child title',
              )
              assert.equal(
                (await restored.relation('owner').get()).first()?.id,
                ownerIdentity,
              )
              assert.equal(
                (await client.models.Child!.findOrFail('20')).attributes
                  .owner_code,
                variant.otherValue,
              )
              assert.equal(
                (await client.models.Child!.findOrFail('30')).attributes
                  .owner_code,
                null,
              )
              assert.equal(await client.models.Child!.find('40'), null)
              assert.equal(await client.models.Child!.find('50'), null)
              assert.equal(await client.sync.status(ownerUpdate), 'accepted')
              assert.equal(await client.sync.status(ownerDeletion), 'cancelled')
              const entries = await client.storage.read((executor) =>
                client.storage.pending(executor),
              )
              assert.equal(
                entries.find(
                  (entry) => entry.operation.operationId === foreignOperation,
                )?.attempted?.values.owner_code,
                variant.otherValue,
              )
              assert.equal(
                entries.find(
                  (entry) => entry.operation.operationId === nullOperation,
                )?.attempted?.values.owner_code,
                null,
              )
              assert.equal(await client.sync.status(titleOperation), 'rejected')
              assert.equal(await client.sync.status(childDeletion), 'rejected')
              await client.sync.resolveConflict(childDeletion, 'discard')
              assert.equal(
                (await client.models.Child!.findOrFail('40')).attributes
                  .owner_code,
                variant.newValue,
              )
              assert.deepEqual(
                (
                  await client.storage.read((executor) =>
                    executor.execute('PRAGMA foreign_key_check'),
                  )
                ).rows,
                [],
              )
              await client.close()
              client = await createSynloquent({
                ...configuration(filename, server.transport),
                schema,
              })
              assert.equal(
                (await client.models.Child!.findOrFail('10')).attributes
                  .owner_code,
                variant.newValue,
              )
              assert.equal(
                (await client.models.Child!.findOrFail('10')).attributes.title,
                'Independent retained child title',
              )
              assert.equal(await client.models.Child!.find('50'), null)
              assert.equal(await client.sync.status(ownerUpdate), 'accepted')
            } finally {
              await client.close()
            }
          }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
