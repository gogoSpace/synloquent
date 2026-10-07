# Compatibility and portable behavior

Release 0.1.0 uses protocol 1 and application schema version 1. The Composer runtime allows Illuminate 12.55 and 13.34. Qualification uses exact Laravel 12.55.1 and 13.34.0 archive consumers with PHP 8.4.7. Other versions require separate evidence. PHP 8.2 is not claimed.

The client core targets ES2022 and has no runtime dependency on React, React Native, native SQLite, Node or DOM APIs. Optional public exports isolate React and OP-SQLite18.2.5. The native consumer uses React Native0.87.1, React19.2.8 and Hermes. Android and iOS qualify separately. Node tests establish neither native lifecycle behavior nor responsiveness.

Generated TypeScript describes the bundled schema. Online metadata cannot change static application types or contain executable code. Compatible expansion requires understood engine capabilities, preserved identities/types/permissions and complete field backfill. Unsupported capability or breaking metadata returns upgrade_required. A failed update retains the prior usable schema.

Portable queries use case-sensitive LIKE, binary UTF-8 text comparison, ascending NULLS FIRST and descending NULLS LAST on SQLite, PostgreSQL and MariaDB. MariaDB comparisons explicitly use utf8mb4_nopad_bin, including grouping, distinct, joins, correlations and text aggregates, so case and trailing spaces remain significant even under a case-insensitive host collation. Resource identity supplies deterministic final ordering. Exact decimals use strings and declared scale. Unsafe integers also remain exact strings. The local driver must pass its comparison and generated-column probes.

JSON portable capabilities are json.scalar-array-contains.v1 and json.scalar-path.v1. Scalar array containment matches typed top-level array members, including JSON null. SQL NULL and JSON null are different. Scalar paths use a validated bounded path and preserve primitive JSON types. Object containment uses the explicit registered metadataContains remote scope advertised as json.object-contains.remote.v1. Local object containment returns unsupported_query. Unregistered expressions and raw SQL are rejected.

Joins are declared inner/left equality joins between authorized resources. Correlated subqueries validate every resource, field and correlation. Unions require compatible projections of the same root resource. Computed projections and relation aggregates stay read-only and do not become writable canonical model attributes.

Registered scopes, commands, custom casts, accessors and materialized appends execute in Laravel. An offline model cannot compute a PHP accessor. A materialized field can remain unavailable until its canonical value arrives. The generator represents that availability in its type.

Bulk writes use an explicit event distinction. Instance mutations preserve normal Laravel model events and observers. Declared bulk operations retain validation, casts, authorization, revisions and transactional capture while following the Laravel behavior that bypasses instance events. Local transaction durability and remote group atomicity remain separate contracts.

The method inventory is listed in `protocol/fixtures/capability-methods.json`. Consult the public guides for the supported behavior and restrictions of each operation.

## Laravel database qualification

The tested engine matrix is PostgreSQL 18.3 with Laravel connection label `pgsql`, and MariaDB 11.7.2 with each of Laravel's `mariadb` and `mysql` labels. Both MariaDB labels use the same actual MariaDB engine. Oracle MySQL is neither qualified nor claimed. MariaDB 10.7 is only the feature floor checked by the doctor for JSON_EQUALS and SKIP LOCKED, not a tested compatibility promise.

Use InnoDB for every exported table, exported pivot and Synloquent table. Configure the MariaDB connection with `charset=utf8mb4`, `timezone=+00:00` and strict mode. Configure PostgreSQL with `timezone=UTC`. Keep schema and data on the configured application/Synloquent connection. String primary and relation keys in the host schema must preserve case and trailing spaces too. Synloquent cannot repair host key collisions or change Eloquent's own relationship comparisons. The synthetic example uses exact string-key collations to demonstrate that requirement.

Schema-qualified model tables without a connection prefix are verified on PostgreSQL and MariaDB. Ordinary model tables with a connection prefix are verified on MariaDB through the `mysql` label. PostgreSQL connection prefixes are not qualified. Combining a schema-qualified model table with a nonempty connection prefix is not qualified. The tested Laravel grammar applies that prefix to the first segment of qualified column references, producing an incorrect database/schema name. The doctor independently resolves MariaDB schema and table metadata, including prefixed table names.

MariaDB JSON is a LONGTEXT alias. Declare a JSON cast or explicit exported field type. Uncast LONGTEXT fields require an explicit declaration because schema introspection alone does not distinguish JSON from ordinary long text. Portable JSON membership is typed and top-level. It does not recursively match nested arrays. Path guards distinguish object keys, array indices, missing paths and JSON null. The host is responsible for valid JSON storage and normal model casts.

The protocol preserves signed 64-bit integer bounds as decimal strings when values exceed JavaScript's safe-integer range. Host columns must accommodate those values. Timestamps are canonical UTC instants at the precision actually stored by the host column. Example second-precision timestamps do not imply microsecond storage support. MariaDB storage uses LONGTEXT for package payloads, including snapshot documents and parts. Existing payload and protocol size limits still apply.

MariaDB can reject an update when overlapping cascading foreign keys share columns, even when PostgreSQL accepts that schema and update. Synloquent preserves the engine constraint failure as a rejected mutation and rolls back domain changes, revisions and publication. It does not emulate cascades or disable foreign-key checks. A valid single composite cascade is qualified separately.

Eight original package migrations retain their released bytes. The provider registers explicit supported Laravel migration paths, substituting a compatibility file with the original active-index basename. PostgreSQL retains its partial unique index. MariaDB uses a nullable generated active marker with a unique index to admit historical memberships while rejecting two active versions. A ninth additive migration widens MariaDB payload storage and gives internal textual identities exact collations. Its down method intentionally retains the widened storage and collation to avoid truncation or identity merging.

Newly published migrations retain stable basenames, including repeated publication with or without force. An existing PostgreSQL migration ledger continues under the same names and receives only the additive migration. Consumers that previously renamed published migration timestamps must reconcile those historical names before adopting package-managed migration registration. Automatic reconciliation of custom or historically renamed copies is not claimed. Never rerun an already applied migration under a second name.

## Beta boundaries

The functional native walkthrough covers small offline CRUD, actual process restarts, push and pull, server-originated updates and durable deletion on Android and iOS with MariaDB. PostgreSQL retains the server conformance and archive-installation coverage. The tests use an emulator and simulator. They do not claim large-import performance or broad physical-device support.

Bindings must be generated from the actual host database. Engines can report different indexes and index ordering, which affects the schema fingerprint. Regenerate the file and rebuild the native application when switching engines.
