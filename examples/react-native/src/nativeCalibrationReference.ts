import type {
  BindValue,
  CanonicalRecord,
  DigestLifecycle,
  Envelope,
  RelationSet,
  SnapshotMetadata,
  SnapshotPartsDescriptor,
  SnapshotPartIdentity,
  TransactionExecutor,
  WireValue,
} from '@synloquent/client'
import { SynloquentError } from '@synloquent/client'
import type { ExampleClient } from './nativeQualification'
import {
  calibrationIdentifier,
  calibrationValidateAttributes,
  calibrationValidateValue,
  calibrationOrderedDecimal,
} from './nativeReference'
import {
  calibrationCaps,
  calibrationHashPieces,
  calibrationRowDocuments,
  calibrationUtf8Length,
  withCalibrationSourceView,
} from './nativeCalibrationSource'
import type {
  CalibrationSourceIdentity,
  CalibrationSourceView,
} from './nativeCalibrationSource'
import { decodeCalibrationWirePart } from './nativeCalibrationWire'
import {
  canonicalJson,
  nativeClock,
  setApplicationWorkPhase,
  yieldToApplication,
} from './platform'

function invalid(message: string): never {
  throw new SynloquentError('snapshot_invalid', message)
}
function admission(message: string, reason: string): never {
  throw new SynloquentError('snapshot_admission_required', message, { reason })
}
function ordinary(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
}
function metadata(value: SnapshotMetadata): SnapshotMetadata {
  return {
    schemaFingerprint: value.schemaFingerprint,
    dataset: value.dataset,
    generation: value.generation,
    cursor: value.cursor,
    hash: value.hash,
    byteSize: value.byteSize,
    scope: value.scope,
  }
}
function bindingBytes(values: readonly BindValue[]): number {
  return values.reduce<number>(
    (total, value) =>
      total +
      (typeof value === 'string'
        ? calibrationUtf8Length(value)
        : value instanceof Uint8Array
          ? value.byteLength
          : 8),
    0,
  )
}
function partIdentity(
  value: SnapshotPartIdentity | undefined,
  ordinal: number,
): asserts value is SnapshotPartIdentity {
  if (
    !value ||
    value.ordinal !== ordinal ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal >= 2000000 ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 1 ||
    value.byteSize > 65536 ||
    typeof value.downloadUrl !== 'string' ||
    !value.downloadUrl ||
    value.downloadUrl.length > 4096 ||
    typeof value.continuation !== 'string' ||
    !value.continuation ||
    value.continuation.length > 4096
  )
    invalid('Calibration continuation identity is invalid.')
}
function descriptorIdentity(
  client: ExampleClient,
  value: SnapshotPartsDescriptor,
  dataset: string,
): void {
  if (
    !ordinary(value) ||
    value.format !== 'canonical-parts-v1' ||
    !['ready', 'admission-required'].includes(value.status) ||
    !ordinary(value.scope) ||
    value.schemaFingerprint !== client.storage.manifest.fingerprint ||
    value.scope.schemaFingerprint !== value.schemaFingerprint ||
    value.dataset !== dataset ||
    value.scope.dataset !== dataset ||
    !value.generation ||
    !value.cursor ||
    !value.scope.authorizationGeneration ||
    !value.scope.projectionGeneration ||
    !['complete', 'partial'].includes(value.scope.completeness ?? '') ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 0 ||
    value.byteSize > 268435456 ||
    !Number.isSafeInteger(value.partCount) ||
    value.partCount < 0 ||
    value.partCount > 2000000 ||
    !Number.isSafeInteger(value.recordCount) ||
    value.recordCount < 0 ||
    value.recordCount > 1000000 ||
    !Number.isSafeInteger(value.relationSetCount) ||
    value.relationSetCount < 0 ||
    value.relationSetCount > 1000000 ||
    value.maximumPartBytes !== 65536 ||
    value.partRowLimit !== 256 ||
    !Number.isSafeInteger(value.maximumRowBytes) ||
    value.maximumRowBytes < 0 ||
    value.maximumRowBytes > 268435456 ||
    calibrationUtf8Length(canonicalJson(value)) > 16384
  )
    invalid('Calibration descriptor identity or geometry is invalid.')
  if (value.status !== 'ready')
    admission(
      'Calibration input needs representation admission.',
      value.reason ?? 'unsupported-host-contract',
    )
  if (
    value.maximumRowBytes > 65536 ||
    (value.recordCount + value.relationSetCount === 0) !==
      (value.partCount === 0) ||
    value.partCount > value.recordCount + value.relationSetCount
  )
    invalid('Calibration ready descriptor row geometry is invalid.')
  if (value.partCount) partIdentity(value.firstPart, 0)
  else if (!value.confirmationToken)
    invalid('Calibration empty input lacks confirmation.')
}

function checkedRecord(client: ExampleClient, input: unknown): CanonicalRecord {
  if (
    !ordinary(input) ||
    typeof input.model !== 'string' ||
    typeof input.id !== 'string' ||
    !input.id ||
    typeof input.revision !== 'string' ||
    !input.revision ||
    !ordinary(input.attributes)
  )
    invalid('Calibration canonical record geometry is invalid.')
  const record = input as unknown as CanonicalRecord
  const definition = client.storage.manifest.models[record.model]
  if (!definition) invalid('Calibration canonical model is undeclared.')
  if (
    record.localIdentity !== undefined &&
    (typeof record.localIdentity !== 'string' ||
      !record.localIdentity ||
      record.localIdentity.length > 128)
  )
    invalid('Calibration stable local identity is invalid.')
  calibrationValidateAttributes(definition, record.attributes)
  const primary = record.attributes[definition.primaryKey]
  if (primary === undefined)
    calibrationValidateValue(
      definition.primaryKey,
      definition.fields[definition.primaryKey]!,
      record.id,
    )
  else if (String(primary) !== record.id)
    invalid('Calibration primary value contradicts its identity.')
  return record
}
function checkedRelation(client: ExampleClient, input: unknown): RelationSet {
  if (
    !ordinary(input) ||
    typeof input.model !== 'string' ||
    typeof input.relation !== 'string' ||
    typeof input.parentId !== 'string' ||
    !input.parentId ||
    typeof input.revision !== 'string' ||
    !input.revision ||
    !['complete', 'partial'].includes(String(input.completeness)) ||
    !Array.isArray(input.targets)
  )
    invalid('Calibration relation geometry is invalid.')
  const set = input as unknown as RelationSet
  const definition = client.storage.manifest.models[set.model]
  const relation = definition?.relations[set.relation]
  const targetDefinition =
    relation && client.storage.manifest.models[relation.model]
  if (!definition || !relation?.pivot || !targetDefinition)
    invalid('Calibration pivot relation is undeclared.')
  calibrationValidateValue(
    definition.primaryKey,
    definition.fields[definition.primaryKey]!,
    set.parentId,
  )
  // This set is bounded by the complete original wire row and admission check.
  for (const target of set.targets) {
    if (
      !ordinary(target) ||
      typeof target.id !== 'string' ||
      !target.id ||
      !ordinary(target.attributes)
    )
      invalid('Calibration relation target is invalid.')
    calibrationValidateValue(
      targetDefinition.primaryKey,
      targetDefinition.fields[targetDefinition.primaryKey]!,
      target.id,
    )
    for (const [field, value] of Object.entries(target.attributes)) {
      const fieldDefinition = relation.pivot.fields[field]
      if (!fieldDefinition?.readable)
        invalid('Calibration pivot field is undeclared or unreadable.')
      calibrationValidateValue(field, fieldDefinition, value as WireValue)
    }
  }
  return set
}

export interface CalibrationReferenceBoundary {
  readonly phase: string
  readonly state: 'begin' | 'end'
  readonly applicationMonotonicMilliseconds: number
}

export interface CalibrationReferenceReceipt {
  readonly elapsedMilliseconds: number
  readonly checkpointMilliseconds: number
  readonly records: number
  readonly relationSets: number
  readonly targets: number
  readonly rawHash: string
  readonly rawBytes: number
  readonly partInventoryHash: string
  readonly bulkStatements: number
  readonly maximumParameters: number
  readonly maximumObservedRows: number
  readonly maximumObservedBindingBytes: number
  readonly maximumObservedHashUnits: number
  readonly reclaimRequested: true
  readonly checkpointSettled: true
  readonly maintenance: {
    readonly freelistPages: number
    readonly pageCount: number
    readonly pageSize: number
  }
  readonly phases: readonly {
    readonly phase: string
    readonly elapsedMilliseconds: number
  }[]
}

/** Separate example-only matched local arm. No production transfer orchestrator is imported. */
export async function installCalibrationReference(
  client: ExampleClient,
  suppliedSourceIdentity: CalibrationSourceIdentity,
  generation: () => string,
  observeBoundary?: (event: CalibrationReferenceBoundary) => void,
  observeSourceStatement?: (
    event: import('./nativeCalibrationSource').CalibrationSourceStatement,
  ) => void,
): Promise<CalibrationReferenceReceipt> {
  const started = nativeClock.now()
  const sourceIdentity = JSON.parse(
    canonicalJson(suppliedSourceIdentity),
  ) as CalibrationSourceIdentity
  const storage = client.storage
  const originalSession = canonicalJson(storage.session)
  const originalOwnerGeneration = storage.owner.generation
  const originalPartition = storage.partition
  const expectedGeneration = generation()
  const phases: { phase: string; elapsedMilliseconds: number }[] = []
  let boundaryFailure: unknown
  const emitBoundary = (event: CalibrationReferenceBoundary) => {
    try {
      observeBoundary?.(event)
    } catch (failure) {
      boundaryFailure ??= failure
    }
  }
  let maximumObservedRows = 0
  let maximumObservedBindingBytes = 0
  let maximumObservedHashUnits = 0
  let bulkStatements = 0
  let targets = 0
  let rawBytes = 0
  let rawHash = ''
  const maximumParameters = storage.owner.adapter.capabilities.maximumParameters
  if (!Number.isSafeInteger(maximumParameters) || maximumParameters < 10)
    throw new SynloquentError(
      'schema_mismatch',
      'Calibration adapter cannot bind one supported part or ordinary record.',
    )
  const assertSession = () => {
    if (
      canonicalJson(storage.session) !== originalSession ||
      storage.partition !== originalPartition ||
      storage.owner.generation !== originalOwnerGeneration ||
      generation() !== expectedGeneration
    )
      throw new SynloquentError(
        'session_changed',
        'Calibration local source or target session changed.',
      )
  }
  const current = (lifecycle?: DigestLifecycle) => {
    assertSession()
    if (lifecycle?.cancelled)
      throw new SynloquentError(
        'session_changed',
        'Calibration verification was cancelled.',
      )
  }
  const caps = () => {
    const budget = storage.snapshotWorkBudget()
    if (!budget.maximumSnapshotConcurrency)
      admission(
        'Calibration activation is deferred by current pressure.',
        'memory-pressure',
      )
    if (
      budget.maximumBatchRows !== 16 ||
      budget.maximumBindingBytes !== 16384 ||
      budget.maximumHashBufferUnits !== 16384 ||
      budget.maximumSnapshotResponseBytes !== 65536
    )
      admission(
        'Calibration matched arm requires its declared conservative profile.',
        'unmatched-calibration-profile',
      )
  }
  const admit = async (lifecycle?: DigestLifecycle) => {
    current(lifecycle)
    await storage.configuration.refreshMemoryBudget?.()
    current(lifecycle)
    caps()
  }
  const request = <Payload>(payload: Payload): Envelope<Payload> => ({
    protocolVersion: 1,
    requestId: storage.configuration.generateIdentity(),
    kind: 'snapshot',
    schemaFingerprint: storage.manifest.fingerprint,
    session: storage.session,
    payload,
  })
  const phase = async <Result>(
    name: string,
    callback: () => Promise<Result>,
  ): Promise<Result> => {
    setApplicationWorkPhase(name)
    const beginning = nativeClock.now()
    emitBoundary({
      phase: name,
      state: 'begin',
      applicationMonotonicMilliseconds: beginning,
    })
    try {
      return await callback()
    } finally {
      const ending = nativeClock.now()
      emitBoundary({
        phase: name,
        state: 'end',
        applicationMonotonicMilliseconds: ending,
      })
      phases.push({ phase: name, elapsedMilliseconds: ending - beginning })
    }
  }
  const provider = storage.configuration.digestChunks
  if (!provider)
    admission(
      'Calibration reference requires the public streaming hash provider.',
      'streaming-digest-required',
    )
  const boundedHash = async (
    chunks: AsyncIterable<string>,
    lifecycle?: DigestLifecycle,
  ): Promise<string> => {
    async function* measured() {
      for await (const chunk of chunks) {
        for (const piece of calibrationHashPieces(chunk)) {
          current(lifecycle)
          caps()
          maximumObservedHashUnits = Math.max(
            maximumObservedHashUnits,
            piece.length,
          )
          yield piece
        }
      }
    }
    return provider(measured(), lifecycle)
  }
  const checkedExecutor = (
    original: TransactionExecutor,
    lifecycle: DigestLifecycle,
  ): TransactionExecutor => {
    const guarded: TransactionExecutor = {
      transaction: (callback) =>
        original.transaction((nested) =>
          callback(checkedExecutor(nested, lifecycle)),
        ),
      async execute(statement, parameters = []) {
        current(lifecycle)
        caps()
        const bytes = bindingBytes(parameters)
        if (parameters.length > maximumParameters)
          throw new SynloquentError(
            'schema_mismatch',
            'Calibration SQL exceeds actual driver parameter capacity.',
          )
        if (bytes > calibrationCaps.bindingBytes)
          admission(
            'Calibration SQL group exceeds its binding cap.',
            'binding-group-too-large',
          )
        maximumObservedBindingBytes = Math.max(
          maximumObservedBindingBytes,
          bytes,
        )
        return original.execute(statement, parameters)
      },
    }
    // Return the exact registered executor. An outer wrapper would hide the
    // Storage WeakMap entry and disable its bounded alias/dependency closure.
    return storage.snapshotExecutor(guarded)
  }
  const observedPage = (rows: readonly unknown[]) => {
    maximumObservedRows = Math.max(maximumObservedRows, rows.length)
  }
  const pageSize = Math.min(
    calibrationCaps.rows,
    Math.floor((maximumParameters - 2) / 2),
  )
  const receipt = await withCalibrationSourceView(
    sourceIdentity,
    async (view: CalibrationSourceView) => {
      const transport = view.transport(generation)
      let descriptor!: SnapshotPartsDescriptor
      const lifecycle = await storage.owner.verifyDigest(async (active) => {
        await phase('validation', async () => {
          await admit(active)
          descriptor = await transport.snapshotParts!(
            request({ dataset: sourceIdentity.metadata.dataset }),
            active,
          )
          current(active)
          descriptorIdentity(
            client,
            descriptor,
            sourceIdentity.metadata.dataset,
          )
          if (
            canonicalJson(metadata(descriptor)) !==
              canonicalJson({
                ...sourceIdentity.metadata,
                generation: expectedGeneration,
              }) ||
            descriptor.recordCount !== sourceIdentity.recordCount ||
            descriptor.relationSetCount !== sourceIdentity.relationSetCount ||
            descriptor.partCount !== sourceIdentity.partCount ||
            descriptor.maximumRowBytes !== sourceIdentity.maximumRowBytes
          )
            invalid(
              'Calibration descriptor differs from its sealed local input.',
            )
        })
        await admit(active)
        await phase('digest', async () => {
          let ordinal = 0
          let records = 0
          let sets = 0
          let consumed = false
          let confirmationToken = descriptor.confirmationToken
          async function* catalog() {
            yield '{"records":['
            let continuation = descriptor.firstPart
            while (continuation) {
              await admit(active)
              partIdentity(continuation, ordinal)
              const beginning = continuation
              const batch = await transport.snapshotPartBatch!(
                request({ descriptor, part: beginning }),
                active,
              )
              current(active)
              let parts = 0
              let bytes = 0
              for await (const part of batch.parts) {
                await admit(active)
                if (
                  ++parts > 16 ||
                  (bytes += part.byteSize + 1) > 1048576 ||
                  part.ordinal !== ordinal ||
                  ordinal >= descriptor.partCount ||
                  (parts === 1 &&
                    (part.hash !== beginning.hash ||
                      part.byteSize !== beginning.byteSize))
                )
                  invalid('Calibration bundle does not match its continuation.')
                const decoded = decodeCalibrationWirePart(part)
                if (
                  canonicalJson(decoded.rows) !== canonicalJson(part.rows) ||
                  (await boundedHash(
                    (async function* () {
                      yield decoded.rawDocument
                    })(),
                    active,
                  )) !== part.hash
                )
                  invalid(
                    'Calibration original wire bytes or decoded rows differ.',
                  )
                if (
                  decoded.firstIndex !==
                    (decoded.section === 'records' ? records : sets) ||
                  (decoded.section === 'records' && sets) ||
                  (decoded.section === 'relationSets' &&
                    records !== descriptor.recordCount)
                )
                  invalid(
                    'Calibration sections are reordered or discontinuous.',
                  )
                let rowIndex = 0
                for (const document of calibrationRowDocuments(
                  decoded.rawRows,
                )) {
                  const row = decoded.rows[rowIndex]
                  if (
                    canonicalJson(JSON.parse(document)) !== canonicalJson(row)
                  )
                    invalid(
                      'Calibration raw row contradicts its decoded value.',
                    )
                  const bytes = calibrationUtf8Length(document)
                  if (bytes > descriptor.maximumRowBytes)
                    invalid('Calibration row exceeds its declared maximum.')
                  if (bytes + 512 > calibrationCaps.bindingBytes)
                    admission(
                      'Calibration row cannot be activated under the conservative cap.',
                      'row-too-large',
                    )
                  const validated =
                    decoded.section === 'records'
                      ? checkedRecord(client, row)
                      : checkedRelation(client, row)
                  const identity =
                    decoded.section === 'records'
                      ? (validated as CanonicalRecord).id
                      : `${(validated as RelationSet).relation}:${(validated as RelationSet).parentId}`
                  if (
                    bindingBytes([
                      originalPartition,
                      descriptor.dataset,
                      decoded.section,
                      decoded.firstIndex + rowIndex,
                      ordinal,
                      validated.model,
                      identity,
                      document,
                    ]) > 16384
                  )
                    admission(
                      'Calibration raw row cannot be acquired under the conservative cap.',
                      'row-too-large',
                    )
                  if (decoded.section === 'relationSets')
                    targets += (validated as RelationSet).targets.length
                  rowIndex++
                }
                if (rowIndex !== decoded.rowCount)
                  invalid('Calibration raw row count differs.')
                if (decoded.section === 'relationSets' && !sets)
                  yield '],"relationSets":['
                if ((decoded.section === 'records' ? records : sets) > 0)
                  yield ','
                yield decoded.rawRowInterior
                if (decoded.section === 'records') records += decoded.rowCount
                else sets += decoded.rowCount
                if (
                  records > descriptor.recordCount ||
                  sets > descriptor.relationSetCount
                )
                  invalid('Calibration catalog exceeds its declared counts.')
                ordinal++
              }
              if (!parts) invalid('Calibration bundle is empty.')
              if (batch.nextPart) {
                partIdentity(batch.nextPart, ordinal)
                if (
                  batch.nextPart.ordinal <= beginning.ordinal ||
                  batch.confirmationToken !== undefined
                )
                  invalid(
                    'Calibration continuation made no progress or confirmed too early.',
                  )
              } else if (
                ordinal !== descriptor.partCount ||
                !batch.confirmationToken
              )
                invalid('Calibration bundle lacks complete final confirmation.')
              continuation = batch.nextPart
              confirmationToken = batch.confirmationToken
            }
            if (!sets) yield '],"relationSets":['
            yield ']}'
            consumed = true
            if (
              ordinal !== descriptor.partCount ||
              records !== descriptor.recordCount ||
              sets !== descriptor.relationSetCount
            )
              invalid('Calibration complete row counts differ.')
          }
          async function* counted() {
            for await (const piece of catalog()) {
              rawBytes += calibrationUtf8Length(piece)
              if (rawBytes > descriptor.byteSize)
                invalid(
                  'Calibration original catalog exceeds its declared bytes.',
                )
              yield piece
            }
          }
          rawHash = await boundedHash(counted(), active)
          current(active)
          if (
            !consumed ||
            rawHash !== descriptor.hash ||
            rawBytes !== descriptor.byteSize
          )
            invalid('Calibration original catalog hash or bytes differ.')
          if (
            (await view.inventoryHash(active)) !==
            sourceIdentity.partInventoryHash
          )
            invalid('Calibration durable source inventory changed.')
          current(active)
          if (!confirmationToken)
            invalid('Calibration confirmation token is absent.')
          const confirmation = await transport.confirmSnapshotParts!(
            request({ descriptor, confirmationToken }),
            active,
          )
          current(active)
          if (
            confirmation.confirmed !== true ||
            canonicalJson(metadata(confirmation)) !==
              canonicalJson(metadata(descriptor))
          )
            invalid('Calibration final confirmation differs.')
        })
        return active
      })
      await admit(lifecycle)
      async function* rows<Row>(
        section: 'records' | 'relationSets',
      ): AsyncGenerator<readonly Row[]> {
        let page: Row[] = []
        let bytes = 0
        for await (const ordinal of view.partOrdinals(section)) {
          current(lifecycle)
          const part = await view.readPart(ordinal)
          if (part.section !== section)
            invalid(
              'Calibration source section index contradicts its raw part.',
            )
          let index = 0
          for (const document of calibrationRowDocuments(part.rawRows)) {
            const row = part.rows[index++]!
            const required = calibrationUtf8Length(document) + 512
            if (required > calibrationCaps.bindingBytes)
              admission(
                'Calibration activation row exceeds its cap.',
                'row-too-large',
              )
            if (
              page.length &&
              (page.length >= pageSize ||
                bytes + required > calibrationCaps.bindingBytes)
            ) {
              observedPage(page)
              yield page
              page = []
              bytes = 0
            }
            page.push(row as Row)
            bytes += required
          }
        }
        if (page.length) {
          observedPage(page)
          yield page
        }
      }
      let commitStarted = 0
      await storage.owner.replace(async (original, changed) => {
        current(lifecycle)
        const executor = checkedExecutor(original, lifecycle)
        const pendingEffects = await storage.assertBoundedSnapshotEffects(
          executor,
          descriptor.dataset,
        )
        await executor.execute(
          'CREATE TEMP TABLE syn_calibration_reference_identities(model TEXT NOT NULL,identity TEXT NOT NULL,PRIMARY KEY(model,identity)) WITHOUT ROWID',
        )
        let membershipStarted = false
        try {
          await phase('staging', async () => {
            await storage.beginSnapshotStaging(executor)
            membershipStarted = true
            const comparisons = new Map<string, boolean>()
            for await (const page of rows<CanonicalRecord>('records')) {
              const registered = await executor.execute(
                'INSERT OR IGNORE INTO syn_calibration_reference_identities(model,identity) VALUES ' +
                  page.map(() => '(?,?)').join(','),
                page.flatMap((record) => [record.model, record.id]),
              )
              if (registered.changes !== page.length)
                invalid('Calibration input repeats a model identity.')
              await storage.stageSnapshotRecords(
                page,
                executor,
                true,
                comparisons,
              )
            }
            comparisons.clear()
            await storage.endSnapshotStaging(executor)
            await storage.clearCanonicalRelations(executor, changed)
          })
          await phase('records', async () => {
            for await (const page of rows<CanonicalRecord>('records')) {
              const exceptions = new Set<string>()
              for (const model of new Set(page.map((record) => record.model))) {
                const identities = page
                  .filter((record) => record.model === model)
                  .map((record) => record.id)
                const existing = await executor.execute(
                  `SELECT _server_identity FROM ${calibrationIdentifier('syn_model_' + model)} WHERE _partition=? AND (_local_identity != 'c:' || _server_identity OR _proposal != '{}' OR _state != 'synced') AND _server_identity IN (${identities.map(() => '?').join(',')})`,
                  [originalPartition, ...identities],
                )
                for (const record of existing.rows)
                  if (record._server_identity !== null)
                    exceptions.add(
                      model + ':' + String(record._server_identity),
                    )
              }
              let model: string | undefined
              let parameters: BindValue[] = []
              let columns: string[] = []
              let count = 0
              let bytes = 0
              const flush = async () => {
                if (!count || !model) return
                const placeholder = '(' + columns.map(() => '?').join(',') + ')'
                await executor.execute(
                  `INSERT INTO ${calibrationIdentifier('syn_model_' + model)} (${columns.map(calibrationIdentifier).join(',')}) VALUES ${Array.from({ length: count }, () => placeholder).join(',')} ON CONFLICT(_partition,_local_identity) DO UPDATE SET ${columns
                    .slice(2)
                    .map(
                      (column) =>
                        calibrationIdentifier(column) +
                        '=excluded.' +
                        calibrationIdentifier(column),
                    )
                    .join(',')}`,
                  parameters,
                )
                changed.add(model)
                bulkStatements++
                parameters = []
                count = 0
                bytes = 0
              }
              for (const supplied of page) {
                const record = checkedRecord(client, supplied)
                if (
                  exceptions.has(record.model + ':' + record.id) ||
                  record.localIdentity !== undefined
                ) {
                  await flush()
                  await storage.ingest(
                    record,
                    executor,
                    changed,
                    undefined,
                    true,
                  )
                  continue
                }
                const definition = storage.manifest.models[record.model]!
                const decimals = Object.entries(definition.fields).filter(
                  ([, field]) => field.type === 'decimal',
                )
                const attributes = calibrationValidateAttributes(
                  definition,
                  record.attributes,
                )
                const values: BindValue[] = [
                  originalPartition,
                  'c:' + record.id,
                  record.id,
                  record.revision,
                  canonicalJson(attributes),
                  '{}',
                  1,
                  0,
                  'synced',
                ]
                for (const [field, fieldDefinition] of decimals) {
                  const value =
                    attributes[field] ??
                    (field === definition.primaryKey ? record.id : null)
                  values.push(
                    value === null
                      ? null
                      : calibrationOrderedDecimal(
                          value,
                          fieldDefinition.precision ?? 18,
                        ),
                  )
                }
                const required = bindingBytes(values)
                if (values.length > maximumParameters)
                  throw new SynloquentError(
                    'schema_mismatch',
                    'Calibration ordinary row exceeds adapter parameter capacity.',
                  )
                if (required > calibrationCaps.bindingBytes)
                  admission(
                    'Calibration ordinary row exceeds SQL bindings.',
                    'row-too-large',
                  )
                if (
                  count &&
                  (model !== record.model ||
                    count >= 16 ||
                    parameters.length + values.length > maximumParameters ||
                    bytes + required > 16384)
                )
                  await flush()
                model = record.model
                columns = [
                  '_partition',
                  '_local_identity',
                  '_server_identity',
                  '_revision',
                  '_canonical',
                  '_proposal',
                  '_visible',
                  '_deleted',
                  '_state',
                  ...decimals.map(([field]) => '_order_' + field),
                ]
                parameters.push(...values)
                count++
                bytes += required
              }
              await flush()
              await yieldToApplication()
            }
          })
          await phase('relationSets', async () => {
            for await (const page of rows<RelationSet>('relationSets')) {
              await storage.ingestSnapshotRelationSets(
                page,
                executor,
                changed,
                true,
              )
              await yieldToApplication()
            }
            for await (const entry of storage.pendingEntries(
              executor,
              {},
              true,
            )) {
              if (
                !['pending', 'sending', 'conflicted', 'rejected'].includes(
                  entry.status,
                )
              )
                continue
              const record = await storage.findStored(
                entry.operation.model,
                entry.operation.localIdentity,
                executor,
              )
              if (record?.serverIdentity === null)
                await storage.persist(
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
                    originalPartition,
                    record.model,
                    record.localIdentity,
                    canonicalJson(record.proposal),
                    'snapshot_scope_removed',
                  ],
                )
            }
            if (pendingEffects)
              await storage.applyPendingDeleteEffects(executor, changed)
            await storage.rebuildRelationOverlays(executor, changed, true)
          })
          await phase('integrity', async () => {
            const integrity = await executor.execute('PRAGMA integrity_check')
            if (
              integrity.rows.length !== 1 ||
              integrity.rows[0]?.integrity_check !== 'ok' ||
              (await executor.execute('PRAGMA foreign_key_check')).rows.length
            )
              invalid('Calibration SQLite integrity or foreign keys failed.')
          })
          current(lifecycle)
          caps()
          await storage.setMetadata(
            'cursor:' + descriptor.dataset,
            descriptor.cursor,
            executor,
          )
          await storage.setMetadata(
            'scope',
            canonicalJson(descriptor.scope),
            executor,
          )
          await storage.setMetadata(
            'snapshotGeneration',
            descriptor.generation,
            executor,
          )
          changed.add('*')
          setApplicationWorkPhase('commit')
          commitStarted = nativeClock.now()
          emitBoundary({
            phase: 'commit-and-reclaim',
            state: 'begin',
            applicationMonotonicMilliseconds: commitStarted,
          })
        } finally {
          if (membershipStarted)
            await original.execute('DROP TABLE syn_snapshot_membership')
          await original.execute(
            'DROP TABLE syn_calibration_reference_identities',
          )
        }
        current(lifecycle)
        caps()
      }, true)
      const committedAndReclaimed = nativeClock.now()
      emitBoundary({
        phase: 'commit-and-reclaim',
        state: 'end',
        applicationMonotonicMilliseconds: committedAndReclaimed,
      })
      phases.push({
        phase: 'commit-and-reclaim',
        elapsedMilliseconds: committedAndReclaimed - commitStarted,
      })
      storage.memoryCache.clear()
      // Activation has committed. A failed explicit checkpoint invalidates this measurement,
      // without claiming rollback or retrying the already committed import.
      const checkpointStarted = nativeClock.now()
      emitBoundary({
        phase: 'checkpoint',
        state: 'begin',
        applicationMonotonicMilliseconds: checkpointStarted,
      })
      await storage.owner.checkpoint()
      if (
        canonicalJson(storage.session) !== originalSession ||
        storage.partition !== originalPartition ||
        storage.owner.generation !== originalOwnerGeneration + 1 ||
        generation() !== expectedGeneration
      )
        throw new SynloquentError(
          'session_changed',
          'Calibration committed target was replaced before its final checkpoint settled.',
        )
      const checkpointEnded = nativeClock.now()
      emitBoundary({
        phase: 'checkpoint',
        state: 'end',
        applicationMonotonicMilliseconds: checkpointEnded,
      })
      const checkpointMilliseconds = checkpointEnded - checkpointStarted
      const maintenanceStarted = nativeClock.now()
      emitBoundary({
        phase: 'maintenance',
        state: 'begin',
        applicationMonotonicMilliseconds: maintenanceStarted,
      })
      const maintenance = await storage.owner.read(async (executor) => {
        const free = (await executor.execute('PRAGMA freelist_count')).rows[0]
        const count = (await executor.execute('PRAGMA page_count')).rows[0]
        const size = (await executor.execute('PRAGMA page_size')).rows[0]
        return {
          freelistPages: Number(free?.freelist_count),
          pageCount: Number(count?.page_count),
          pageSize: Number(size?.page_size),
        }
      })
      const maintenanceEnded = nativeClock.now()
      emitBoundary({
        phase: 'maintenance',
        state: 'end',
        applicationMonotonicMilliseconds: maintenanceEnded,
      })
      if (
        !Object.values(maintenance).every(Number.isSafeInteger) ||
        maintenance.freelistPages !== 0 ||
        maintenance.pageCount < 1 ||
        maintenance.pageSize < 1
      )
        throw new Error(
          'Calibration committed maintenance evidence is incomplete.',
        )
      return {
        elapsedMilliseconds: nativeClock.now() - started,
        checkpointMilliseconds,
        records: descriptor.recordCount,
        relationSets: descriptor.relationSetCount,
        targets,
        rawHash,
        rawBytes,
        partInventoryHash: sourceIdentity.partInventoryHash,
        bulkStatements,
        maximumParameters,
        maximumObservedRows,
        maximumObservedBindingBytes,
        maximumObservedHashUnits,
        reclaimRequested: true,
        checkpointSettled: true,
        maintenance,
        phases,
      } satisfies CalibrationReferenceReceipt
    },
    provider,
    observeSourceStatement,
  )
  if (boundaryFailure) throw boundaryFailure
  return receipt
}
