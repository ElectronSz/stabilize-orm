# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- Further features and improvements coming soon.

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