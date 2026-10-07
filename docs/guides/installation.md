# Install and run locally

The `0.1.0` beta includes matching Composer and npm archives. Neither package needs a registry publication to run the example. Keep the directory layout intact because the example locks use relative archive paths. The archive filenames and SHA-256 values are in [distribution.json](../../artifacts/packages/distribution.json).

## Prerequisites

Use PHP 8.4 with Composer 2 and PDO MySQL for MariaDB, or PDO PostgreSQL for PostgreSQL. The example pins Laravel 13.34.0. Server archive installation is also tested on Laravel 12.55.1. Use Node 22.13 or later in the 22 series, React Native 0.87.1 and the exact native dependency lockfiles.

Android requires JDK 21, the Android SDK and an emulator. The checked-in Gradle wrapper downloads its pinned Gradle version if needed. Configure `ANDROID_HOME`, put its platform tools on PATH, and create an emulator in Android Studio. iOS requires macOS, Xcode with an installed simulator runtime and CocoaPods. No physical device or signing account is needed for the simulator walkthrough.

## Install the example

Run these commands from the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
php scripts/setup-example.php
composer install --working-dir=examples/laravel --no-interaction --prefer-dist
npm ci --prefix=examples/react-native --no-audit --no-fund
```

The setup command creates writable Laravel directories and a fresh `.env` with random application and cursor secrets. It preserves an existing configuration. The native install applies the documented locked React Native declaration repairs through its postinstall script. Both examples install actual package archives, without source symlinks.

## Create a dedicated database

Use a local MariaDB 11.7.2 installation and create a new database and local account using your database administrator credentials. For example, in the MariaDB client:

```sql
CREATE DATABASE synloquent_example CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'synloquent_example'@'127.0.0.1' IDENTIFIED BY 'replace-with-your-local-password';
GRANT ALL PRIVILEGES ON synloquent_example.* TO 'synloquent_example'@'127.0.0.1';
```

Set the same credentials in `examples/laravel/.env`. Its defaults select `DB_CONNECTION=mariadb`, host `127.0.0.1`, port `3306` and database `synloquent_example`. Package and example migrations require InnoDB and UTC. The included Laravel connection sets both.

For PostgreSQL 18.3, create a dedicated database and user, select `DB_CONNECTION=pgsql`, set `DB_PORT=5432` or your local port, and enter that database's credentials. The included PostgreSQL connection uses UTC. Generate the bindings from whichever engine you choose. Index metadata can differ between engines, which changes the schema fingerprint.

Never point example migrations, seed commands or development tests at a production database. Do not run the initial setup against an unrelated application's schema.

## Start Laravel

```sh
php examples/laravel/artisan migrate --force
php examples/laravel/artisan synloquent:seed-example
php examples/laravel/artisan synloquent:doctor
php examples/laravel/artisan synloquent:generate --output=examples/react-native/backend.generated.ts
php examples/laravel/artisan synloquent:generate --output=examples/react-native/backend.generated.ts --check
php examples/laravel/artisan serve --host=127.0.0.1 --port=8769
```

The doctor should report the chosen database and a ready schema. Package migrations load automatically. The seed creates demonstration users, products, categories and related catalog data. `synloquent:generate` writes one deterministic TypeScript file. After changing it, rebuild the native application or reload the development bundle.

Keep the HTTP terminal open. `curl --fail http://127.0.0.1:8769/up` checks startup. If the port is occupied, use a free port and update `APP_URL` and both platform URLs in `examples/react-native/src/Demo.tsx` consistently.

## Run React Native

Start Metro in another terminal:

```sh
npm start --prefix=examples/react-native
```

With an Android emulator running:

```sh
npm run android --prefix=examples/react-native
```

For iOS, install the pinned pods and launch the simulator application:

```sh
(cd examples/react-native/ios && pod install)
npm run ios --prefix=examples/react-native
```

Android emulator networking uses `http://10.0.2.2:8769`, and the iOS simulator uses `http://127.0.0.1:8769`. The example only allows local HTTP. Other deployments need HTTPS and a real authentication provider.

Follow the [offline walkthrough](../../examples/react-native/README.md). Stop the Laravel terminal to exercise offline edits. Force-stop and relaunch the app without uninstalling it or clearing its data. Restart Laravel before pressing Sync. Stopping Metro during a Debug build is different from a self-contained Release application. Use a Release build when you want to test startup with no development server.

On completion, stop Metro and Laravel with Ctrl-C and shut down your test emulator or simulator. Keep the dedicated database to resume later, or drop only that database and its demonstration account when you no longer need them. Preserve the generated secrets when keeping the database.

## Install in another application

For Laravel, use Composer's artifact repository pointing to a directory containing the server ZIP, then require `synloquent/laravel:0.1.0`. PHP's ZIP support must be available. Alternatively, copy the explicit package repository metadata from the included example and adjust its local `dist.url`. Register export classes, an authenticated actor resolver and policies as described in the [Laravel guide](laravel.md). Normal Composer discovery loads the provider.

For React Native, install the client TGZ from its actual filename in `distribution.json`, together with the pinned native peers. Run CocoaPods and the normal Android build. Import `createReactNativeClient` from `@synloquent/client/react-native`, supply your generated schema, stable session, secure unique identity function and request-bound authentication. Use `runtime.setSession()` and `runtime.close()` to coordinate transport cancellation with database ownership. See the [client package example](../../packages/client/README.md).

Do not rebuild or repack the supplied packages merely to install them. Package development and archive updates are described in [development and testing](../development.md).
