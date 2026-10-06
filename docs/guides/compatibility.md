# Compatibility and current limits

The example pins Laravel 13.34.0, PHP 8.4, PostgreSQL 18, React Native 0.87.1, React 19.2.8, Hermes and OP-SQLite 18.2.5. The local Composer archive has also been installed into Laravel 12.55.1 with provider discovery, migrations and schema generation. Other versions require their own compatibility testing.

The current server runtime supports PostgreSQL only. MySQL, MariaDB, SQLite and SQL Server are not yet supported as Laravel backends. The database-independent backend roadmap targets the host application's existing connection and shared transactions, without adding a separate PostgreSQL service. MySQL/MariaDB are the first expansion targets. SQLite and SQL Server remain tracked follow-up targets. This does not change the client's use of local SQLite.

The portable TypeScript core has no runtime dependencies. React, React Native, SQLite and native hashing are optional entrypoints. Node 22 and TypeScript 5.9 are the development targets. Use the supplied locks rather than updating dependencies while evaluating this pre-alpha.

## What has been tested natively

A small synthetic A/B workflow has passed on an Android emulator and an iOS simulator: offline create/read/update, persistence across a process restart, server synchronization, offline deletion of a synchronized row, another restart and final server deletion. This is the current pre-alpha validation scope.

Relations, conflict resolution, compatible schema backfill, account changes and retention recovery have broader implementation and testing requirements. The small example does not establish their complete native compatibility. Large imports, memory limits and UI responsiveness are still under development. Physical devices and production authentication are not covered by the loopback example.

## Portability rules

Expose explicit readable and writable projections. Preserve server policies and actor/tenant scope. JSON operations use a declared portable subset, while server-specific scopes and commands require typed registration. Exact decimals remain strings. Unsupported operations fail explicitly rather than silently performing remote work.

Local save completion means a committed SQLite mutation and durable pending operation. Server acceptance is separate. Query results carry completeness metadata, and remote detached reads cannot be used as editable local models.

See the [client guide](client.md), [Laravel guide](laravel.md), [wire protocol](../PROTOCOL.md) and [recovery guide](sync-recovery.md) for these contracts.
