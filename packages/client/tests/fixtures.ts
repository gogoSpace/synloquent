import { createHash } from 'node:crypto'
import type {
  Attributes,
  ClientConfiguration,
  Manifest,
  Transport,
} from '../src/index.js'
import { canonicalJson } from '../src/core/values.js'
import { utf8Length } from '../src/core/snapshot-content.js'
import { openTestDatabase } from './sqlite.js'
const writable = { nullable: false, readable: true, writable: true }
const id = { ...writable, type: 'integer' as const, writable: false }
export const manifest: Manifest = {
  protocolVersion: 1,
  releaseVersion: '0.1.0',
  schemaVersion: 1,
  fingerprint: 'fixture-v1',
  capabilities: [],
  models: {
    Item: {
      resource: 'items',
      table: 'items',
      primaryKey: 'id',
      keyType: 'integer',
      incrementing: true,
      fields: {
        id,
        name: { ...writable, type: 'string' },
        price: { ...writable, type: 'decimal', precision: 2, default: '0.00' },
        active: { ...writable, type: 'boolean', default: true },
        count: { ...writable, type: 'integer', default: 0 },
        deleted_at: {
          ...writable,
          type: 'datetime',
          nullable: true,
          default: null,
        },
      },
      relations: {
        images: { type: 'hasMany', model: 'Image', foreignKey: 'item_id' },
        tags: {
          type: 'belongsToMany',
          model: 'Tag',
          pivot: {
            table: 'item_tag',
            foreignKey: 'item_id',
            relatedKey: 'tag_id',
            fields: {
              position: { ...writable, type: 'integer', default: 0 },
              featured: { ...writable, type: 'boolean', default: false },
            },
          },
        },
      },
      operations: [
        'create',
        'update',
        'delete',
        'restore',
        'forceDelete',
        'increment',
        'pivot',
      ],
      softDeletes: 'deleted_at',
      indexes: [['name']],
    },
    Image: {
      resource: 'images',
      table: 'images',
      primaryKey: 'id',
      keyType: 'integer',
      incrementing: true,
      fields: {
        id,
        item_id: { ...writable, type: 'integer' },
        url: { ...writable, type: 'string' },
      },
      relations: {
        item: { type: 'belongsTo', model: 'Item', foreignKey: 'item_id' },
      },
      operations: ['create', 'update', 'delete'],
    },
    Tag: {
      resource: 'tags',
      table: 'tags',
      primaryKey: 'id',
      keyType: 'integer',
      incrementing: true,
      fields: { id, label: { ...writable, type: 'string' } },
      relations: {},
      operations: ['create', 'update', 'delete'],
    },
  },
}
export function configuration(
  filename = ':memory:',
  transport?: Transport,
): ClientConfiguration {
  let identity = 0
  return {
    schema: manifest,
    database: openTestDatabase(filename),
    session: {
      accountId: 'actor-1',
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      deviceEpoch: 'epoch-1',
      generation: 1,
    },
    generateIdentity: () => `identity-${++identity}`,
    now: () => '2026-10-02T12:00:00.000Z',
    digest: async (content) =>
      createHash('sha256').update(content).digest('hex'),
    ...(transport ? { transport } : {}),
  }
}
export function item(id_: string, attributes: Attributes) {
  return {
    model: 'Item',
    id: id_,
    revision: '1',
    attributes: {
      id: id_,
      name: 'Default',
      price: '0.00',
      active: true,
      count: 0,
      deleted_at: null,
      ...attributes,
    },
  }
}

export function snapshotFor(
  records: readonly import('../src/index.js').CanonicalRecord[],
  schema: Manifest = manifest,
  relationSets: readonly import('../src/index.js').RelationSet[] = [],
): import('../src/index.js').Snapshot {
  const content = canonicalJson({ records, relationSets })
  return {
    records,
    relationSets,
    dataset: 'default',
    schemaFingerprint: schema.fingerprint,
    generation: 'snapshot-1',
    cursor: 'cursor-1',
    byteSize: utf8Length(content),
    hash: createHash('sha256').update(content).digest('hex'),
    scope: {
      dataset: 'default',
      schemaFingerprint: schema.fingerprint,
      authorizationGeneration: 'auth-1',
      projectionGeneration: 'projection-1',
      completeness: 'complete',
    },
  }
}
