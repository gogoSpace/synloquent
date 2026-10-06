# Supported versions and dependencies

The example targets Laravel 13.34.0, PHP 8.4, PostgreSQL 18, React Native 0.87.1, React 19.2.8 and Hermes. The Composer archive has also been installed into Laravel 12.55.1 with provider discovery, migrations and generation. These specific results do not establish every framework minor or database engine.

Node 22, TypeScript 5.9.3, ESLint 10 and Prettier 3 are the development toolchain. Dependencies are pinned in the included lockfiles. Do not update them while reproducing the current example.

## Runtime boundaries

The client core has no runtime dependencies. React bindings and OP-SQLite 18.2.5 are optional entrypoints. Native SHA-256 uses CommonCrypto on iOS and `java.security.MessageDigest` on Android. The React Native composition uses the existing application scheduler.

Laravel uses Illuminate 12.55 or 13.34 APIs and Opis JSON Schema 2.6.0. The package requires PHP 8.3 or later, but the tested example uses PHP 8.4 with PDO PostgreSQL. PHPUnit, Orchestra Testbench, Pint, PHPStan and Larastan are development dependencies.

## Licenses

Laravel, React Native, React, OP-SQLite, ESLint, tsx, Prettier, Testbench and the PHP analysis tools use MIT licenses. TypeScript and Opis use Apache-2.0. PHPUnit uses BSD-3-Clause. Consult the installed package licenses and dependency locks for exact versions.

See [compatibility and limits](../guides/compatibility.md), [the SQLite adapter decision](0002-sqlite-driver.md), [query and capture boundaries](0003-query-capture-snapshot.md), [React Native types](0004-react-native-types.md), [React Native composition](0005-react-native-composition.md) and [bounded snapshot memory](0014-bounded-snapshot-memory.md).
