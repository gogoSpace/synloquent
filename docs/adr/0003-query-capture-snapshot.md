# Query, capture and snapshot boundaries

Portable queries use a bounded declarative AST and bound values. Exported model, field and relation identifiers form the identifier allowlist. Stable identity ordering resolves pagination ties. Exact decimals remain strings. Unknown operators fail explicitly. Server-specific scopes and commands require explicit typed registration and authorization.

Server mutations, receipts and transactional outbox entries commit together. The host capture gateway records affected identities and relation membership under the stream lock. Model events, casts, policies and actor scoping remain host responsibilities. External writers must participate in this capture contract.

Snapshots are immutable canonical content with independent schema, scope, generation, byte-length and hash identities. The client stages and validates content before activating it in an SQLite transaction. Pending intent, local control data and stable aliases survive activation. A failed snapshot leaves the prior committed generation usable.

Incremental pull uses indexed historical membership and captured changes. Cursor identity binds dataset, schema, partition and authorization generation. Incomplete capture, retention expiry and oversized work fail explicitly rather than returning an apparently complete catalog.

See the [wire protocol](../PROTOCOL.md) and [Laravel guide](../guides/laravel.md).
