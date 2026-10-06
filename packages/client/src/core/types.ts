import type { DatabaseAdapter } from './database.js'
import type { MemoryBudgetPolicy } from './memory-budget.js'

export type WireValue =
  | null
  | boolean
  | number
  | string
  | readonly WireValue[]
  | { readonly [key: string]: WireValue }
export type Attributes = Record<string, WireValue>
export type ReadableFields = Record<string, WireValue | undefined>
export type IdentityReference = {
  readonly $ref: { readonly model: string; readonly localIdentity: string }
}
export type MutationValues = Record<string, WireValue | IdentityReference>
export interface FieldDefinition {
  readonly type:
    | 'string'
    | 'integer'
    | 'float'
    | 'decimal'
    | 'boolean'
    | 'date'
    | 'datetime'
    | 'json'
    | 'enum'
  readonly nullable: boolean
  readonly readable: boolean
  readonly writable: boolean
  readonly default?: WireValue
  readonly enum?: readonly string[]
  readonly precision?: number
  readonly materialized?: boolean
}
export type RelationFamily =
  | 'belongsTo'
  | 'hasOne'
  | 'hasMany'
  | 'belongsToMany'
  | 'hasOneThrough'
  | 'hasManyThrough'
  | 'morphTo'
  | 'morphOne'
  | 'morphMany'
  | 'morphToMany'
  | 'morphedByMany'
  | 'ofMany'
  | 'latestOfMany'
  | 'oldestOfMany'
export interface RelationDefinition {
  readonly type: RelationFamily
  readonly model: string
  readonly foreignKey?: string
  readonly localKey?: string
  readonly ownerKey?: string
  readonly pivot?: {
    readonly table: string
    readonly foreignKey: string
    readonly relatedKey: string
    readonly fields: Readonly<Record<string, FieldDefinition>>
  }
  readonly through?: string
  readonly secondKey?: string
  readonly secondLocalKey?: string
  readonly onDelete?: 'cascade' | 'restrict' | 'nullify'
  readonly onUpdate?: 'cascade' | 'restrict'
  readonly morphType?: string
  readonly morphMap?: Readonly<Record<string, string>>
  readonly aggregate?: 'min' | 'max'
  readonly aggregateField?: string
  readonly oneOfMany?: readonly {
    readonly field: string
    readonly aggregate: 'min' | 'max'
  }[]
}
export interface ModelDefinition {
  readonly resource: string
  readonly table: string
  readonly primaryKey: string
  readonly keyType: 'integer' | 'string'
  readonly incrementing: boolean
  readonly fields: Readonly<Record<string, FieldDefinition>>
  readonly relations: Readonly<Record<string, RelationDefinition>>
  readonly operations: readonly string[]
  readonly timestamps?: {
    readonly createdAt: string
    readonly updatedAt: string
  }
  readonly softDeletes?: string
  readonly unique?: readonly (readonly string[])[]
  readonly indexes?: readonly (readonly string[])[]
}
export interface Manifest {
  readonly protocolVersion: 1
  readonly releaseVersion: string
  readonly schemaVersion: number
  readonly fingerprint: string
  readonly capabilities: readonly string[]
  readonly models: Readonly<Record<string, ModelDefinition>>
  readonly commands?: Readonly<
    Record<
      string,
      {
        readonly arguments: Readonly<Record<string, FieldDefinition>>
        readonly result: Readonly<Record<string, FieldDefinition>>
      }
    >
  >
  readonly scopes?: Readonly<
    Record<
      string,
      {
        readonly model: string
        readonly arguments: Readonly<Record<string, FieldDefinition>>
      }
    >
  >
}
export type ComparisonOperator =
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'notIn'
  | 'isNull'
  | 'isNotNull'
  | 'between'
  | 'notBetween'
  | 'like'
  | 'jsonContains'
  | 'jsonPath'
export type Predicate =
  | {
      readonly kind: 'comparison'
      readonly field: string
      readonly operator: ComparisonOperator
      readonly value?: WireValue
    }
  | {
      readonly kind: 'column'
      readonly field: string
      readonly operator: '=' | '!=' | '<' | '<=' | '>' | '>='
      readonly otherField: string
    }
  | {
      readonly kind: 'group'
      readonly boolean: 'and' | 'or'
      readonly predicates: readonly Predicate[]
    }
  | { readonly kind: 'not'; readonly predicate: Predicate }
  | {
      readonly kind: 'relation'
      readonly relation: string
      readonly predicate?: Predicate
      readonly operator?: '=' | '!=' | '<' | '<=' | '>' | '>='
      readonly count?: number
      readonly morphModels?: readonly string[]
    }
export interface QueryOptions {
  readonly model: string
  readonly select?: readonly string[]
  readonly where?: Predicate
  readonly orderBy?: readonly {
    readonly field: string
    readonly direction: 'asc' | 'desc'
  }[]
  readonly limit?: number
  readonly offset?: number
  readonly include?: Readonly<Record<string, QueryOptions>>
  readonly distinct?: boolean
  readonly groupBy?: readonly string[]
  readonly having?: Predicate
  readonly trashed?: 'exclude' | 'include' | 'only'
  readonly joins?: readonly {
    readonly type: 'inner' | 'left'
    readonly model: string
    readonly alias: string
    readonly on: readonly {
      readonly field: string
      readonly otherField: string
    }[]
  }[]
  readonly joinedWhere?: readonly {
    readonly alias: string
    readonly predicate: Predicate
  }[]
  readonly subqueries?: readonly {
    readonly kind: 'select' | 'exists' | 'notExists' | 'where'
    readonly query: QueryOptions
    readonly alias?: string
    readonly field?: string
    readonly operator?: '=' | '!=' | '<' | '<=' | '>' | '>='
    readonly correlate?: readonly {
      readonly innerField: string
      readonly outerField: string
    }[]
  }[]
  readonly unions?: readonly {
    readonly all: boolean
    readonly query: QueryOptions
  }[]
  readonly relationAggregates?: readonly {
    readonly relation: string
    readonly function: 'count' | 'exists' | 'sum' | 'min' | 'max' | 'avg'
    readonly field?: string
    readonly alias?: string
  }[]
  readonly scopes?: readonly {
    readonly name: string
    readonly arguments: Attributes
  }[]
  readonly aggregate?: {
    readonly function: 'count' | 'min' | 'max' | 'sum' | 'avg'
    readonly field?: string
  }
}
export interface Session {
  readonly accountId: string
  readonly tenantId: string
  readonly deviceId: string
  readonly deviceEpoch: string
  readonly generation: number
}
export interface CanonicalRecord {
  readonly model: string
  readonly id: string
  readonly revision: string
  readonly attributes: Attributes
  readonly localIdentity?: string
}
export interface Operation {
  readonly eventMode?: 'instance' | 'bulk'
  readonly operationId: string
  readonly id?: string
  readonly model: string
  readonly localIdentity: string
  readonly action:
    | 'create'
    | 'update'
    | 'delete'
    | 'restore'
    | 'forceDelete'
    | 'increment'
    | 'pivot'
  readonly values: MutationValues
  readonly expectedRevision?: string
  readonly dependsOn: readonly string[]
  readonly atomicGroup?: string
}
export interface ProtocolFailure {
  readonly code: string
  readonly message: string
  readonly details?: Readonly<Record<string, unknown>>
}
export interface RelationSet {
  readonly model: string
  readonly relation: string
  readonly parentId: string
  readonly revision: string
  readonly completeness: 'complete' | 'partial'
  readonly targets: readonly {
    readonly id: string
    readonly attributes: Attributes
  }[]
}
export interface PushReceipt {
  readonly operationId: string
  readonly status: 'accepted' | 'conflicted' | 'rejected'
  readonly localIdentity: string
  readonly canonical?: CanonicalRecord
  readonly relationSets?: readonly RelationSet[]
  readonly error?: ProtocolFailure
}
export interface Scope {
  readonly dataset: string
  readonly authorizationGeneration: string
  readonly projectionGeneration: string
  readonly schemaFingerprint: string
  readonly completeness?: 'complete' | 'partial'
}
export interface QueryResponse {
  readonly records: readonly CanonicalRecord[]
  readonly related: readonly CanonicalRecord[]
  readonly relationSets: readonly RelationSet[]
  readonly computed?: Readonly<
    Record<
      string,
      { readonly aggregates?: Attributes; readonly projections?: Attributes }
    >
  >
  readonly aggregate?: {
    readonly value: WireValue
    readonly groups?: readonly {
      readonly keys: Attributes
      readonly value: WireValue
    }[]
  }
  readonly completeness: 'complete' | 'partial'
  readonly scope: Scope
}
export interface PullResponse {
  readonly batches: readonly {
    readonly cursor: string
    readonly changes: readonly {
      readonly kind: 'upsert' | 'delete' | 'remove'
      readonly model: string
      readonly id: string
      readonly record?: CanonicalRecord
    }[]
    readonly relationSets: readonly RelationSet[]
  }[]
  readonly cursor: string
  readonly highWater: string
  readonly scanComplete: boolean
  readonly scope: Scope
}
export interface Snapshot {
  readonly downloadUrl?: string
  readonly schemaFingerprint: string
  readonly dataset: string
  readonly generation: string
  readonly cursor: string
  readonly hash: string
  readonly byteSize: number
  readonly records: readonly CanonicalRecord[]
  readonly relationSets: readonly RelationSet[]
  readonly scope: Scope
}
export type SnapshotMetadata = Omit<Snapshot, 'records' | 'relationSets'>
export interface SnapshotPartIdentity {
  readonly ordinal: number
  readonly downloadUrl: string
  readonly hash: string
  readonly byteSize: number
  readonly continuation: string
}
export interface SnapshotPartsDescriptor extends SnapshotMetadata {
  readonly format: 'canonical-parts-v1'
  readonly status: 'ready' | 'admission-required'
  readonly partCount: number
  readonly recordCount: number
  readonly relationSetCount: number
  readonly maximumPartBytes: 65536
  readonly maximumRowBytes: number
  readonly partRowLimit: 256
  readonly firstPart?: SnapshotPartIdentity
  readonly confirmationToken?: string
  readonly reason?: 'unsupported-host-contract' | 'row-exceeds-part-budget'
}
export interface SnapshotTransferPart {
  readonly format: 'canonical-parts-v1'
  readonly ordinal: number
  readonly section: 'records' | 'relationSets'
  readonly firstIndex: number
  readonly rowCount: number
  readonly rows: readonly CanonicalRecord[] | readonly RelationSet[]
  /** Exact canonical array span, retained durably for original catalog integrity. */
  readonly rawRows: string
  readonly rawDocument: string
  readonly hash: string
  readonly byteSize: number
}
export interface SnapshotPartBatch {
  /** At most one decoded part. Consumers must finish this iterator before requesting another batch. */
  readonly parts: AsyncIterable<SnapshotTransferPart>
  readonly nextPart?: SnapshotPartIdentity
  readonly confirmationToken?: string
}
export interface SnapshotPartsConfirmation extends SnapshotMetadata {
  readonly confirmed: true
}
export interface Envelope<Payload> {
  readonly protocolVersion: 1
  readonly requestId: string
  readonly kind: string
  readonly schemaFingerprint: string
  readonly session: Session
  readonly payload: Payload
}
export interface Transport {
  manifest(request: Envelope<Record<string, never>>): Promise<Manifest>
  query(request: Envelope<QueryOptions>): Promise<QueryResponse>
  push(
    request: Envelope<{ readonly operations: readonly Operation[] }>,
  ): Promise<{ readonly receipts: readonly PushReceipt[] }>
  pull(
    request: Envelope<{
      readonly cursor: string | null
      readonly dataset: string
    }>,
  ): Promise<PullResponse>
  snapshot(request: Envelope<{ readonly dataset: string }>): Promise<Snapshot>
  snapshotParts?(
    request: Envelope<{ readonly dataset: string }>,
    lifecycle?: DigestLifecycle,
  ): Promise<SnapshotPartsDescriptor>
  snapshotPartBatch?(
    request: Envelope<{
      readonly descriptor: SnapshotPartsDescriptor
      readonly part: SnapshotPartIdentity
    }>,
    lifecycle?: DigestLifecycle,
  ): Promise<SnapshotPartBatch>
  confirmSnapshotParts?(
    request: Envelope<{
      readonly descriptor: SnapshotPartsDescriptor
      readonly confirmationToken: string
    }>,
    lifecycle?: DigestLifecycle,
  ): Promise<SnapshotPartsConfirmation>
  command<Result extends WireValue>(
    request: Envelope<{
      readonly name: string
      readonly operationId: string
      readonly arguments: Attributes
    }>,
  ): Promise<Result>
}
export interface DigestLifecycle {
  readonly cancelled: boolean
  subscribe(listener: () => void): () => void
}
export interface ClientConfiguration {
  readonly memoryBudget?: MemoryBudgetPolicy
  readonly refreshMemoryBudget?: () => Promise<void>
  readonly schema: Manifest
  readonly database: DatabaseAdapter
  readonly session: Session
  readonly transport?: Transport
  readonly generateIdentity: () => string
  readonly now: () => string
  readonly digest: (
    content: string,
    lifecycle?: DigestLifecycle,
  ) => Promise<string>
  readonly digestChunks?: (
    chunks: AsyncIterable<string>,
    lifecycle?: DigestLifecycle,
  ) => Promise<string>
  readonly schedule?: (
    callback: () => void,
    delayMilliseconds: number,
  ) => () => void
  readonly observeSnapshotPhase?: (event: {
    readonly phase: SnapshotPhase
    readonly state: 'begin' | 'end'
  }) => void
}
export type SnapshotPhase =
  | 'validation'
  | 'digest'
  | 'staging'
  | 'records'
  | 'relationSets'
  | 'integrity'
  | 'commit'
  | 'checkpoint'
export type SyncState = 'pending' | 'synced' | 'conflicted' | 'rejected'
