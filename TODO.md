# TODO

Ordered by dependency. `stabilize-orm@3.1.0` and `stabilize-cli@3.1.0` are both
published; everything below is what remains. The cross-runtime work in the first
section is **done and verified but not yet published** — it needs a version
number confirmed before `npm publish`, because a published version can never be
reused.

## Cross-runtime: the package loads on Node now

- [x] **`import { Stabilize } from "stabilize-orm"` threw on Node.** `client.ts`
      carried a static `import { Database, Statement } from "bun:sqlite"`, and
      `bun:sqlite` is a Bun-only builtin. The bundler inlined it, so
      `dist/index.js` held a `bun:` specifier that Node's ESM loader rejects with
      `ERR_UNSUPPORTED_ESM_URL_SCHEME` — at import time, before any connection
      opened. **PostgreSQL, MySQL, SQL Server and MongoDB were all unreachable on
      Node because of a SQLite import.** The coupling turned out to be one import
      and five call sites, all in `client.ts`: `bun:sqlite` was the only `bun:`
      reference in the tree and no `Bun.*` global was used anywhere.
- [x] **A second defect underneath the first: `--target bun`.** Fixing the import
      was not enough — the bundle still failed to load with `n is not a function`.
      `--target bun` inlines CommonJS dependencies with a Bun-only interop
      helper, and ioredis's `require("events")` compiled to `n("events")`, which
      is undefined once Node loads the ESM output. `--target node` is the fix and
      Bun runs the result unchanged. Isolated by building three variants against
      the same source: `--target node` with and without the sqlite externals both
      loaded (27 exports), `--target bun` failed. The externals were never
      load-bearing.
- [x] **`sqlite-driver.ts` resolves the driver at runtime.** `bun:sqlite` and
      `node:sqlite` each exist on exactly one runtime, so this cannot be one
      portable driver — it is two implementations behind one class. Resolution is
      synchronous (`createRequire(import.meta.url)` in a try/catch, each failure
      catchable), so `initializeClient` and the `DBClient` constructor keep their
      signatures; making it async would have rippled through every caller and
      undone the explicit reasoning about the MSSQL path. `SQLiteConnection` is a
      class, not a factory, because the client identifies its SQLite branch with
      `instanceof` in five places. `SQLiteStatement` is structural — a driver type
      in a public signature would make every consumer resolve a driver it may not
      run on, the same reasoning as `MSSQLHandle`/`MongoHandle`.
- [x] **Node's `DatabaseSync` deltas absorbed.** No `run()`, no `query()`, no
      `transaction()`. The first is supplied by the adapter; the third was never
      used, because the ORM already drives transactions with explicit
      `BEGIN`/`COMMIT`. `bun:sqlite` needs `{ create: true }` for a missing file
      and `node:sqlite` creates one on open with no such option, so `options` is
      Bun-only and is not passed on the Node path.
- [x] **Integers past 2^53 are exact on Node.** `setReadBigInts` is
      per-statement and **all-or-nothing** — probed, not assumed: turning it on
      up front would make every `id` column a bigint on Node while Bun kept
      returning numbers, a divergence on every row to cover a rare case. Instead
      the adapter leaves the driver at its default and catches
      `ERR_OUT_OF_RANGE` on the read, flips that one statement and retries.
      In range → `number`, identical to Bun; out of range → `bigint`, exact,
      where Bun silently returns a corrupted number. Documented in the README.
      Bun's truncation is left alone — it is `bun:sqlite`'s behaviour and cannot
      be fixed from here.
- [x] **`engines.node` corrected to `>=22.13.0`.** It claimed `>=18.0.0`, which
      was never true: `node:sqlite` does not exist in 18 or 20, and the package
      only loaded at all on Node because releases from 22.7 auto-detect ESM
      syntax in a `.js` file that has no `"type": "module"`. The description's
      unverified **Deno** claim is gone too.
- [x] **`scripts/verify-node-sqlite.mjs`** — the check that found the defect and
      the one that proves the fix. 15 checks against the **packed tarball**, run
      under both runtimes: dynamic import, `autoMigrate` (DDL plus `PRAGMA`
      introspection), `last_insert_rowid`, find, optimistic lock, count/findBy,
      JSON-as-text, upsert inside the SQLite transaction path, rollback, commit,
      delete, creating a missing file, reopening an existing one, and both
      integer cases. A symlinked `node_modules` is exactly how this class of
      defect stays hidden, so it must always run against the tarball.
- [x] **Gates.** `bun tsc --noEmit` clean; `bun test` **616 pass / 0 fail**
      across 33 files, matching baseline exactly — the existing SQLite suites are
      the proof the Bun path did not move, since the adapter is a passthrough
      there; build clean; no static `bun:` specifier in `dist/*.js` (the only
      occurrences are the string literal handed to `createRequire` and the error
      message text); no driver type in any published `.d.ts`
      (`dist/sqlite-driver.d.ts` has no imports at all, and both `DatabaseSync`
      mentions are inside doc comments). Packed tarball: **Node 15/0, Bun 14/0**
      plus an honest note that `bun:sqlite` reads `9007199254740993` back as
      `9007199254740992`.
- [ ] **Not published yet.** Needs a version confirmed out loud first.
- [ ] **The README edit needs its own release to reach the npm package page** —
      same constraint as the validation-list item below. Deno is also still
      unverified rather than disproven; nothing here tests it either way.

## Docs brought in line with the code

- [x] **Every docs page the ORM and CLI changes made stale.** The CLI Reference
      and CLI API pages said `v2.2.1` and now say `v3.0.0`, with the MongoDB
      behaviour described per command. The ORM changes had left a wider trail:
      the `length`/`precision`/`scale` section that said all three do nothing
      (they now set the width and bound the value), the SQLite "JSON cannot be
      written as an object" limitation (removed), both `cacheStatus`
      enumerations, the constructor signature and the `StabilizeEmitter`
      parameter, the security guide's "only two of nine events fire" box and its
      "a missing key throws" box, and the hooks example that subscribed to
      `connection:open` after the constructor that emits it. 16 files;
      `bunx tsc --noEmit` clean.
- [x] **The CLI overclaimed what `query` does on MongoDB.** Its README and the
      3.0.0 changelog entry both said `query` runs document commands. It does
      not — it warns that there is no SQL to run and points at `db:tables`,
      `db:table:info` and `db:console`. The source has always said so; only the
      docs were wrong. Corrected in the repo.

## Shipped in 3.1.0

Committed as `acd07a8` and published. 616 tests pass / 0 fail across 33 files,
`tsc --noEmit` clean, build clean, no type leak in `dist/*.d.ts`.

- [x] **`length`, `precision` and `scale` did nothing.** All three were declared
      on `ColumnConfig` and read by no one: the SQL type came from the
      `DataTypes` member alone, so `{ type: DataTypes.STRING, length: 50 }`
      emitted `VARCHAR(255)` on MySQL and a 200-character value was stored
      without complaint. Fixed in three parts — one column-aware type mapper
      (`mapDataTypeToSql`, now the single implementation the other two delegate
      to), write-time enforcement in `collectValidationErrors`, and
      `resolveDecimalCapacity` so the DDL and the check cannot disagree on the
      scale. `tests/column.capacity.test.ts`.
- [x] **A JSON object written to SQLite failed.** The object was not encoded on
      the SQLite path, and `bun:sqlite` binds a plain object as **NULL** —
      silently — while spreading an array as the parameter list and failing the
      statement. `bindSQLiteParams` mirrors the MySQL and SQL Server binders.
      Along the way: `sanitizeSqlValue` was discarding JSON on *every* backend,
      so a versioned model lost the field in its history table even on MySQL.
      `tests/sqlite.json.test.ts`.
- [x] **Seven of the nine declared events were never emitted.** `query`,
      `error`, `migration:start`, `migration:complete`, `transaction:start`,
      `transaction:complete` and `transaction:error` now fire, and the two that
      did — `connection:open`, `connection:close` — were rewired: the client
      used to build its own emitter, so nothing the client fired ever reached a
      handler registered on the ORM. `tests/events.test.ts`. Both `stabilize-docs`
      event pages rewritten: the amber "Only two of these are ever emitted" box
      and the seven-entry "Declared but never fired" list are gone, replaced by
      the real payloads, the three `error` phases, `migration:start`'s position,
      and a note that `connection:open` fires before you can subscribe.
- [x] **`redisUrl` is not optional in practice.** `CacheConfig.enabled: true`
      with no `redisUrl` built no client at all, and every method became a
      silent no-op — `get` returned null, `set` discarded, `getStats` reported
      zeros forever. You got no error and no caching, only the appearance of it.
      Fixed with `StabilizeKV`, an in-process key-value store whose API follows
      Cloudflare Workers KV (`get`/`put`/`delete`/`list`,
      `expiration`/`expirationTtl`, metadata, cursor pagination, LRU-bounded by
      `maxEntries`), which `Cache` now uses whenever there is no `redisUrl`.
      `Cache` was restructured around one `CacheStore` interface so the two
      backends cannot drift apart method by method. Also: `CacheStats.backend`
      and a `healthCheck()` that names the backend instead of reporting
      `in-memory` as `"connected"`. `tests/cache.test.ts`, and the
      `stabilize-docs` caching page rewritten to match — a new "The In-Process
      Backend" section stating what `StabilizeKV` is *not* (shared, durable,
      replicated), the `backend` field, `cacheStatus`, and `maxEntries`.
- [x] **Renamed the store to `StabilizeKV`.** It was `MemoryKV`, and the README
      introduced it as "Cloudflare-KV-shaped" — a description standing in for a
      name. The class, its seven exported types, the source file, the build
      entry, the `exports` subpath and the docs all say `StabilizeKV` now;
      Cloudflare Workers KV survives only as a stated influence on the API.
      Gates rerun: 601 tests pass / 0 fail across 33 files, `tsc --noEmit`
      clean, build clean, no type leak in `dist/stabilize-kv.d.ts`.

- [x] **The encryption key had to be supplied, and could not be rotated.**
      `ORM_ENCRYPTION_KEY` was the only source, and the ciphertext format
      `v2:<iv>:<tag>:<ct>` named no key — so changing the key made every
      existing row unreadable at once, with no way to hold two side by side.
      Now a key is looked for in `ORM_ENCRYPTION_KEY`, then a key file
      (`ORM_ENCRYPTION_KEY_FILE`, default `.stabilize/encryption.key`), which
      is **generated and stored 0600 when neither is present**. A generated key
      is written before it is used, and a path that cannot be written is fatal
      — a key held only in memory would orphan every value it encrypted at the
      next restart. `ORM_ENCRYPTION_KEYS_OLD` and the file's `retired` list
      hold keys that still decrypt. The format is now
      `v3:<keyId>:<iv>:<tag>:<ct>`, where the id is `sha256(key)` truncated —
      derived, not assigned, so a key moved between env and file keeps its
      identity and its rows. Legacy `v2:` and CBC values still read, by walking
      the ring. Also fixed, in the same two methods: **`processForLoad` read
      the wrong key**, indexing rows by property name while `SELECT *` returns
      them by column name, so an encrypted column that also declared `name:`
      was handed back as ciphertext. `.stabilize/` is gitignored.
      `tests/encryption.test.ts` (25 tests, including the rename case, which
      was confirmed to fail against the unfixed code).

## Blocked — waiting on something else

- [ ] **Nothing is blocked.** The docs push that was blocked here landed some
      time ago; the *new* docs changes are in Next, gated on the publish rather
      than on anything outside this repo.

## Next

- [x] **Push the docs.** Pushed as `895ca22..5405cd1` on `main`, which is what
      Vercel deploys from. Two commits: `3c9f5eb` (the sixteen files for the CLI
      and the `length`/`precision`/`scale` work) and `5405cd1` (the hero release
      line and the CLI pages moved to 3.1.0). `bunx tsc --noEmit` clean.
- [x] **`stabilize-orm@3.1.0` published.** `npm publish` reported
      `+ stabilize-orm@3.1.0` with the tarball at 13.9 MB packed / 59.5 MB
      unpacked across 71 files. **The registry had not begun serving it when
      this was written** — `dist-tags.latest` was still `3.0.0` and
      `versions` had no `3.1.0` entry ten minutes after the upload, from the
      registry API directly rather than a cached `npm view`. npm's own message
      is "your package is being processed and may take a few minutes to become
      available", so the version is claimed and immutable from the moment
      publish returns: it cannot be re-published, only waited on. The changes
      that can break a working project:
      - Postgres `DECIMAL` now emits `DECIMAL(10,2)` where it used to emit a bare
        `DECIMAL`. A bare Postgres `DECIMAL` stores whatever it is handed; the
        constrained form does not. A regenerated migration narrows the column,
        and a value over ten digits is now rejected rather than stored.
      - `length` / `precision` / `scale` are enforced. A column narrower than
        values already in it now rejects writes that previously succeeded.
      - `CacheStats` gained a **required** `backend` field.
      - v3 ciphertext is unreadable by older versions.
      - A missing encryption key generates one instead of throwing.
- [x] **`stabilize-cli@3.1.0` published** — submitted, and pending on the
      registry for the same reason as the ORM above. This is the release that
      changes the package page: the 3.0.0 tarball shipped the README committed
      before the `query` correction, and npm renders that file, so the page was
      wrong in a way only a republish could fix. The bundle is 3.50 MB, 4 files,
      1.0 MB packed, and it now carries the 3.1.0 ORM — so generated DDL changes
      for columns declaring `length`, `precision` or `scale`.
- [ ] **The README's validation list never learned about `length`.** It names
      `required`, `minLength`/`maxLength`, `pattern` and `customValidator` —
      not the three options that 3.1.0 made load-bearing. The `stabilize-docs`
      pages cover it properly, and the README is not *wrong*, but it is the file
      npm renders, so it needs a release of its own to reach the package page.
      Left alone deliberately rather than edited after the publish: an edit now
      would put repo HEAD and the published tarball out of step, which is the
      problem this release existed to fix.
- [ ] **The CLI builds against a symlink, not the registry.** Its
      `node_modules/stabilize-orm` is a symlink to this checkout
      (`/c/Users/offby/Documents/Research/stabilize`), so `bun run build` bundles
      whatever is in the working tree — which is how the CLI embedded 3.1.0
      before 3.1.0 was on npm. Convenient, and it is also how an uncommitted ORM
      edit reaches a published CLI bundle without anyone deciding it should. The
      declared `stabilize-orm: ^3.0.0` resolves from the registry on any other
      machine, so the two paths can disagree.
- [ ] **Decide whether to merge `chages` into `main`.** `chages` is 9 commits
      ahead of `origin/main` and 1 behind it. The MongoDB backend and every
      release since 2.2.0 exist on `chages` only, so GitHub's default branch has
      no MongoDB work at all. `chages` itself is pushed.
- [ ] **Optionally tag `v3.0.0` and `v3.1.0`.** Tags stop at `1.3.0` — no `v2.x`
      was ever tagged despite two point releases shipping, so this convention is
      already inconsistent.

## Then — the CLI

- [x] **M10: MongoDB support in `stabilize-cli`.** Done and verified end to end
      against the replica set.
- [x] **The CLI reported a version npm had never published.** Its banner and
      `diagnose` printed a hard-coded `const version = "2.2.0"` while the
      manifest said `2.2.1`. The constant is now `pkg.version`, read from
      `package.json` and inlined by the bundler, so the two cannot drift again.
      `--help` prints `v2.2.1`.
- [x] **The CLI's manifest pointed at the wrong repository.**
      `repository`, `homepage` and `bugs` all said `ElectronSz/stabilize-orm`
      — so npm's "Repository" link on the package page led to a different
      project. Now `ElectronSz/stabilize-cli` throughout.
- [x] **The CLI declared a stale ORM dependency.** `stabilize-orm: ^2.0.0`
      excludes the 3.0.0 that is installed and published; now `^3.0.0`.
      `bun test` passes, `tsc --noEmit` clean, build clean.
- [ ] **Bump and publish `stabilize-cli`.** Separate npm package, currently at
      2.2.1. Commit first, then confirm the version out loud, then publish.
- [ ] **Clean the CLI's smoke-test residue** left by verifying M10 — `api/`,
      `app.db`, `backups/`, `config/`, `migrations/`, `models/`, `seeds/`.
      Deferred: `config/` was never tracked (`git ls-files config/` is empty and
      `git log --all -- config/database.ts` is empty), so "restore
      `config/database.ts`" has no tracked original to restore from. Deciding
      this and the item below is one decision, not two.
- [ ] **Decide what to do with the CLI's untracked scratch directories.**
      `api/`, `app.db`, `backups/`, `config/`, `migrations/`, `models/` and
      `seeds/` are the CLI's own dogfooding output (generated model stubs, a
      SQLite file, backup artifacts), not CLI source. They were deliberately left
      untracked rather than committed or gitignored unilaterally.

## Flagged, deliberately not fixed

- [ ] **SQL `rollback` takes `rows[0]` with no `ORDER BY`** over a non-unique
      `(id, version)` — a delete records the row's current version, so two
      history rows can share a number. The two carry identical column values, so
      no failure scenario could be constructed: fragile, not demonstrably broken.
- [ ] **A hand-written `qb.lock()` bypasses the warning.** `Repository.lockForUpdate`
      warns on MongoDB; a `qb.lock()` passed straight to `execute()` is still
      walked past in silence. Documented in the docblock and README.
- [ ] **`DataTypes.JSON` reads back asymmetrically.** Postgres and MySQL drivers
      parse a JSON column into a value; MariaDB (JSON is a `LONGTEXT` alias),
      SQL Server and now SQLite hand back the text the ORM wrote. The ORM never
      calls `JSON.parse` on load. Unifying it touches four read paths and the two
      tests that assert the asymmetry today.
- [ ] **`node:sqlite` returns rows with a null prototype.** `bun:sqlite` returns
      ordinary objects. `isPlainJsonValue` (`client.ts:123`) decides by
      prototype, so a row read on Node is a plain JSON value where the same row
      on Bun is not — a difference in the *input* to that predicate, on every
      read, that no test currently names. Left alone rather than normalized:
      normalizing rows on every read would be a real cost paid against a failure
      nobody has demonstrated, and the checks that would trip over it if it
      mattered — read-then-write in `update`, the upsert round-trip, the JSON
      column round-trip — all pass on Node (15/0). Flagged as a latent
      divergence, not a bug.
- [ ] **The CLI has no `-V, --version`.** `--version` is rejected as an unknown
      option; the version is only visible in the banner and in `info`. Every
      other command has `-h, --help`. Adding `program.version(version)` is one
      line, but it is a new flag rather than a fix, so it is flagged rather than
      added unilaterally.

## Done

- [x] **Key generation verified end to end.** In a clean directory with no
      `ORM_ENCRYPTION_KEY` and no key file, the first `encrypt()` call created
      `.stabilize/encryption.key` containing
      `{"active": "<64 hex>", "retired": []}`, emitted the
      `STABILIZE_ENCRYPTION_KEY_GENERATED` warning, and round-tripped its
      ciphertext back to the original value. The id inside the ciphertext
      matched `activeKeyId()`. Two caveats worth knowing: generation is **lazy**
      — it happens on first use, not at `npm install` — and the file's mode is
      `0600` only where the filesystem honours POSIX mode bits. On Windows it
      lands as `0644`, so the file is exactly as private as its directory.
- [x] Docs homepage and MongoDB page brought up to date, pushed to
      `github.com/ElectronSz/stabilize-docs`. Includes the Next.js 15.5.25
      upgrade, rebased onto Vercel's own CVE fix.
- [x] MongoDB backend, milestones M5–M9: write path, relations, versioning,
      escape hatches. 528 tests pass / 0 fail, 29 files.
- [x] `aggregate()` on an empty collection — `$group` over no input yields no
      document, so the count came back `undefined` rather than `0`.
- [x] Delete journalling on MongoDB — recording the row's current version
      collided with the row it was journalling (version is half the compound
      `_id`) and failed the delete it was meant to record.
- [x] `lockForUpdate` now warns instead of silently taking no lock.
- [x] `stabilize-orm@3.0.0` published and verified on the registry.
- [x] `stabilize-cli@2.2.1` source recovered into git (`f96cda6`) and pushed —
      it had been live on npm while sitting in no commit at all.
- [x] `stabilize-cli` **untracked** from the ORM repo (`f6f9fe2`). It was briefly
      a real submodule (`4cdc64b`), then reverted: the pointer only ever recorded
      a commit already pushed to the CLI's own remote, so it cost a second commit
      per CLI change for no gain. The directory is now gitignored, matching how
      `stabilize-docs` is handled.
- [x] `chages` pushed to GitHub through `4cdc64b`.
