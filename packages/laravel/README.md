# synloquent/laravel

Explicit Eloquent exports, deterministic TypeScript generation and transactional offline synchronization.

Install with Composer, register export declaration classes and an authenticated actor resolver, then publish configuration. The provider loads package migrations automatically. Publish `synloquent-migrations` only when the host intentionally takes ownership of their deployment, following the Laravel guide. Use `synloquent:generate`, `synloquent:manifest`, `synloquent:snapshot` and `synloquent:doctor` through Artisan.

The host owns field permissions, business validation, policies and actor/tenant scoping. Route every supported server write through the documented transactional capture contract, including bulk, pivot and cascade paths. Runtime metadata contains declarative data only.

See the Laravel, compatibility and synchronization guides for concrete setup and capture requirements.
