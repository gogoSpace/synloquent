import { quoteIdentifier } from './database.js'
import { resourceTable } from './compiler.js'
import { isErrorCode, SynloquentError } from './errors.js'
import {
  generatedFieldColumn,
  integerOrderColumn,
  type Storage,
} from './storage.js'
import type {
  Attributes,
  DigestLifecycle,
  Envelope,
  Operation,
  Session,
  Snapshot,
  Transport,
  WireValue,
} from './types.js'
import {
  assertManifest,
  canonicalJson,
  validateValue,
  validateAttributes,
} from './values.js'
import { verifySnapshotContent, snapshotPhase } from './snapshot-content.js'
import {
  discardSnapshotParts,
  installSnapshotParts,
  loadSnapshotPartsDescriptor,
} from './snapshot-transfer.js'

export class SyncEngine {
  private running: Promise<void> | undefined
  private paused = false
  private failures = 0
  private nextAttemptAt = 0
  private snapshotRequest = 0
  constructor(
    readonly storage: Storage,
    private readonly transport?: Transport,
  ) {}
  envelope<Payload>(kind: string, payload: Payload): Envelope<Payload> {
    return {
      protocolVersion: 1,
      requestId: this.storage.configuration.generateIdentity(),
      kind,
      schemaFingerprint: this.storage.manifest.fingerprint,
      session: { ...this.storage.session },
      payload,
    }
  }
  private sessionToken(): string {
    return (
      canonicalJson(this.storage.session) +
      String(this.storage.owner.generation)
    )
  }
  private verifySession(token: string): void {
    if (token !== this.sessionToken())
      throw new SynloquentError(
        'session_changed',
        'Response belongs to an inactive account or database generation.',
      )
  }
  flush(): Promise<void> {
    if (!this.running)
      this.running = this.flushPending().finally(() => {
        this.running = undefined
      })
    return this.running
  }
  private async flushPending(): Promise<void> {
    if (!this.transport)
      throw new SynloquentError(
        'unsupported_query',
        'No synchronization transport is configured.',
      )
    if (this.paused)
      throw new SynloquentError(
        'forbidden_operation',
        'Synchronization is paused until authentication is restored.',
      )
    if (Date.parse(this.storage.configuration.now()) < this.nextAttemptAt)
      return
    const token = this.sessionToken()
    while (true) {
      const operations = await this.storage.write(async (executor) => {
        const entries = await this.storage.pending(executor)
        const accepted = new Set(
          entries
            .filter((entry) => entry.status === 'accepted')
            .map((entry) => entry.operation.operationId),
        )
        const selected: Operation[] = []
        const selectedIdentities = new Set<string>()
        for (const entry of entries) {
          if (
            entry.status !== 'pending' ||
            selectedIdentities.has(entry.operation.operationId)
          )
            continue
          const group = entry.operation.atomicGroup
            ? entries.filter(
                (candidate) =>
                  candidate.operation.atomicGroup ===
                    entry.operation.atomicGroup &&
                  candidate.status !== 'accepted',
              )
            : [entry]
          if (group.some((candidate) => candidate.status !== 'pending'))
            continue
          if (group.length > 100)
            throw new SynloquentError(
              'validation_failed',
              'Atomic groups exceed the bounded wire batch.',
            )
          if (selected.length + group.length > 100) break
          const groupIdentities = new Set(
            group.map((candidate) => candidate.operation.operationId),
          )
          if (
            !group.every((candidate) =>
              candidate.operation.dependsOn.every(
                (identity) =>
                  accepted.has(identity) ||
                  selectedIdentities.has(identity) ||
                  groupIdentities.has(identity),
              ),
            )
          )
            continue
          if (
            !entry.operation.atomicGroup &&
            selected.some(
              (operation) =>
                operation.model === entry.operation.model &&
                operation.localIdentity === entry.operation.localIdentity,
            )
          )
            continue
          for (const candidate of group) {
            let operation = candidate.attempted ?? candidate.operation
            if (!candidate.attempted) {
              const current = await this.storage.findStored(
                operation.model,
                operation.localIdentity,
                executor,
              )
              if (operation.action !== 'create' && current?.serverIdentity) {
                operation = { ...operation, id: current.serverIdentity }
                if (
                  operation.dependsOn.some((dependency) =>
                    accepted.has(dependency),
                  ) &&
                  current.revision
                )
                  operation = {
                    ...operation,
                    expectedRevision: current.revision,
                  }
              }
            }
            selected.push(operation)
            selectedIdentities.add(operation.operationId)
            await executor.execute(
              "UPDATE syn_outbox SET attempted = COALESCE(attempted, ?), attempts = attempts + 1, status = 'sending', generation = ? WHERE partition = ? AND operation_id = ?",
              [
                canonicalJson(operation),
                this.storage.session.generation,
                this.storage.partition,
                operation.operationId,
              ],
            )
          }
        }
        return selected
      })
      if (!operations.length) return
      try {
        const response = await this.transport.push(
          this.envelope('push', { operations }),
        )
        this.verifySession(token)
        if (!response || !Array.isArray(response.receipts))
          throw new SynloquentError(
            'schema_mismatch',
            'Malformed push response.',
          )
        const identities = new Set(
          operations.map((operation) => operation.operationId),
        )
        const received = new Set<string>()
        await this.storage.write(async (executor, changed) => {
          this.verifySession(token)
          for (const receipt of response.receipts) {
            if (
              !identities.has(receipt.operationId) ||
              received.has(receipt.operationId)
            )
              throw new SynloquentError(
                'schema_mismatch',
                'Response acknowledges an unexpected or duplicated operation.',
              )
            const operation = operations.find(
              (operation) => operation.operationId === receipt.operationId,
            )!
            if (
              receipt.localIdentity !== operation.localIdentity ||
              !['accepted', 'conflicted', 'rejected'].includes(receipt.status)
            )
              throw new SynloquentError(
                'schema_mismatch',
                'Receipt identity or state does not match its attempted operation.',
              )
            received.add(receipt.operationId)
            await executor.execute(
              'UPDATE syn_outbox SET status = ?, error = ? WHERE partition = ? AND operation_id = ? AND generation = ?',
              [
                receipt.status,
                receipt.error ? canonicalJson(receipt.error) : null,
                this.storage.partition,
                receipt.operationId,
                this.storage.session.generation,
              ],
            )
            if (receipt.canonical) {
              if (
                receipt.canonical.model !== operation.model ||
                (operation.id && receipt.canonical.id !== operation.id)
              )
                throw new SynloquentError(
                  'schema_mismatch',
                  'Receipt canonical identity does not match its operation.',
                )
              const previous = await this.storage.findStored(
                operation.model,
                operation.localIdentity,
                executor,
              )
              const canonical =
                receipt.status === 'accepted' &&
                previous?.serverIdentity === receipt.canonical.id &&
                previous.revision &&
                previous.revision !== operation.expectedRevision &&
                previous.revision !== receipt.canonical.revision
                  ? {
                      ...receipt.canonical,
                      revision: previous.revision,
                      attributes: previous.canonical,
                    }
                  : receipt.canonical
              await this.storage.ingest(
                canonical,
                executor,
                changed,
                operation.localIdentity,
              )
            }
            for (const set of receipt.relationSets ?? [])
              await this.storage.ingestRelationSet(set, executor, changed)
            const current = await this.storage.findStored(
              operation.model,
              operation.localIdentity,
              executor,
            )
            if (current && receipt.status !== 'accepted')
              await this.storage.persist(
                {
                  ...current,
                  state:
                    receipt.status === 'conflicted' ? 'conflicted' : 'rejected',
                },
                executor,
                changed,
              )
            if (
              receipt.status === 'accepted' &&
              ['delete', 'forceDelete'].includes(operation.action) &&
              !receipt.canonical
            )
              await this.storage.remove(
                operation.model,
                operation.localIdentity,
                'delete',
                executor,
                changed,
              )
            changed.add(operation.model)
          }
          await this.storage.applyPendingDeleteEffects(executor, changed)
          await this.storage.rebuildRelationOverlays(executor, changed)
          for (const operation of operations)
            if (!received.has(operation.operationId))
              await executor.execute(
                "UPDATE syn_outbox SET status = 'pending' WHERE partition = ? AND operation_id = ?",
                [this.storage.partition, operation.operationId],
              )
        })
        this.failures = 0
        this.nextAttemptAt = 0
        if (received.size !== operations.length) return
      } catch (error) {
        if (token !== this.sessionToken())
          throw new SynloquentError(
            'session_changed',
            'Synchronization response arrived after a session change.',
          )
        await this.storage.write(async (executor) => {
          for (const operation of operations)
            await executor.execute(
              "UPDATE syn_outbox SET status = 'pending' WHERE partition = ? AND operation_id = ? AND status = 'sending'",
              [this.storage.partition, operation.operationId],
            )
        })
        const failure = error as {
          status?: number
          retryAfterMilliseconds?: number
        }
        if (failure.status === 401 || failure.status === 403) this.paused = true
        this.failures += 1
        const retry =
          failure.status === 429 && failure.retryAfterMilliseconds !== undefined
            ? failure.retryAfterMilliseconds
            : Math.min(60000, 1000 * 2 ** Math.min(this.failures - 1, 6))
        this.nextAttemptAt =
          Date.parse(this.storage.configuration.now()) + retry
        throw error
      }
    }
  }
  async atomicGroup(
    groupId: string,
    operations: readonly Operation[],
  ): Promise<void> {
    if (!groupId || !operations.length || operations.length > 100)
      throw new SynloquentError(
        'validation_failed',
        'A remote atomic group needs an identity and one to one hundred operations.',
      )
    const entities = new Set<string>()
    for (const operation of operations) {
      const entity = `${operation.model}:${operation.localIdentity}`
      if (entities.has(entity))
        throw new SynloquentError(
          'validation_failed',
          'V1 atomic groups allow one operation for each entity. Split multiple entity edits into one patch.',
        )
      entities.add(entity)
    }
    const remaining = new Map(
      operations.map((operation) => [operation.operationId, operation]),
    )
    if (remaining.size !== operations.length)
      throw new SynloquentError(
        'idempotency_mismatch',
        'Atomic groups cannot repeat an operation identity.',
      )
    const ordered: Operation[] = []
    while (remaining.size) {
      const ready = [...remaining.values()].filter((operation) =>
        operation.dependsOn.every((dependency) => !remaining.has(dependency)),
      )
      if (!ready.length)
        throw new SynloquentError(
          'validation_failed',
          'Atomic operation dependencies contain a cycle.',
        )
      for (const operation of ready) {
        ordered.push(operation)
        remaining.delete(operation.operationId)
      }
    }
    await this.storage.write(async (executor, changed) => {
      for (const input of ordered) {
        const definition = this.storage.manifest.models[input.model]
        if (!definition || !definition.operations.includes(input.action))
          throw new SynloquentError(
            'forbidden_operation',
            'Atomic operation targets an undeclared model or action.',
          )
        if (input.id !== undefined)
          validateValue(
            definition.primaryKey,
            definition.fields[definition.primaryKey]!,
            input.id,
          )
        const operation: Operation = { ...input, atomicGroup: groupId }
        const known = (await this.storage.pending(executor)).find(
          (entry) => entry.operation.operationId === operation.operationId,
        )
        if (known) {
          if (canonicalJson(known.operation) !== canonicalJson(operation))
            throw new SynloquentError(
              'idempotency_mismatch',
              'Atomic operation identity has another immutable intent.',
            )
          continue
        }
        const current = await this.storage.findStored(
          operation.model,
          operation.localIdentity,
          executor,
        )
        if (
          operation.action !== 'create' &&
          (!current?.visible || current.deleted)
        )
          throw new SynloquentError(
            'not_found',
            'Atomic operation target is absent or inaccessible.',
          )
        if (operation.action === 'create' || operation.action === 'update') {
          const attributes: Attributes = {}
          for (const [field, value] of Object.entries(operation.values)) {
            if (
              value &&
              typeof value === 'object' &&
              '$ref' in value &&
              value.$ref &&
              typeof value.$ref === 'object' &&
              'localIdentity' in value.$ref
            )
              attributes[field] = String(value.$ref.localIdentity)
            else attributes[field] = value as WireValue
          }
          validateAttributes(definition, attributes, true)
          await this.storage.persist(
            {
              model: operation.model,
              localIdentity: operation.localIdentity,
              serverIdentity: current?.serverIdentity ?? null,
              revision: current?.revision ?? null,
              canonical: current?.canonical ?? {},
              proposal: { ...(current?.proposal ?? {}), ...attributes },
              attributes: {
                ...(current?.canonical ?? {}),
                ...(current?.proposal ?? {}),
                ...attributes,
              },
              visible: true,
              deleted: false,
              state: 'pending',
            },
            executor,
            changed,
          )
        } else if (
          operation.action === 'delete' ||
          operation.action === 'forceDelete'
        ) {
          if (current) {
            await this.storage.deleteDependencies(
              operation.model,
              operation.localIdentity,
              executor,
              changed,
              'local',
            )
            await this.storage.persist(
              {
                ...current,
                visible: current.visible,
                deleted: true,
                state: 'pending',
              },
              executor,
              changed,
            )
          }
        } else if (operation.action === 'pivot') {
          const relation =
            definition.relations[String(operation.values.relation)]
          if (!relation?.pivot)
            throw new SynloquentError(
              'unknown_relation',
              'Atomic pivot relation is undeclared.',
            )
          changed.add(`pivot:${relation.pivot.table}`)
        } else
          throw new SynloquentError(
            'unsupported_query',
            'V1 remote atomic groups support declarative create/update/delete/pivot operations.',
          )
        await this.storage.append(operation, executor)
        changed.add(operation.model)
      }
      await this.storage.applyPendingDeleteEffects(executor, changed)
      await this.storage.rebuildRelationOverlays(executor, changed)
    })
  }
  resumeAuthentication(): void {
    this.paused = false
    this.nextAttemptAt = 0
  }
  async pull(dataset = 'default'): Promise<void> {
    if (!this.transport)
      throw new SynloquentError(
        'unsupported_query',
        'No synchronization transport is configured.',
      )
    const token = this.sessionToken()
    const cursor = await this.storage.metadata(`cursor:${dataset}`)
    let response
    try {
      response = await this.transport.pull(
        this.envelope('pull', { cursor, dataset }),
      )
    } catch (error) {
      if ((error as { code?: string }).code === 'cursor_expired') {
        await this.resnapshot(dataset)
        return
      }
      throw error
    }
    this.verifySession(token)
    if (
      !response ||
      !Array.isArray(response.batches) ||
      response.scope.dataset !== dataset ||
      response.scope.schemaFingerprint !== this.storage.manifest.fingerprint
    )
      throw new SynloquentError(
        'schema_mismatch',
        'Pull scope does not match the active schema and dataset.',
      )
    await this.storage.owner.replace(async (executor, changed) => {
      this.verifySession(token)
      const scope = await this.storage.metadata('scope', executor)
      if (
        scope &&
        (JSON.parse(scope) as { authorizationGeneration?: string })
          .authorizationGeneration !== response.scope.authorizationGeneration
      ) {
        for (const model of Object.keys(this.storage.manifest.models))
          await executor.execute(
            `UPDATE ${quoteIdentifier(resourceTable(model))} SET _visible = 0 WHERE _partition = ?`,
            [this.storage.partition],
          )
      }
      for (const batch of response.batches) {
        for (const change of batch.changes) {
          if (change.kind === 'upsert') {
            if (
              !change.record ||
              change.record.model !== change.model ||
              change.record.id !== change.id
            )
              throw new SynloquentError(
                'schema_mismatch',
                'Malformed upsert change.',
              )
            await this.storage.ingest(change.record, executor, changed)
          } else if (change.kind === 'delete' || change.kind === 'remove')
            await this.storage.remove(
              change.model,
              change.id,
              change.kind,
              executor,
              changed,
            )
          else
            throw new SynloquentError('schema_mismatch', 'Unknown pull change.')
        }
        for (const set of batch.relationSets)
          await this.storage.ingestRelationSet(set, executor, changed)
      }
      await this.storage.applyPendingDeleteEffects(executor, changed)
      await this.storage.rebuildRelationOverlays(executor, changed)
      await this.storage.setMetadata(
        `cursor:${dataset}`,
        response.cursor,
        executor,
      )
      await this.storage.setMetadata(
        'scope',
        canonicalJson(response.scope),
        executor,
      )
      changed.add('*')
    })
  }
  async resnapshot(dataset = 'default'): Promise<void> {
    if (!this.transport)
      throw new SynloquentError(
        'unsupported_query',
        'No snapshot transport is configured.',
      )
    const token = this.sessionToken()
    const request = ++this.snapshotRequest
    const assertCurrent = (): void => {
      this.verifySession(token)
      if (request !== this.snapshotRequest)
        throw new SynloquentError(
          'session_changed',
          'Snapshot request was replaced.',
        )
    }
    if (
      this.transport.snapshotParts ||
      this.transport.snapshotPartBatch ||
      this.transport.confirmSnapshotParts
    ) {
      if (
        !this.transport.snapshotParts ||
        !this.transport.snapshotPartBatch ||
        !this.transport.confirmSnapshotParts
      )
        throw new SynloquentError(
          'snapshot_admission_required',
          'Bounded snapshot transport is incomplete.',
          { reason: 'unsupported-host-contract' },
        )
      const descriptor =
        (await loadSnapshotPartsDescriptor(this.storage, dataset)) ??
        (await this.storage.owner.verifyDigest(async (lifecycle) => {
          assertCurrent()
          await this.storage.configuration.refreshMemoryBudget?.()
          if (!this.storage.snapshotWorkBudget().maximumSnapshotConcurrency)
            throw new SynloquentError(
              'snapshot_admission_required',
              'Snapshot preparation is deferred by current memory pressure.',
              { reason: 'memory-pressure' },
            )
          const prepared = await this.transport!.snapshotParts!(
            this.envelope('snapshot', { dataset }),
            lifecycle,
          )
          assertCurrent()
          if (lifecycle.cancelled)
            throw new SynloquentError(
              'session_changed',
              'Snapshot preparation was cancelled.',
            )
          return prepared
        }))
      if (descriptor.dataset !== dataset)
        throw new SynloquentError(
          'snapshot_invalid',
          'Snapshot descriptor belongs to a different requested dataset.',
        )
      assertCurrent()
      try {
        await installSnapshotParts(
          this.storage,
          this.transport,
          descriptor,
          (kind, payload) => this.envelope(kind, payload),
          assertCurrent,
        )
      } catch (failure) {
        if (
          failure instanceof SynloquentError &&
          [
            'snapshot_invalid',
            'invalid_snapshot',
            'forbidden_operation',
            'authentication_required',
            'cursor_expired',
            'schema_mismatch',
          ].includes(failure.code)
        ) {
          try {
            await discardSnapshotParts(this.storage, descriptor)
          } catch {
            /* Preserve the original failure if lifecycle cleanup has closed the owner. */
          }
        }
        throw failure
      }
      return
    }
    const snapshot = await this.transport.snapshot(
      this.envelope('snapshot', { dataset }),
    )
    assertCurrent()
    await this.installSnapshot(snapshot)
  }
  async installSnapshot(snapshot: Snapshot): Promise<void> {
    const token = this.sessionToken()
    snapshotPhase(this.storage.configuration, 'validation', 'begin')
    try {
      this.assertSnapshotIdentity(snapshot, this.storage.manifest.fingerprint)
    } finally {
      snapshotPhase(this.storage.configuration, 'validation', 'end')
    }
    const digest = await this.verifySnapshot(snapshot)
    this.assertDigestCurrent(digest)
    this.verifySession(token)
    let committing = false
    try {
      await this.storage.owner.replace(async (executor, changed) => {
        this.assertDigestCurrent(digest)
        this.verifySession(token)
        snapshotPhase(this.storage.configuration, 'staging', 'begin')
        await this.storage.stageSnapshotRecords(snapshot.records, executor)
        await this.storage.clearCanonicalRelations(executor, changed)
        snapshotPhase(this.storage.configuration, 'records', 'begin')
        try {
          await this.storage.ingestSnapshotRecords(
            snapshot.records,
            executor,
            changed,
          )
        } finally {
          snapshotPhase(this.storage.configuration, 'records', 'end')
        }
        snapshotPhase(this.storage.configuration, 'relationSets', 'begin')
        try {
          await this.storage.ingestSnapshotRelationSets(
            snapshot.relationSets,
            executor,
            changed,
          )
        } finally {
          snapshotPhase(this.storage.configuration, 'relationSets', 'end')
        }
        for (const entry of await this.storage.pending(executor))
          if (
            ['pending', 'sending', 'conflicted', 'rejected'].includes(
              entry.status,
            )
          ) {
            const record = await this.storage.findStored(
              entry.operation.model,
              entry.operation.localIdentity,
              executor,
            )
            if (record?.serverIdentity === null)
              await this.storage.persist(
                { ...record, visible: true },
                executor,
                changed,
              )
            else if (
              record &&
              !record.visible &&
              Object.keys(record.proposal).length
            )
              await executor.execute(
                'INSERT OR REPLACE INTO syn_recovery(partition,model,local_identity,proposal,reason) VALUES (?,?,?,?,?)',
                [
                  this.storage.partition,
                  record.model,
                  record.localIdentity,
                  canonicalJson(record.proposal),
                  'snapshot_scope_removed',
                ],
              )
          }
        await this.storage.applyPendingDeleteEffects(executor, changed)
        await this.storage.rebuildRelationOverlays(executor, changed)
        snapshotPhase(this.storage.configuration, 'integrity', 'begin')
        try {
          const integrity = await executor.execute('PRAGMA integrity_check')
          if (integrity.rows.some((row) => !Object.values(row).includes('ok')))
            throw new SynloquentError(
              'snapshot_invalid',
              'SQLite integrity check failed.',
            )
          const foreignKeys = await executor.execute('PRAGMA foreign_key_check')
          if (foreignKeys.rows.length)
            throw new SynloquentError(
              'snapshot_invalid',
              'SQLite foreign key validation failed.',
            )
        } finally {
          snapshotPhase(this.storage.configuration, 'integrity', 'end')
        }
        await this.storage.setMetadata(
          `cursor:${snapshot.dataset}`,
          snapshot.cursor,
          executor,
        )
        await this.storage.setMetadata(
          'scope',
          canonicalJson(snapshot.scope),
          executor,
        )
        await this.storage.setMetadata(
          'snapshotGeneration',
          snapshot.generation,
          executor,
        )
        changed.add('*')
        snapshotPhase(this.storage.configuration, 'staging', 'end')
        committing = true
        snapshotPhase(this.storage.configuration, 'commit', 'begin')
      })
    } finally {
      if (committing) snapshotPhase(this.storage.configuration, 'commit', 'end')
    }
  }
  private assertSnapshotIdentity(
    snapshot: Snapshot,
    fingerprint: string,
    dataset?: string,
  ): void {
    if (
      !snapshot ||
      !snapshot.scope ||
      snapshot.schemaFingerprint !== fingerprint ||
      snapshot.scope.schemaFingerprint !== fingerprint ||
      snapshot.dataset !== snapshot.scope.dataset ||
      (dataset !== undefined && snapshot.dataset !== dataset) ||
      !snapshot.generation ||
      !snapshot.cursor ||
      !snapshot.scope.authorizationGeneration ||
      !snapshot.scope.projectionGeneration ||
      !['complete', 'partial'].includes(snapshot.scope.completeness ?? '') ||
      !Array.isArray(snapshot.records) ||
      !Array.isArray(snapshot.relationSets)
    )
      throw new SynloquentError(
        'snapshot_invalid',
        'Snapshot schema, dataset, generation or scope identity is invalid.',
      )
  }
  async updateManifest(dataset?: string): Promise<boolean> {
    if (!this.transport) return false
    const token = this.sessionToken()
    const manifest = assertManifest(
      await this.transport.manifest(this.envelope('manifest', {})),
    )
    this.verifySession(token)
    if (manifest.fingerprint === this.storage.manifest.fingerprint) return false
    for (const [model, previous] of Object.entries(
      this.storage.manifest.models,
    )) {
      const next = manifest.models[model]
      if (
        !next ||
        next.primaryKey !== previous.primaryKey ||
        next.resource !== previous.resource
      )
        throw new SynloquentError(
          'upgrade_required',
          'The online schema removes or changes an existing resource identity.',
        )
      for (const [field, previousField] of Object.entries(previous.fields)) {
        const nextField = next.fields[field]
        if (
          !nextField ||
          nextField.type !== previousField.type ||
          nextField.precision !== previousField.precision ||
          (previousField.nullable && !nextField.nullable) ||
          (previousField.readable && !nextField.readable) ||
          (previousField.writable && !nextField.writable) ||
          previousField.enum?.some((value) => !nextField.enum?.includes(value))
        )
          throw new SynloquentError(
            'upgrade_required',
            `Breaking online field change ${model}.${field}.`,
          )
      }
    }
    const current = this.storage.manifest
    const datasetScope = await this.storage.metadata('scope')
    const requestedDataset =
      dataset ??
      (datasetScope
        ? String(
            (JSON.parse(datasetScope) as { dataset?: string }).dataset ??
              'default',
          )
        : 'default')
    const snapshot = await this.transport.snapshot({
      ...this.envelope('snapshot', { dataset: requestedDataset }),
      schemaFingerprint: manifest.fingerprint,
    })
    this.assertSnapshotIdentity(
      snapshot,
      manifest.fingerprint,
      requestedDataset,
    )
    const digest = await this.verifySnapshot(snapshot)
    this.assertDigestCurrent(digest)
    this.verifySession(token)
    await this.storage.owner.replace(async (executor, changed) => {
      this.assertDigestCurrent(digest)
      this.verifySession(token)
      try {
        for (const [model, next] of Object.entries(manifest.models)) {
          const previous = current.models[model]
          if (previous)
            for (const [field, definition] of Object.entries(next.fields))
              if (!previous.fields[field]) {
                await executor.execute(
                  `ALTER TABLE ${quoteIdentifier(resourceTable(model))} ADD COLUMN ${generatedFieldColumn(field, definition, next)}`,
                )
                if (
                  definition.type === 'decimal' ||
                  definition.type === 'integer'
                )
                  await executor.execute(
                    `ALTER TABLE ${quoteIdentifier(resourceTable(model))} ADD COLUMN ${definition.type === 'integer' ? integerOrderColumn(field) : `${quoteIdentifier(`_order_${field}`)} TEXT`}`,
                  )
              }
        }
        await this.storage.createSchema(executor, manifest)
        this.storage.manifest = manifest
        await this.storage.stageSnapshotRecords(snapshot.records, executor)
        await this.storage.clearCanonicalRelations(executor, changed)
        await this.storage.ingestSnapshotRecords(
          snapshot.records,
          executor,
          changed,
        )
        await this.storage.ingestSnapshotRelationSets(
          snapshot.relationSets,
          executor,
          changed,
        )
        for (const entry of await this.storage.pending(executor))
          if (
            ['pending', 'sending', 'conflicted', 'rejected'].includes(
              entry.status,
            )
          ) {
            const record = await this.storage.findStored(
              entry.operation.model,
              entry.operation.localIdentity,
              executor,
            )
            if (record?.serverIdentity === null)
              await this.storage.persist(
                { ...record, visible: true },
                executor,
                changed,
              )
          }
        await this.storage.applyPendingDeleteEffects(executor, changed)
        await this.storage.rebuildRelationOverlays(executor, changed)
        await this.storage.setMetadata(
          'manifest',
          canonicalJson(manifest),
          executor,
        )
        await this.storage.setMetadata(
          `cursor:${requestedDataset}`,
          snapshot.cursor,
          executor,
        )
        await this.storage.setMetadata(
          'scope',
          canonicalJson(snapshot.scope),
          executor,
        )
        changed.add('*')
      } catch (error) {
        this.storage.manifest = current
        throw error
      }
    })
    return true
  }
  private verifySnapshot(snapshot: Snapshot): Promise<DigestLifecycle> {
    return this.storage.owner.verifyDigest(async (lifecycle) => {
      await verifySnapshotContent(
        snapshot,
        this.storage.configuration,
        lifecycle,
      )
      return lifecycle
    })
  }
  private assertDigestCurrent(lifecycle: DigestLifecycle): void {
    if (lifecycle.cancelled)
      throw new SynloquentError(
        'session_changed',
        'Snapshot verification belongs to a replaced lifecycle.',
      )
  }
  async cancel(operationId: string): Promise<void> {
    await this.storage.write(async (executor, changed) => {
      const entries = await this.storage.pending(executor)
      const entry = entries.find(
        (entry) => entry.operation.operationId === operationId,
      )
      if (!entry) throw new SynloquentError('not_found', 'Unknown operation.')
      if (entry.attempted)
        throw new SynloquentError(
          'operation_attempted',
          'An attempted operation cannot be cancelled as though its server write were undone.',
        )
      if (
        entries.some(
          (candidate) =>
            ['pending', 'sending', 'conflicted', 'rejected'].includes(
              candidate.status,
            ) && candidate.operation.dependsOn.includes(operationId),
        )
      )
        throw new SynloquentError(
          'forbidden_operation',
          'Cancel dependent operations before their prerequisite.',
        )
      await executor.execute(
        "UPDATE syn_outbox SET status = 'cancelled' WHERE partition = ? AND operation_id = ?",
        [this.storage.partition, operationId],
      )
      const current = await this.storage.findStored(
        entry.operation.model,
        entry.operation.localIdentity,
        executor,
      )
      if (entry.operation.action === 'pivot') {
        const relation =
          this.storage.manifest.models[entry.operation.model]?.relations[
            String(entry.operation.values.relation)
          ]
        if (relation?.pivot) changed.add(`pivot:${relation.pivot.table}`)
      }
      if (current) {
        const remaining = (await this.storage.pending(executor)).filter(
          (candidate) =>
            candidate.operation.model === current.model &&
            candidate.operation.localIdentity === current.localIdentity &&
            ['pending', 'sending', 'conflicted', 'rejected'].includes(
              candidate.status,
            ),
        )
        const proposal = await this.storage.rebuildProposal(
          current.model,
          current.localIdentity,
          current.canonical,
          executor,
        )
        const lifecycle = remaining
          .filter((candidate) =>
            ['delete', 'restore', 'forceDelete'].includes(
              candidate.operation.action,
            ),
          )
          .at(-1)?.operation.action
        const softField =
          this.storage.manifest.models[current.model]?.softDeletes
        const hardDeleted =
          lifecycle === 'forceDelete' || (lifecycle === 'delete' && !softField)
        await this.storage.persist(
          {
            ...current,
            proposal,
            state: remaining.some((entry) => entry.status === 'conflicted')
              ? 'conflicted'
              : remaining.some((entry) => entry.status === 'rejected')
                ? 'rejected'
                : remaining.length
                  ? 'pending'
                  : 'synced',
            visible:
              current.serverIdentity === null
                ? remaining.length > 0
                : current.visible,
            deleted: hardDeleted,
          },
          executor,
          changed,
        )
        changed.add(current.model)
        await this.storage.rebuildDeleteEffects(
          current.model,
          current.localIdentity,
          executor,
          changed,
        )
      }
      await this.storage.rebuildRelationOverlays(executor, changed)
    })
  }
  async resolveConflict(
    operationId: string,
    strategy: 'discard' | 'retry',
    values?: Attributes,
  ): Promise<void> {
    await this.storage.write(async (executor, changed) => {
      const entry = (await this.storage.pending(executor)).find(
        (entry) => entry.operation.operationId === operationId,
      )
      if (!entry || !['conflicted', 'rejected'].includes(entry.status))
        throw new SynloquentError(
          'conflict',
          'Operation is not a retained conflict or rejection.',
        )
      const current = await this.storage.findStored(
        entry.operation.model,
        entry.operation.localIdentity,
        executor,
      )
      if (!current?.visible)
        throw new SynloquentError(
          'forbidden_operation',
          'Revoked proposals are available only in restricted recovery records.',
        )
      await executor.execute(
        "UPDATE syn_outbox SET status = 'cancelled' WHERE partition = ? AND operation_id = ?",
        [this.storage.partition, operationId],
      )
      if (strategy === 'retry') {
        const mutationValues =
          entry.operation.action === 'increment' ||
          entry.operation.action === 'pivot'
            ? entry.operation.values
            : (values ?? current.proposal)
        await this.storage.append(
          {
            ...entry.operation,
            operationId: this.storage.configuration.generateIdentity(),
            values: mutationValues,
            dependsOn: [],
            ...(current.revision ? { expectedRevision: current.revision } : {}),
          },
          executor,
        )
      }
      const remaining = (await this.storage.pending(executor)).filter(
        (candidate) =>
          candidate.operation.model === current.model &&
          candidate.operation.localIdentity === current.localIdentity &&
          ['pending', 'sending', 'conflicted', 'rejected'].includes(
            candidate.status,
          ),
      )
      const proposal = await this.storage.rebuildProposal(
        current.model,
        current.localIdentity,
        current.canonical,
        executor,
        current.proposal,
      )
      const lifecycle = remaining
        .filter((candidate) =>
          ['delete', 'restore', 'forceDelete'].includes(
            candidate.operation.action,
          ),
        )
        .at(-1)?.operation.action
      const softField = this.storage.manifest.models[current.model]?.softDeletes
      const hardDeleted =
        lifecycle === 'forceDelete' || (lifecycle === 'delete' && !softField)
      await this.storage.persist(
        {
          ...current,
          proposal,
          state: remaining.some(
            (candidate) => candidate.status === 'conflicted',
          )
            ? 'conflicted'
            : remaining.some((candidate) => candidate.status === 'rejected')
              ? 'rejected'
              : remaining.length
                ? 'pending'
                : 'synced',
          visible:
            current.serverIdentity === null
              ? remaining.length > 0
              : current.visible,
          deleted: hardDeleted,
        },
        executor,
        changed,
      )
      changed.add(current.model)
      await this.storage.rebuildDeleteEffects(
        current.model,
        current.localIdentity,
        executor,
        changed,
      )
      await this.storage.rebuildRelationOverlays(executor, changed)
    })
  }
  async status(operationId: string): Promise<string> {
    return this.storage.read(
      async (executor) =>
        (await this.storage.pending(executor)).find(
          (entry) => entry.operation.operationId === operationId,
        )?.status ?? 'unknown',
    )
  }
  async confirmed(
    operationId: string,
    timeoutMilliseconds = 30000,
  ): Promise<void> {
    await this.flush()
    const initial = await this.status(operationId)
    if (initial === 'accepted') return
    if (initial === 'conflicted' || initial === 'rejected')
      throw await this.confirmationFailure(operationId, initial)
    if (initial === 'unknown' || initial === 'cancelled')
      throw new SynloquentError(
        'not_found',
        'Operation has no pending confirmation.',
        { operationId, status: initial },
      )
    if (!this.storage.configuration.schedule)
      throw new SynloquentError(
        'confirmation_timeout',
        'Confirmation remains uncertain. The operation may already exist on the server.',
      )
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timeout = (): void => {}
      let unsubscribe = (): void => {}
      const check = (): void => {
        void this.status(operationId).then(
          (state) => {
            if (settled) return
            if (
              state === 'accepted' ||
              state === 'conflicted' ||
              state === 'rejected'
            ) {
              settled = true
              timeout()
              unsubscribe()
              if (state === 'accepted') resolve()
              else
                void this.confirmationFailure(operationId, state).then(
                  reject,
                  reject,
                )
            }
          },
          (error: unknown) => {
            if (!settled) {
              settled = true
              timeout()
              unsubscribe()
              reject(error)
            }
          },
        )
      }
      unsubscribe = this.storage.owner.subscribe(check)
      timeout = this.storage.configuration.schedule!(() => {
        if (!settled) {
          settled = true
          unsubscribe()
          reject(
            new SynloquentError(
              'confirmation_timeout',
              'Confirmation timed out. This does not prove that the server operation did not occur.',
            ),
          )
        }
      }, timeoutMilliseconds)
      check()
    })
  }
  private async confirmationFailure(
    operationId: string,
    state: 'conflicted' | 'rejected',
  ): Promise<SynloquentError> {
    const entry = await this.storage.read(async (executor) =>
      (await this.storage.pending(executor)).find(
        (candidate) => candidate.operation.operationId === operationId,
      ),
    )
    const failure = entry?.error
    return new SynloquentError(
      isErrorCode(failure?.code)
        ? failure.code
        : state === 'conflicted'
          ? 'conflict'
          : 'validation_failed',
      typeof failure?.message === 'string'
        ? failure.message
        : `Operation ${state}.`,
      { operationId, status: state, receiptError: failure ?? null },
    )
  }
  async setSession(session: Session): Promise<void> {
    await this.storage.owner.replace(async (executor, changed) => {
      this.storage.session = {
        ...session,
        generation: Math.max(
          session.generation,
          this.storage.session.generation + 1,
        ),
      }
      await this.storage.selectPartition(executor)
      await executor.execute(
        "UPDATE syn_outbox SET status = 'pending' WHERE partition = ? AND status = 'sending'",
        [this.storage.partition],
      )
      await this.storage.setMetadata(
        'sessionGeneration',
        String(this.storage.session.generation),
        executor,
      )
      changed.add('*')
    })
    this.storage.memoryCache.clear()
    this.paused = false
    this.failures = 0
    this.nextAttemptAt = 0
  }
  async command<Result extends WireValue>(
    name: string,
    arguments_: Attributes,
    operationId: string,
  ): Promise<Result> {
    if (!this.transport)
      throw new SynloquentError(
        'unsupported_query',
        'No command transport is configured.',
      )
    const definition = this.storage.manifest.commands?.[name]
    if (!definition)
      throw new SynloquentError(
        'forbidden_operation',
        `Command ${name} is not registered.`,
      )
    for (const [field, value] of Object.entries(arguments_)) {
      const fieldDefinition = definition.arguments[field]
      if (!fieldDefinition)
        throw new SynloquentError(
          'unknown_field',
          `Unknown command argument ${field}.`,
        )
      validateValue(field, fieldDefinition, value)
    }
    for (const [field, fieldDefinition] of Object.entries(definition.arguments))
      if (
        !(field in arguments_) &&
        !fieldDefinition.nullable &&
        fieldDefinition.default === undefined
      )
        throw new SynloquentError(
          'validation_failed',
          `Missing command argument ${field}.`,
        )
    const token = this.sessionToken()
    const payload = { name, operationId, arguments: arguments_ }
    const cached = await this.storage.write(async (executor) => {
      const result = await executor.execute(
        'SELECT * FROM syn_commands WHERE partition = ? AND operation_id = ?',
        [this.storage.partition, operationId],
      )
      if (result.rows[0]) {
        if (result.rows[0].payload !== canonicalJson(payload))
          throw new SynloquentError(
            'idempotency_mismatch',
            'Command identity was reused with a different payload.',
          )
        return typeof result.rows[0].result === 'string'
          ? (JSON.parse(result.rows[0].result) as Result)
          : undefined
      }
      await executor.execute(
        "INSERT INTO syn_commands(partition,operation_id,payload,status) VALUES (?,?,?,'pending')",
        [this.storage.partition, operationId, canonicalJson(payload)],
      )
      return undefined
    })
    if (cached !== undefined) return cached
    const result = await this.transport.command<Result>(
      this.envelope('command', payload),
    )
    this.verifySession(token)
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new SynloquentError(
        'schema_mismatch',
        'A registered command result must be its declared object projection.',
      )
    for (const [field, value] of Object.entries(result)) {
      const fieldDefinition = definition.result[field]
      if (!fieldDefinition)
        throw new SynloquentError(
          'schema_mismatch',
          `Unexpected command result field ${field}.`,
        )
      validateValue(field, fieldDefinition, value)
    }
    for (const field of Object.keys(definition.result))
      if (!(field in result))
        throw new SynloquentError(
          'schema_mismatch',
          `Missing declared command result field ${field}.`,
        )
    await this.storage.write(async (executor) => {
      this.verifySession(token)
      await executor.execute(
        "UPDATE syn_commands SET status = 'accepted', result = ? WHERE partition = ? AND operation_id = ?",
        [canonicalJson(result), this.storage.partition, operationId],
      )
    })
    return result
  }
  async recovery(): Promise<
    readonly {
      readonly model: string
      readonly localIdentity: string
      readonly proposal: Attributes
      readonly reason: string
    }[]
  > {
    return this.storage.read(async (executor) => {
      const result = await executor.execute(
        'SELECT model,local_identity,proposal,reason FROM syn_recovery WHERE partition = ?',
        [this.storage.partition],
      )
      return result.rows.map((row) => ({
        model: String(row.model),
        localIdentity: String(row.local_identity),
        proposal: JSON.parse(String(row.proposal)) as Attributes,
        reason: String(row.reason),
      }))
    })
  }
}
export { utf8Length } from './snapshot-content.js'
