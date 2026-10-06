# Synloquent protocol 1

This document and `protocol/schemas` are the shared boundary contract. Package release 0.1.0 uses protocol 1 and application schema version 1. All identities and revisions on the wire are strings. Exact decimals are strings, calendar dates preserve their literal day and instants use UTC ISO 8601. Omitted patch fields have a different meaning from null.

## Manifest

The boot manifest has `protocolVersion`, `releaseVersion`, `schemaVersion`, `fingerprint`, `capabilities` and a `models` map. Each model exposes a stable `resource`, declared table, primary key, key type, incrementing flag, fields, relations and allowed operations. Fields declare type, nullability and readable/writable permissions independently. Export declarations are the authority for permissions. Introspection supplies storage details.

Declaring a physical field readable grants SQL read and inference access within the authorized resource scope. This includes predicates, ordering, joins, grouped keys, aggregates and scalar computed subqueries. Laravel `project()` controls serialized canonical attributes and synchronization visibility. Omitting a field there does not revoke its declared SQL permission. Exclude confidential fields from the readable query export, and express row authorization through the actor scope. Dynamic projection redaction alone cannot provide field confidentiality for query execution.

The fingerprint is SHA-256 over canonical JSON without the fingerprint member. Canonical JSON sorts object keys recursively, preserves array order, uses UTF-8 without insignificant whitespace and does not escape Unicode or slashes. Floating point values must be finite. Decimal and unsafe integer values never depend on floating point serialization.

Relations name their target model and declare the Eloquent relation type, actual foreign/local/owner keys, through keys, explicit morph map, ordered oneOfMany aggregate/tie sequence and pivot metadata as applicable. Only explicitly exported typed relation methods are inspected. Unknown fields, relations, operators or capabilities fail closed.

An optional field materialized flag marks a server-computed readable value. It remains unavailable on a new offline draft until a canonical response provides it. Writable fields and readable fields are independent permissions.

## Requests and authentication

Every request envelope contains `protocolVersion`, `requestId`, `kind`, `schemaFingerprint`, `session` and `payload`. Session includes accountId, tenantId, deviceId, deviceEpoch and generation. The authenticated host resolves the actor and validates the requested account and tenant. The client cannot select another actor by writing session metadata.

Kinds are manifest, query, push, pull, snapshot and command. The injected transport owns HTTPS, headers, cancellation and status information. An authentication failure pauses delivery. Rate limiting preserves the payload and honors Retry-After. A network timeout leaves the result uncertain.

## Queries

Query has model and optional select, where, orderBy, limit, offset, include, distinct, groupBy, having and aggregate. Include maps declared relation names to constrained nested query options. A predicate has one explicit kind. Comparison contains field, operator and value. Column comparison contains field, operator and otherField. Group contains boolean and predicates. Not contains predicate. Relation contains relation, optional nested predicate and count comparison.

Both compilers bind values, allowlist identifiers and append the identity tiebreaker to stable ordering. Supported comparison operators are =, !=, <, <=, >, >=, in, notIn, isNull, isNotNull, between, notBetween and like. Null handling is SQL three-valued logic. Portable LIKE uses a declared case policy. JSON, joins, subqueries, unions and server-specific expressions require a negotiated declarative capability.

A morph relation predicate may include an explicit morphModels list of exported model names. Every target must belong to the relation's declared morph map. Both compilers constrain the stored morph type and target identity, then evaluate the authorized target predicate. The same numeric identity in another morph target cannot satisfy the predicate. Unknown targets and non-morph relations fail before query execution.

Portable json.scalar-array-contains.v1 tests membership of one scalar in a top-level JSON array with exact JSON type semantics. JSON null in an array differs from SQL NULL, an empty array and a missing path. json.scalar-path.v1 selects a bounded primitive JSON path. Object containment requires a typed registered remote scope and json.object-contains.remote.v1. Attempted portable object containment returns unsupported_query.

Query results contain records, related normalized records, relationSets, completeness and scope. Optional aggregate contains value and grouped keys/value results. Completeness is complete or partial and describes the dataset, not whether one requested page was delivered. Scope contains dataset, authorizationGeneration, projectionGeneration and schemaFingerprint. Aggregates over partial data retain partial metadata.

## Mutations

Operation contains operationId, model, localIdentity, action, values, dependsOn and optional id, expectedRevision and atomicGroup. Actions are create, update, delete, restore, forceDelete, increment and pivot. The operation identity is independent of entity identity. Existing entities use the public server id. Offline foreign keys may use `{"$ref":{"model":"Item","localIdentity":"local-parent"}}`. The server resolves references only within the authenticated actor/device epoch and causal batch or previously accepted alias ledger.

Optional eventMode is instance or bulk. Instance mutations retain host model events. Bulk builder mutations suppress those instance events while retaining authorization, casts, transaction capture, receipt and timestamp behavior. Atomic groups remain bounded and revision-aware.

Increment values contain field and delta. Pivot values contain relation, action, targets, optional attributes, expectedRelationRevision and completeSet. Pivot actions are attach, detach, toggle, updateExistingPivot, sync and syncWithoutDetaching. Complete-set sync requires an explicit complete membership and matching relation revision.

A push result contains receipts. Receipt contains operationId, localIdentity, status and optional canonical or error. Status is accepted, conflicted or rejected. Canonical record contains model, id, revision and attributes. Conflict returns current canonical state while retaining the proposal on the client. Attempted payloads are immutable. Acknowledgment identifies exact operations and cannot acknowledge edits enqueued after transmission.

Receipts are scoped by authenticated actor, tenant, device epoch and operation identity. Changed payload reuse returns idempotency_mismatch. Domain mutation, receipt, stream batch and effect outbox share one server transaction. Receipt response pruning preserves the deduplication ledger. Replayed receipt content is reauthorized before sensitive values are returned.

## Pull and snapshots

Pull payload contains opaque cursor or null and dataset. Response contains whole transaction batches, cursor, highWater, scanComplete and scope. Batch contains cursor, changes and relationSets. Each relation set contains model, relation, parentId, revision, completeness and targets with id/attributes. An empty complete set clears canonical pivot membership. Pending local pivot proposals remain a separate overlay. Complete-set sync requires complete membership and matching relation revision. Change kind is upsert, delete or remove and contains model, id and optional record. Remove represents lost membership or access. The cursor advances over fully scanned invisible batches. A batch never splits an atomic group. Scope additionally contains completeness.

The cursor binds actor, tenant, dataset, authorization generation, projection generation and schema fingerprint. Retention floor is inclusive: a cursor sequence below the floor requires a snapshot. High-water and retention floor survive an empty journal.

Snapshot contains schemaFingerprint, dataset, generation, cursor, hash, byteSize, records, relationSets and scope. Hash and byteSize describe canonical UTF-8 JSON bytes of the object containing records and relationSets. The server materializes immutable records, membership and base cursor under the stream lock. The client validates identity, hash, limits and records before staged ingestion into one active-database transaction. Local control tables, pending proposals, aliases and operation identities survive ingestion. The transaction activates data and cursor together. Invalid snapshots leave the prior working generation intact.

A canonical record may include localIdentity from the current actor/device epoch alias ledger. It is part of the hashed record content and binds a previously accepted offline create to its stable local identity before lost receipt replay. Pending lifecycle and pivot proposals remain overlays after installation. The optional downloadUrl identifies an immutable generation and content hash. GET requires the same authenticated partition and current authorization. Revoked historical membership rejects the download. The content hash, actor grant metadata and stored byte length are checked independently.

## Stable errors

Error contains code, message and optional details. Codes include unknown_model, unknown_field, unknown_relation, forbidden_operation, forbidden_field, unsupported_query, validation_failed, conflict, schema_mismatch, cursor_expired, idempotency_mismatch, upgrade_required, stale_generation, incomplete_dataset and invalid_snapshot. Terminal errors retain proposals. Unsupported local execution never silently invokes remote work.
