import type { HttpWorkBudget } from './work-budget.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateScope(value: unknown): boolean {
  return (
    isRecord(value) &&
    [
      'dataset',
      'authorizationGeneration',
      'projectionGeneration',
      'schemaFingerprint',
    ].every((field) => typeof value[field] === 'string')
  )
}

type ValidationSteps = Generator<void, boolean>

function* validateWireValue(value: unknown, depth = 0): ValidationSteps {
  yield
  if (depth > 32) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (value.length > 100000) return false
    for (const entry of value)
      if (!(yield* validateWireValue(entry, depth + 1))) return false
    return true
  }
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length > 1000) return false
  for (const key of keys)
    if (!(yield* validateWireValue(value[key], depth + 1))) return false
  return true
}

function* validateCanonical(value: unknown): ValidationSteps {
  yield
  if (
    !isRecord(value) ||
    typeof value.model !== 'string' ||
    typeof value.id !== 'string' ||
    typeof value.revision !== 'string' ||
    !isRecord(value.attributes)
  )
    return false
  return yield* validateWireValue(value.attributes)
}

function* validateRelationSets(value: unknown): ValidationSteps {
  if (!Array.isArray(value) || value.length > 1000000) return false
  for (const set of value) {
    yield
    if (
      !isRecord(set) ||
      typeof set.model !== 'string' ||
      typeof set.relation !== 'string' ||
      typeof set.parentId !== 'string' ||
      typeof set.revision !== 'string' ||
      !['complete', 'partial'].includes(String(set.completeness)) ||
      !Array.isArray(set.targets) ||
      set.targets.length > 100000
    )
      return false
    for (const target of set.targets) {
      yield
      if (
        !isRecord(target) ||
        typeof target.id !== 'string' ||
        !isRecord(target.attributes) ||
        !(yield* validateWireValue(target.attributes))
      )
        return false
    }
  }
  return true
}

function* validatePayload(
  kind: string,
  payload: unknown,
  operationId?: string,
): ValidationSteps {
  yield
  if (!isRecord(payload)) return false
  switch (kind) {
    case 'manifest': {
      if (
        payload.protocolVersion !== 1 ||
        typeof payload.fingerprint !== 'string' ||
        typeof payload.schemaVersion !== 'number' ||
        typeof payload.releaseVersion !== 'string' ||
        !Array.isArray(payload.capabilities) ||
        !isRecord(payload.models)
      )
        return false
      for (const capability of payload.capabilities) {
        yield
        if (typeof capability !== 'string') return false
      }
      return true
    }
    case 'query': {
      if (!Array.isArray(payload.records) || !Array.isArray(payload.related))
        return false
      for (const record of payload.records)
        if (!(yield* validateCanonical(record))) return false
      for (const record of payload.related)
        if (!(yield* validateCanonical(record))) return false
      return (
        (yield* validateRelationSets(payload.relationSets)) &&
        ['complete', 'partial'].includes(String(payload.completeness)) &&
        validateScope(payload.scope)
      )
    }
    case 'push': {
      if (!Array.isArray(payload.receipts)) return false
      for (const receipt of payload.receipts) {
        yield
        if (
          !isRecord(receipt) ||
          typeof receipt.operationId !== 'string' ||
          typeof receipt.localIdentity !== 'string' ||
          !['accepted', 'conflicted', 'rejected'].includes(
            String(receipt.status),
          ) ||
          (receipt.canonical !== undefined &&
            !(yield* validateCanonical(receipt.canonical))) ||
          (receipt.relationSets !== undefined &&
            !(yield* validateRelationSets(receipt.relationSets)))
        )
          return false
      }
      return true
    }
    case 'pull': {
      if (
        typeof payload.cursor !== 'string' ||
        typeof payload.highWater !== 'string' ||
        typeof payload.scanComplete !== 'boolean' ||
        !validateScope(payload.scope) ||
        !Array.isArray(payload.batches)
      )
        return false
      for (const batch of payload.batches) {
        yield
        if (
          !isRecord(batch) ||
          typeof batch.cursor !== 'string' ||
          !(yield* validateRelationSets(batch.relationSets)) ||
          !Array.isArray(batch.changes)
        )
          return false
        for (const change of batch.changes) {
          yield
          if (
            !isRecord(change) ||
            !['upsert', 'delete', 'remove'].includes(String(change.kind)) ||
            typeof change.model !== 'string' ||
            typeof change.id !== 'string' ||
            (change.kind === 'upsert' &&
              !(yield* validateCanonical(change.record)))
          )
            return false
        }
      }
      return true
    }
    case 'snapshot': {
      if (
        typeof payload.schemaFingerprint !== 'string' ||
        typeof payload.dataset !== 'string' ||
        typeof payload.generation !== 'string' ||
        typeof payload.cursor !== 'string' ||
        typeof payload.hash !== 'string' ||
        typeof payload.byteSize !== 'number' ||
        !Array.isArray(payload.records)
      )
        return false
      for (const record of payload.records)
        if (!(yield* validateCanonical(record))) return false
      return (
        (yield* validateRelationSets(payload.relationSets)) &&
        validateScope(payload.scope)
      )
    }
    case 'command': {
      if (
        !Object.keys(payload).every((key) =>
          ['operationId', 'status', 'replayed', 'result'].includes(key),
        ) ||
        payload.operationId !== operationId ||
        payload.status !== 'accepted' ||
        (payload.replayed !== undefined &&
          typeof payload.replayed !== 'boolean') ||
        !isRecord(payload.result)
      )
        return false
      return yield* validateWireValue(payload.result)
    }
    default:
      return false
  }
}

export async function validateHttpPayload(
  kind: string,
  payload: unknown,
  budget: HttpWorkBudget,
  operationId?: string,
): Promise<boolean> {
  budget.assertActive()
  const steps = validatePayload(kind, payload, operationId)
  try {
    let step = steps.next()
    while (!step.done) {
      if (budget.shouldYield()) await budget.yield()
      step = steps.next()
    }
    budget.assertActive()
    return step.value
  } finally {
    steps.return(false)
  }
}
