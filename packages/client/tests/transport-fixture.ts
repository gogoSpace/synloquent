import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { SynloquentError } from '../src/index.js'
import type {
  Attributes,
  CanonicalRecord,
  PushReceipt,
  Transport,
  WireValue,
} from '../src/index.js'
import { canonicalJson } from '../src/core/values.js'
import { utf8Length } from '../src/core/sync.js'
import { manifest } from './fixtures.js'
export function testTransport() {
  const records = new Map<string, CanonicalRecord>()
  const receipts = new Map<string, PushReceipt>()
  const attempted = new Map<string, string>()
  const aliases = new Map<string, string>()
  let serverIdentity = 0
  let loseNext = false
  const scope = {
    dataset: 'default',
    authorizationGeneration: 'auth-1',
    projectionGeneration: 'projection-1',
    schemaFingerprint: manifest.fingerprint,
    completeness: 'complete' as const,
  }
  const transport: Transport = {
    async manifest() {
      return manifest
    },
    async query() {
      return {
        records: [...records.values()],
        related: [],
        relationSets: [],
        completeness: 'complete',
        scope,
      }
    },
    async push(request) {
      const responses: PushReceipt[] = []
      for (const operation of request.payload.operations) {
        const payload = canonicalJson(operation)
        if (attempted.has(operation.operationId)) {
          assert.equal(
            payload,
            attempted.get(operation.operationId),
            'An attempted payload must stay immutable',
          )
          responses.push(receipts.get(operation.operationId)!)
          continue
        }
        attempted.set(operation.operationId, payload)
        const id =
          operation.id ??
          aliases.get(`${operation.model}:${operation.localIdentity}`) ??
          String(++serverIdentity)
        const key = `${operation.model}:${id}`
        const current = records.get(key)
        let receipt: PushReceipt
        if (
          current &&
          operation.expectedRevision &&
          current.revision !== operation.expectedRevision
        )
          receipt = {
            operationId: operation.operationId,
            localIdentity: operation.localIdentity,
            status: 'conflicted',
            canonical: current,
            error: { code: 'conflict', message: 'Revision changed' },
          }
        else {
          const values: Attributes = {}
          for (const [field, value] of Object.entries(operation.values)) {
            const reference =
              value && typeof value === 'object' && '$ref' in value
                ? value.$ref
                : null
            values[field] =
              reference &&
              typeof reference === 'object' &&
              'model' in reference &&
              'localIdentity' in reference
                ? (aliases.get(
                    `${String(reference.model)}:${String(reference.localIdentity)}`,
                  ) ?? null)
                : (value as WireValue)
          }
          const canonical: CanonicalRecord = {
            model: operation.model,
            id,
            revision: String(Number(current?.revision ?? 0) + 1),
            attributes: {
              ...(operation.model === 'Item'
                ? {
                    name: 'Default',
                    price: '0.00',
                    active: true,
                    count: 0,
                    deleted_at: null,
                  }
                : {}),
              ...(current?.attributes ?? {}),
              ...values,
              id,
            },
          }
          records.set(key, canonical)
          aliases.set(`${operation.model}:${operation.localIdentity}`, id)
          receipt = {
            operationId: operation.operationId,
            localIdentity: operation.localIdentity,
            status: 'accepted',
            canonical,
          }
        }
        receipts.set(operation.operationId, receipt)
        responses.push(receipt)
      }
      if (loseNext) {
        loseNext = false
        throw new Error('response lost after commit')
      }
      return { receipts: responses }
    },
    async pull() {
      return {
        batches: [
          {
            cursor: '1',
            changes: [...records.values()].map((record) => ({
              kind: 'upsert' as const,
              model: record.model,
              id: record.id,
              record,
            })),
            relationSets: [],
          },
        ],
        cursor: '1',
        highWater: '1',
        scanComplete: true,
        scope,
      }
    },
    async snapshot() {
      const values = [...records.values()].map((record) => {
        const alias = [...aliases.entries()]
          .find(
            ([identity, serverIdentity]) =>
              identity.startsWith(record.model + ':') &&
              serverIdentity === record.id,
          )?.[0]
          .slice(record.model.length + 1)
        return { ...record, ...(alias ? { localIdentity: alias } : {}) }
      })
      const content = canonicalJson({ records: values, relationSets: [] })
      return {
        schemaFingerprint: manifest.fingerprint,
        dataset: 'default',
        generation: 'snapshot-1',
        cursor: '1',
        hash: createHash('sha256').update(content).digest('hex'),
        byteSize: utf8Length(content),
        records: values,
        relationSets: [],
        scope,
      }
    },
    async command<Result extends WireValue>(): Promise<Result> {
      throw new SynloquentError('unsupported_query', 'Fixture has no commands.')
    },
  }
  return {
    transport,
    records,
    receipts,
    attempted,
    loseNextResponse: () => {
      loseNext = true
    },
  }
}
