# Changelog

All notable changes to this project will be documented in this file.

## [3.2.0] - 2026-09-17

### Fixed

- **The package would not load on Node.js at all.** `client.ts` carried a static `import { Database, Statement } from "bun:sqlite"`, and `bun:sqlite` is a Bun-only builtin. The bundler inlined it, so `dist/index.js` contained a `bun:` specifier that Node's ESM loader rejects with `ERR_UNSUPPORTED_ESM_URL_SCHEME` — at import time, before a single connection was opened. PostgreSQL, MySQL, SQL Server and MongoDB were all unreachable on Node because of a SQLite import. SQLite now resolves its driver at runtime, in a new `sqlite-driver.ts`: `bun:sqlite` where it exists, `node:sqlite` otherwise, and a `SQLITE_DRIVER_MISSING` error naming both if neither loads. The resolution is synchronous — `createRequire` in a try/catch — so `initializeClient` and the `DBClient` constructor keep their signatures.

### Added

- **SQLite on Node.js**, through the built-in `node:sqlite` (Node 22.13+, no flag). `DatabaseSync` has no `run()`, no `query()` and no `transaction()`, so the adapter supplies the first and the ORM already drove transactions with explicit `BEGIN`/`COMMIT`.
- **Integers beyond 2^53 come back exact on Node.js.** `bun:sqlite` returns a lossy `number` for them; Node's driver throws `ERR_OUT_OF_RANGE`. The adapter catches that, flips the statement to bigint reads and retries once, so an out-of-range value arrives as a `bigint` instead of a corrupted number. Values within the safe range stay plain `number`s on both runtimes — `setReadBigInts` is per-statement and all-or-nothing, so enabling it up front would have turned every `id` column into a bigint on Node alone.

### Changed

- **The published bundle is built with `--target node`.** It was `--target bun`, which inlines CommonJS dependencies with a Bun-only interop helper: `require("events")` inside ioredis compiled to `n("events")`, undefined once Node loaded the ESM output. `--target node` fixes it and Bun runs the result unchanged.
- **`engines.node` is `>=22.13.0`**, where it claimed `>=18.0.0`. `node:sqlite` does not exist in 18 or 20, and the package only loaded at all on Node because releases from 22.7 auto-detect ESM syntax in a `.js` file. The claim was never true.
- **The description no longer claims Deno.** It was unverified; nothing in this project tests it.


## [3.1.0] - 2026-09-16

### Added

- **`length`, `precision` and `scale` now mean something.** All three were declared on `ColumnConfig` and read by nobody: the SQL type came from the `DataTypes` member alone, so `{ type: DataTypes.STRING, length: 50 }` emitted `VARCHAR(255)` on MySQL and a 200-character value was stored without complaint. One column-aware type mapper now produces the width where the dialect has one — `VARCHAR(n)` on MySQL, `NVARCHAR(n)` on SQL Server — and the value is checked against the same limit on write, so the rule holds on Postgres and SQLite too, where `TEXT` and `NUMERIC` cannot express it. Given both `length` and `maxLength`, `length` sets the column width and `maxLength` is what a value is checked against; `maxLength` alone remains validation-only and changes no DDL, as before.
  **This narrows existing behaviour.** A column declared narrower than the values already in it will now reject writes that previously succeeded.
- **`StabilizeKV`**, an in-process key-value store backing the cache when no `redisUrl` is configured. Its API follows Cloudflare Workers KV — `get`/`put`/`delete`/`list`, `expiration` and `expirationTtl`, metadata, cursor pagination — and it is LRU-bounded by `maxEntries` (default 1000). Exported both as the cache's backend and on its own from `stabilize-orm/stabilize-kv`.
- **Encryption keys can be generated and rotated.** `ORM_ENCRYPTION_KEY_FILE` names a key file (default `.stabilize/encryption.key`), and if neither the variable nor the file is present a key is generated, written with mode `0600` where the filesystem honours it, and announced with a `STABILIZE_ENCRYPTION_KEY_GENERATED` warning. `ORM_ENCRYPTION_KEYS_OLD` and the file's `retired` list hold keys that still decrypt. `activeKeyId()` is exported from `stabilize-orm/utils/encryption`.
- **The seven events that never fired now do.** `query`, `error`, `migration:start`, `migration:complete`, `transaction:start`, `transaction:complete` and `transaction:error` are emitted, with the payloads the `StabilizeEvent` type already declared. Each `error` payload carries a `phase` of `"query"`, `"transaction"` or `"migration"`.

### Changed

- **The ciphertext format is now `v3:<keyId>:<iv>:<tag>:<ciphertext>`.** The key id is `sha256(key)` truncated to eight hex characters — derived, not assigned — so a value names the key that wrote it and a key moved between the environment and the key file keeps its identity. Existing `v2:` and CBC values still read.
- **`Cache.enabled: true` with no `redisUrl` now caches.** It previously built no client and every method became a silent no-op: `get` returned null, `set` discarded, `getStats` reported zeros forever. There was no error and no caching, only the appearance of it.
- **`CacheStats` gained a required `backend` field** (`"redis" | "memory" | "disabled"`), so a cache doing nothing is distinguishable from one that is merely cold. `healthCheck()`'s `cacheStatus` reports the backend by name — `"in-memory"` is new — rather than reducing it to connected-or-not.
- **`Stabilize`'s client no longer builds its own emitter.** It is handed the ORM's, so events the client fires reach a handler registered on `orm.events`. A fifth constructor argument accepts an emitter of your own, which is the only way to hear `connection:open`, since that fires from the constructor.
- **The key id is reported** rather than inferred, and `pluck()` continues to return raw ciphertext while `selectColumns()` is decrypted.

### Fixed

- **A JSON object written to SQLite was silently destroyed.** The SQLite path handed the value straight to the driver, which binds a plain object as `NULL` — with no error at all — and spreads an array as the parameter list, failing the statement. `bindSQLiteParams` mirrors the MySQL and SQL Server binders.
- **`sanitizeSqlValue` discarded JSON on every backend.** A versioned model with a JSON column stored `NULL` in its history table even on MySQL and Postgres, contradicting the docblock above it.
- **`processForLoad` read the wrong key on a renamed column.** It indexed rows by property name while `SELECT *` returns them by column name, so an encrypted column that also declared `name:` was handed back as ciphertext.
- **Postgres `DECIMAL` was unconstrained.** It emitted a bare `DECIMAL`, which stores whatever it is handed, while MySQL and SQL Server emitted `DECIMAL(10,2)`. The three now agree on `DECIMAL(10,2)`. **This narrows the column**: a value over ten digits that Postgres previously accepted is now rejected, and a regenerated migration produces the constrained form.

### Security

- **A missing encryption key generated one, where it used to throw.** The generated file is only as durable as the filesystem it lands in — a container's ephemeral layer loses it, and every value it encrypted with it. Set `ORM_ENCRYPTION_KEY` in production, and add `.stabilize/` to `.gitignore`.

## [3.0.0] - 2026-09-16

This release was published without a changelog entry, so the entry below was written afterwards from the commits it shipped. It is not a reconstruction of intent — everything listed is in the release.

### Added

- **A MongoDB backend.** `DBType.MongoDB` selects a document store rather than a fifth SQL dialect. Models, repositories, relations, hooks, versioning, soft deletes, validation, encryption, aggregates and transactions work as they do on SQL. Four files carry it — `mongo-query.ts` translates the query builder's structured methods into command documents, `mongo-repository.ts` implements the repository against them, `mongo-schema.ts` renders a `$jsonSchema` validator, and `mongo-migrate.ts` creates and drops indexes where a migration would alter a table.
  `mongodb` is an **optional** dependency and the only one: it is external in the build, so a project that never sets `DBType.MongoDB` does not pull it in. Configuration gains `database` (the fallback for a URI whose path omits one) and `mongoOptions` (passed verbatim to `MongoClient`).
- **Refusals instead of mistranslations.** A document store is not a SQL engine, and where the two disagree the ORM reports it rather than guessing — a dropped `join()` would return the wrong rows with no error to notice. `rawQuery()`, `rawExec()`, `query()` and `queryExec()` throw `MONGO_UNSUPPORTED`; `join()`, `union()`, `with()`, `whereRaw()`, `selectRaw()`, `having()`, `distinct()` and the SQL-text forms of `where()` throw at **execution** time and name every offending method at once. `withRelations()` is the replacement for a join, resolving relations in batched reads.
- **Transactional auto-increment ids.** Ids are reserved with a `$inc` against a `stabilize_counters` collection keyed by collection name rather than by the server. Because the reservation shares the write's transaction, an aborted transaction returns its ids — the opposite of InnoDB, whose counter is not transactional and leaks the gap.

### Known Issues

- **`DECIMAL` is stored as a `double`.** MongoDB has no exact decimal unless the caller supplies a `Decimal128`, so a `DECIMAL` column loses precision the way a binary float does. Nothing is enforced, because nothing can be: store money as an `INTEGER`/`BIGINT` of the smallest unit, or as a `STRING`.
- **`lock()` / `forUpdate()` is a no-op.** MongoDB has no row lock to map it onto, so the clause is not rendered and the query runs unlocked rather than failing. Use `updateBy()` with a condition, or an optimistic lock column, for a read-modify-write that has to be safe.
- **Transactions require a replica set or a sharded cluster.** A standalone `mongod` serves reads but rejects every transaction — and every repository write runs inside one, so a standalone fails writes generally rather than only explicitly-transactional code. The client warns at connect time and the failure is reported as `TX_ERROR`.
- **`poolStats()` returns `{ active: -1, idle: -1, total: -1 }`.** The driver's pool is internal and per-server, so there is no honest number to report and the sentinel says so rather than inventing one. `healthCheck()` pings the server instead.

### Changed

- `DBType` gains a `MongoDB` member. Since `DBType` is a string enum, existing persisted values are unaffected.

## [2.2.1] - 2026-09-15

Documentation-only release. No library code changed from 2.2.0.

### Changed

- **`README.md` now documents SQL Server.** 2.2.0 added Microsoft SQL Server as a first-class dialect but the README still described only PostgreSQL, MySQL and SQLite — there was not a single mention of SQL Server anywhere in it. Added a SQL Server badge, corrected the intro and the feature list, and documented that `DBType.MSSQL` uses the `mssql` v12 driver with T-SQL-specific query generation.
- Corrected the CLI badge (was pinned at 2.1.0) and pointed the license badge at `stabilize-orm`; it previously linked to the `stabilize-cli` repository.

## [2.2.0] - 2026-09-14

### Added

- **Microsoft SQL Server support** - SQL Server is now a first-class dialect alongside SQLite, MySQL and PostgreSQL. `DBType.MSSQL` selects the `mssql` driver (v12), and the placeholder rewriter maps the library's internal `?` placeholders to `@param0`-style named parameters automatically.
  - T-SQL-specific query generation: `OUTPUT INSERTED.*` for reads-after-write, `OFFSET … FETCH` pagination with an `ORDER BY (SELECT NULL)` fallback when no ordering is supplied, and `MERGE INTO … USING … WHEN MATCHED / WHEN NOT MATCHED … OUTPUT INSERTED.*` for upserts.
  - Schema generation uses `IF OBJECT_ID(…) IS NULL CREATE TABLE` in place of `CREATE TABLE IF NOT EXISTS`, and a `sys.indexes` probe in place of `CREATE INDEX IF NOT EXISTS`, neither of which SQL Server has.
  - `poolStats()` reports borrowed / available / size for SQL Server connection pools.
  - Connection strings use a comma between host and port: `Server=host,port;User Id=sa;Password=…;Database=…;TrustServerCertificate=true`.
- **Model Relationships** - `OneToOne`, `ManyToOne`, `OneToMany` and `ManyToMany` are declared in the model configuration and eager-loaded either by passing `relations` to a finder or by chaining `.withRelations()` onto the query builder. Relations are resolved in batched follow-up queries rather than per-row.
- **Many-to-many link management** - `attach()`, `detach()` and `sync()` edit a join table directly, without loading either side of the relationship into memory.
- **`validateAll()`** - runs every validator on an entity and returns all failures at once, instead of throwing on the first one. `validate()` keeps its fail-fast behaviour.
- **`findOrFail()` / `firstOrFail()`** - throw a `StabilizeError` with code `NOT_FOUND_ERROR` rather than returning `null`.
- **Raw clause builders** - `.orderByRaw()`, `.groupByRaw()` and `.havingRaw()` accept expressions that are not bare column names.
- **`auto-migrate.ts`** - a GORM-style `AutoMigrate` that creates missing tables, adds missing columns and adds missing indexes. It never drops columns and never alters column types - it only adds.
- **Column encryption** - `utils/encryption.ts` exposes `encrypt()` / `decrypt()`; marking a column as encrypted transparently encrypts on write and decrypts on read, including for rows served from cache.
- **Connection retry with exponential backoff and jitter** - `retryAttempts` (default 3) and `retryDelay` (default 1000ms) on the client config. Retries apply to read-only statements only; a failed write is never silently replayed.
- **`auto-migrate.primary-key` and `client.retry` test suites**, plus eight integration suites (`sqlite`, `mysql`, `mariadb`, `postgres`, `mssql`, `models`, `relations`, `write-paths`) that run against real database servers and skip themselves when no server answers.

### Fixed

- **`after*` hooks and both delete hooks never ran.** `getHooks()` looked the model up via `proto.constructor`, but reads return plain rows from the driver, so the prototype was `Object` and the metadata lookup found nothing. The lookup now resolves the caller's model when one is passed, and hooks take a `model` argument for exactly this case. Any code that relied on `afterCreate` / `afterUpdate` / `afterDelete` firing will now see it fire.
- **`getRepository()` opened a second, disconnected Redis connection on every call.** Repositories are now memoised per model, so repeated calls return the same instance instead of leaking a connection that nothing closed and `getCacheStats()` never counted.
- **Cached `find()` results were written without their relations.** Rows are now hydrated and have relations loaded before being written to the cache, so a cache hit returns the same shape as a cache miss.
- **`orderByRaw` / `groupByRaw` / `havingRaw` parameter handling**, and `OFFSET`-based pagination on dialects that require an `ORDER BY`.

### Changed

- `DBType` gains an `MSSQL` member. Since `DBType` is a string enum, existing persisted values are unaffected.
- `mssql` (v12) is now a runtime dependency.

### Known Issues

- **SQL Server `IDENTITY` columns reject an explicit primary key.** `create({ id: 99 })` fails with *"Cannot insert explicit value for identity column in table 'x' when IDENTITY_INSERT is set to OFF"*, and `upsert({ id: 98 }, ["title"])` fails with *"Cannot update identity column 'id'"*. The cause is that the generated `MERGE` statement places the identity column in both the `UPDATE SET` list and the `INSERT` column list, and SQL Server permits neither. Letting the database assign the key works correctly on every path. A fix requires the upsert builder to skip identity columns in the `UPDATE SET` list and rely on `OUTPUT INSERTED.*` for the generated value; it is documented rather than patched here so that the behaviour change is not shipped silently in a minor release.
- **`create()` with a JSON object throws on SQLite.** The SQLite write path binds values as given, while MySQL and SQL Server encode explicitly, so an object value reaches `bun:sqlite` unencoded and it rejects it with *"Binding expected string, TypedArray, boolean, number, bigint or null"*. Passing a pre-stringified value works on all three.
- **Declared column `length`, `precision` and `scale` are not enforced** at write time - they appear in the generated DDL only, and SQLite ignores them entirely.
- **`getValidators()` reports only `required` and `unique`**; other validators run during `validate()` but are not reflected in that summary.
- **A `STRING` primary key is generated as `UUID PRIMARY KEY` on PostgreSQL** but as `VARCHAR(255)` / `NVARCHAR(255)` / `TEXT` on the other dialects, so the column types differ across dialects for the same model.

## [2.1.0] - 2026-04-02

### Added

- **CLI: db:backup** - Backup the database to a timestamped file. SQLite databases are copied directly; other databases export to JSON.
- **CLI: db:restore** - Restore the database from a backup file with confirmation prompt.
- **CLI: generate:api** - Generate a full REST API scaffold (CRUD routes) from a model definition.
- **CLI: migrate:fresh** - Drop all tables and re-run all migrations without seeding.
- **CLI: db:size** - Show database and table size statistics (file size, row counts, table sizes).
- **New examples**: `saas.ts` (multi-tenant SaaS), `cms.ts` (content management system), `analytics.ts` (event tracking and aggregations).
- Updated CLI banner with improved formatting and expanded `info` command output.
- Updated CLI, docs, and README with new commands and examples.

### Changed

- CLI version bumped to 2.1.0.
- Updated stabilize-docs hero badge from v1.3.0 to v2.1.0.
- Updated features component with Backup & Restore, API Generation, and Database Analytics features.
- Updated CLI documentation pages with all new commands.
- Expanded examples page with 6 new example cards (E-Commerce, REST API, Query Builder, Soft Deletes, Caching, Hooks).
- Updated main README with new examples section and expanded CLI documentation.

## [1.3.2] - 2025-10-19

### Added

- Added **Timestamps Configuration** feature for automatic management of `createdAt` and `updatedAt` columns (`types.ts`, `model.ts`, `repository.ts`, `migrations.ts`).
  - Added `TimestampsConfig` interface and `timestamps` property to `ModelConfig` in `types.ts`.
  - Added `getTimestamps` method to `MetadataStorage` in `model.ts`.
  - Updated `create`, `update`, `bulkCreate`, `bulkUpdate`, and `upsert` methods in `repository.ts` to set timestamps automatically.
  - Updated `migrations.ts` to include timestamp columns in schema generation.
  - Updated `README.md` with a new "Timestamps" section and example.

### Fixed

- Fixed TypeScript error (TS7053) in `repository.ts` for timestamps handling in `_create`, `_bulkCreate`, `_bulkUpdate`, and `_upsert` methods by using `Record<string, any>` for safe property access and maintaining `Partial<T>` type safety.

## [1.3.2] - 2025-10-19

### Added

- Added **Custom Query Scopes** feature, allowing reusable query conditions defined in model configurations (`types.ts`, `model.ts`, `query-builder.ts`, `repository.ts`).
  - Added `scopes` property to `ModelConfig` interface in `types.ts` to define scope functions.
  - Added `getScopes` method to `MetadataStorage` in `model.ts` to retrieve scope definitions.
  - Added `scope` method to `QueryBuilder` in `query-builder.ts` to apply scopes to queries.
  - Added `scope` method to `Repository` in `repository.ts` for direct scope application.
  - Updated `README.md` with a new "Custom Query Scopes" section and example.

## [1.3.0] - 2025-10-18

### Added

- Introduced programmatic `defineModel` API for model definitions, eliminating the need for decorators (`model.ts`).
- Added `MetadataStorage` class to manage model configurations without `reflect-metadata`.
- Added support for defining lifecycle hooks in `ModelConfig` or as class methods (`hooks.ts`).
- Added `example.ts` to demonstrate the new programmatic API usage.
- Extended `ModelConfig` interface to support columns, relations, hooks, versioning, and soft deletes (`types.ts`).

### Changed

- Replaced decorator-based model definitions with `defineModel` API, removing dependency on `reflect-metadata` and TypeScript experimental features (`experimentalDecorators`, `emitDecoratorMetadata`).
- Updated `stabilize.ts` to export `defineModel` and remove `reflect-metadata` import.
- Modified `repository.ts` to use `MetadataStorage` for table names, columns, relations, validators, and soft delete fields.
- Rewrote `hooks.ts` to support hooks via `ModelConfig` and class methods, integrated with `MetadataStorage`.
- Updated `migrations.ts` to generate schemas using `MetadataStorage` instead of decorator metadata.
- Revised `types.ts` to remove decorator-related types and add `ModelConfig`, `ColumnConfig`, and `RelationConfig` interfaces.
- Updated `README.md` to reflect the new programmatic API, remove decorator references, and update examples.
- Ensured compatibility with `verbatimModuleSyntax` by using `export type` for type exports in `stabilize.ts`.

### Removed

- Deleted `decorators.ts` as decorators are no longer used.
- Removed dependency on `reflect-metadata` from the project.

### Fixed

- Fixed TypeScript type errors in `repository.ts` for `columns` and `relations` by mapping `MetadataStorage` outputs to match expected types.
- Corrected `runHooks` in `repository.ts` to call `hook.callback(entity)` instead of `hook()`.
- Fixed TypeScript `verbatimModuleSyntax` error in `stabilize.ts` by separating type and value exports.

## [1.1.2] - 2025-10-14

### Added

- Improved repository QueryBuilder with chainable joins, advanced where clauses, and cache support.
- Added support for model decorators and repository pattern.
- New CLI features for migrations, seeds, rollback, and status.
- Security, funding, conduct, and contributing markdowns.
- More expressive README and docs.

### Changed

- Updated ORM configuration examples.
- Enhanced documentation for open source best practices.

### Fixed

- Various bug fixes for connection handling and retry logic.
