# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- Further features and improvements coming soon.

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
