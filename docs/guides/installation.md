# Installation and local example

The repository contains local Composer and npm archives and pinned example applications. The archive identities are in [distribution.json](../../artifacts/packages/distribution.json). They are not registry releases.

## Install the locked dependencies

Use PHP 8.4 with PDO PostgreSQL, Composer 2, PostgreSQL 18 and Node 22. Android additionally needs JDK 21 and the Android SDK. iOS needs macOS, Xcode and CocoaPods. Set `JAVA_HOME` to your installed JDK. On macOS, `/usr/libexec/java_home -v 21` can locate it.

Run from the repository root:

```sh
mkdir -p examples/laravel/bootstrap/cache examples/laravel/storage/logs
mkdir -p examples/laravel/storage/framework/cache examples/laravel/storage/framework/sessions examples/laravel/storage/framework/views
npm ci --ignore-scripts --no-audit --no-fund
composer install --working-dir=packages/laravel --no-interaction --prefer-dist
composer install --working-dir=examples/laravel --no-interaction --prefer-dist
npm ci --prefix=examples/react-native --no-audit --no-fund
node scripts/repair_rn_types.mjs
npm run build
```

The declaration repair applies three exact TypeScript fixes to the pinned React Native package. It rejects other versions or unexpected declaration content. It does not disable type checking.

## Create an isolated PostgreSQL cluster

The commands below use only disposable synthetic data. They create a new cluster in `.local/postgres`, listen on loopback port `55433` and use local trust authentication. This is a development configuration, not a production database setup. Put `initdb`, `pg_ctl`, `createdb`, `dropdb` and `psql` on PATH.

Choose another free port if `55433` is occupied, and update the public environment template and all database commands consistently. The example selects PostgreSQL in its configuration and does not read `DB_CONNECTION`.

The first-run block refuses an existing environment file or data directory. Preserve an existing installation and use the restart procedure instead.

```sh
(
  set -eu
  example_database_directory="$(pwd)/.local/postgres"
  test ! -e examples/laravel/.env
  test ! -e "$example_database_directory"
  cp examples/laravel/.env.example examples/laravel/.env
  php examples/laravel/artisan key:generate --no-interaction
  php -r '$environmentPath = "examples/laravel/.env"; $environmentContents = file_get_contents($environmentPath); $environmentContents = preg_replace("/^SYNLOQUENT_CURSOR_SECRET=$/m", "SYNLOQUENT_CURSOR_SECRET=".bin2hex(random_bytes(32)), $environmentContents, 1, $replacementCount); if ($replacementCount !== 1) { throw new RuntimeException("Expected one empty cursor secret in the fresh environment."); } file_put_contents($environmentPath, $environmentContents);'
  mkdir -p "$example_database_directory"
  initdb --pgdata="$example_database_directory/data" --username=postgres --auth-local=trust --auth-host=trust --encoding=UTF8 --locale=C
  pg_ctl --pgdata="$example_database_directory/data" --log="$example_database_directory/postgres.log" --options="-h 127.0.0.1 -p 55433 -c timezone=UTC -k ''" --wait start
  createdb --host=127.0.0.1 --port=55433 --username=postgres synloquent_example
  php examples/laravel/artisan migrate --force --no-interaction
  php examples/laravel/artisan synloquent:seed-example --no-interaction
  php examples/laravel/artisan synloquent:doctor --no-interaction
  php examples/laravel/artisan synloquent:generate --output=examples/react-native/backend.generated.ts
  php examples/laravel/artisan synloquent:generate --output=examples/react-native/backend.generated.ts --check
)
```

Package migrations load automatically through the service provider. Publish `synloquent-migrations` only if your host deliberately takes ownership of migration deployment. `synloquent:seed-example` creates the synthetic domain. The generator produces `backendSchema`, `BackendModels`, `BackendCommands` and `BackendScopes` in one file.

## Start Laravel and React Native

In one terminal:

```sh
php examples/laravel/artisan serve --host=127.0.0.1 --port=8769
```

Check the host from another terminal:

```sh
curl --fail http://127.0.0.1:8769/up
```

This checks HTTP startup, not synchronization. The ordinary example uses `http://10.0.2.2:8769` on Android and `http://127.0.0.1:8769` on the iOS simulator. If that HTTP port is unavailable, change the endpoint in `examples/react-native/src/Demo.tsx` as well as `APP_URL`. Changing `APP_URL` alone does not alter the mobile endpoint.

Prepare iOS pods once:

```sh
(cd examples/react-native/ios && USE_HERMES=1 pod install)
```

Start Metro in its own terminal:

```sh
cd examples/react-native
npm run start
```

Start a selected platform in another terminal:

```sh
cd examples/react-native
npm run android
```

For iOS, use `npm run ios` instead. Follow the [offline walkthrough](../../examples/react-native/README.md) after startup. Keep Metro or an installed JavaScript bundle available during offline testing.

## Restart and cleanup

Keep `.env`, its keys, the application database and the PostgreSQL directory for another session. Do not repeat `initdb`, secret generation or `migrate:fresh` for a retained installation.

After stopping your HTTP server, stop only the cluster created above:

```sh
example_database_directory="$(pwd)/.local/postgres"
pg_ctl --pgdata="$example_database_directory/data" --mode=fast --wait stop
```

Restart it with the same `pg_ctl start` command. To delete the disposable database, run `dropdb` while that cluster is running, then stop it:

```sh
dropdb --host=127.0.0.1 --port=55433 --username=postgres synloquent_example
```

## Install into another application

Install the Composer archive through a Composer artifact repository. Register export classes, an authenticated actor resolver and the host capture contract. See the [Laravel guide](laravel.md).

Install the npm archive and the pinned optional React Native peers, then run CocoaPods and normal Android autolinking. Supply generated schema, authentication, session and identity generation through the public factory described in the [client guide](client.md).

The small example has passed offline edits, restart persistence and explicit synchronization on two emulator platforms. This does not establish production authentication, physical-device compatibility, relations or large-catalog performance. The exact current public installation sequence remains a clean-install roadmap item.
