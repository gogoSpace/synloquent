import type { TransactionExecutor } from './database.js'
import { SynloquentError } from './errors.js'
import type { MemoryWorkBudget } from './memory-budget.js'
import { snapshotPhase } from './snapshot-content.js'
import type { Storage } from './storage.js'
import type {
  CanonicalRecord,
  RelationSet,
  Snapshot,
  SnapshotMetadata,
} from './types.js'
import { canonicalJson } from './values.js'

type SnapshotSource =
  | { readonly kind: 'inline'; readonly snapshot: Snapshot }
  | {
      readonly kind: 'parts'
      assertCurrent(): void
      records(consume: boolean): AsyncIterable<readonly CanonicalRecord[]>
      relationSets(): AsyncIterable<readonly RelationSet[]>
    }

/** Installs verified content inside the owner's replacement transaction.
 * Acquisition, schema migration and durable-part cleanup belong to the caller.
 */
export async function installSnapshotContents(
  storage: Storage,
  snapshot: SnapshotMetadata,
  source: SnapshotSource,
  original: TransactionExecutor,
  changed: Set<string>,
): Promise<void> {
  // Inline work has entered the owner's serialized transaction. Acquisitions
  // remain cancellable between their bounded pages until activation finishes.
  const assertAcquisitionCurrent = (): void => {
    if (source.kind === 'parts') source.assertCurrent()
  }
  assertAcquisitionCurrent()
  const bounded = source.kind === 'parts'
  const executor = bounded ? storage.snapshotExecutor(original) : original
  const pendingEffects =
    !bounded ||
    (await storage.assertBoundedSnapshotEffects(original, snapshot.dataset))
  let membershipCreated = false
  snapshotPhase(storage.configuration, 'staging', 'begin')
  try {
    if (source.kind === 'parts') {
      await storage.beginSnapshotStaging(executor)
      membershipCreated = true
      const comparisons = new Map<string, boolean>()
      for await (const records of source.records(false)) {
        assertAcquisitionCurrent()
        await storage.stageSnapshotRecords(records, executor, true, comparisons)
      }
      comparisons.clear()
      await storage.endSnapshotStaging(executor)
    } else {
      await storage.stageSnapshotRecords(source.snapshot.records, executor)
    }
    assertAcquisitionCurrent()
    await storage.clearCanonicalRelations(executor, changed)
    snapshotPhase(storage.configuration, 'records', 'begin')
    try {
      const pages =
        source.kind === 'parts'
          ? source.records(true)
          : [source.snapshot.records]
      for await (const records of pages) {
        assertAcquisitionCurrent()
        await storage.ingestSnapshotRecords(records, executor, changed, bounded)
      }
    } finally {
      snapshotPhase(storage.configuration, 'records', 'end')
    }
    snapshotPhase(storage.configuration, 'relationSets', 'begin')
    try {
      const pages =
        source.kind === 'parts'
          ? source.relationSets()
          : [source.snapshot.relationSets]
      for await (const relationSets of pages) {
        assertAcquisitionCurrent()
        await storage.ingestSnapshotRelationSets(
          relationSets,
          executor,
          changed,
          bounded,
        )
      }
    } finally {
      snapshotPhase(storage.configuration, 'relationSets', 'end')
    }
    for await (const entry of storage.pendingEntries(original, {}, bounded)) {
      assertAcquisitionCurrent()
      if (
        !['pending', 'sending', 'conflicted', 'rejected'].includes(entry.status)
      )
        continue
      const record = await storage.findStored(
        entry.operation.model,
        entry.operation.localIdentity,
        executor,
      )
      if (record?.serverIdentity === null)
        await storage.persist({ ...record, visible: true }, executor, changed)
      else if (record && !record.visible && Object.keys(record.proposal).length)
        await executor.execute(
          'INSERT OR REPLACE INTO syn_recovery(partition,model,local_identity,proposal,reason) VALUES (?,?,?,?,?)',
          [
            storage.partition,
            record.model,
            record.localIdentity,
            canonicalJson(record.proposal),
            'snapshot_scope_removed',
          ],
        )
    }
    if (pendingEffects)
      await storage.applyPendingDeleteEffects(executor, changed)
    await storage.rebuildRelationOverlays(executor, changed, bounded)
    assertAcquisitionCurrent()
    if (bounded) {
      const activationBudget = storage.snapshotWorkBudget()
      if (!activationBudget.maximumSnapshotConcurrency)
        throw new SynloquentError(
          'snapshot_admission_required',
          'Snapshot activation paused under memory pressure.',
          snapshotAdmissionDetails(activationBudget),
        )
    }
    snapshotPhase(storage.configuration, 'integrity', 'begin')
    try {
      const integrity = await executor.execute('PRAGMA integrity_check')
      if (integrity.rows.some((row) => !Object.values(row).includes('ok')))
        throw new SynloquentError(
          'snapshot_invalid',
          'SQLite integrity check failed.',
        )
      if ((await executor.execute('PRAGMA foreign_key_check')).rows.length)
        throw new SynloquentError(
          'snapshot_invalid',
          'SQLite foreign key validation failed.',
        )
    } finally {
      snapshotPhase(storage.configuration, 'integrity', 'end')
    }
    await storage.setMetadata(
      `cursor:${snapshot.dataset}`,
      snapshot.cursor,
      executor,
    )
    await storage.setMetadata('scope', canonicalJson(snapshot.scope), executor)
    await storage.setMetadata(
      'snapshotGeneration',
      snapshot.generation,
      executor,
    )
    assertAcquisitionCurrent()
    changed.add('*')
  } finally {
    try {
      if (membershipCreated)
        await original.execute('DROP TABLE syn_snapshot_membership')
    } finally {
      snapshotPhase(storage.configuration, 'staging', 'end')
    }
  }
}

export function snapshotAdmissionDetails(
  budget: MemoryWorkBudget,
): Readonly<Record<string, unknown>> {
  try {
    return {
      reason: 'memory-pressure',
      memoryBudget: {
        level: budget.level,
        reason: budget.reason,
        maximumBatchRows: budget.maximumBatchRows,
        maximumBindingBytes: budget.maximumBindingBytes,
        maximumHashBufferUnits: budget.maximumHashBufferUnits,
        maximumCacheBytes: budget.maximumCacheBytes,
        maximumCacheEntries: budget.maximumCacheEntries,
        maximumPrefetchConcurrency: budget.maximumPrefetchConcurrency,
        maximumSnapshotConcurrency: budget.maximumSnapshotConcurrency,
        maximumSnapshotResponseBytes: budget.maximumSnapshotResponseBytes,
      },
    }
  } catch {
    return { reason: 'memory-pressure', memoryBudgetContextUnavailable: true }
  }
}
