# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- Further features and improvements coming soon.

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
