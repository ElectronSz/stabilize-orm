/**
 * @file repository.ts
 * @description Provides a data access layer for a specific model, handling all CRUD operations.
 * @author ElectronSz
 */

import { Cache } from "./cache";
import { DBClient } from "./client";
import { StabilizeLogger, type Logger } from "./logger";
import { QueryBuilder } from "./query-builder";
import {
  DataTypes,
  DBType,
  RelationType,
  StabilizeError,
  type CacheConfig,
} from "./types";
import { MetadataStorage } from "./model";
import { getHooks, type HookType } from "./hooks";
import { decrypt, encrypt } from "./utils/encryption";
import {
  mongoBulkCreate,
  mongoCreate,
  type MongoRepositoryHost,
} from "./mongo-repository";

type VersionOperation = "insert" | "update" | "delete";

/**
 * The property name a model's primary key is declared under.
 *
 * A convention rather than metadata: `ColumnConfig` carries no primary-key flag,
 * so `id` is the key by definition across every backend.
 */
const ID_PROPERTY = "id";

/**
 * How many key values go into one `IN (…)` when a relation is loaded.
 *
 * Relations are loaded with a single batched query per relation, so a
 * `findMany` over ten thousand parents would otherwise build an `IN` list that
 * long — past SQLite's default parameter limit, and past `max_allowed_packet`
 * on MySQL.
 */
const RELATION_BATCH_SIZE = 500;

/**
 * Coerces a value into what the dialect's driver will accept as a parameter.
 *
 * A `Date` is the interesting case. SQLite rejects a raw `Date` at bind time,
 * so leaving one in place fails outright; PostgreSQL's `TIMESTAMP` accepts ISO,
 * and SQL Server's `DATETIME2` parses it. MySQL and MariaDB do not — their
 * `DATETIME` under `STRICT_TRANS_TABLES` (the default on both) refuses the
 * `T` and the `Z` of an ISO string with "Incorrect datetime value", so every
 * write on those servers would fail. The space-separated, second-resolution
 * spelling is what the whole MySQL family takes, and a `DATETIME` column is
 * second-resolution by default anyway, so nothing is lost in the slice.
 *
 * Booleans become 1/0 because none of the dialects the library supports has a
 * real boolean parameter type, and anything else that is not directly bindable
 * (an object, a function) becomes NULL rather than reaching the driver and
 * failing the statement.
 *
 * @param val The value to coerce.
 * @param dbType The dialect the value is bound for.
 * @returns A value the driver can bind.
 */
function sanitizeSqlValue(
  val: any,
  dbType: DBType,
): string | number | boolean | bigint | null {
  if (val === undefined) return null;
  if (val instanceof Date) {
    if (dbType === DBType.MySQL) {
      return val.toISOString().slice(0, 19).replace("T", " ");
    }
    return val.toISOString();
  }
  if (typeof val === "boolean") return val ? 1 : 0;
  if (
    typeof val === "string" ||
    typeof val === "number" ||
    typeof val === "bigint"
  )
    return val;
  return null;
}

/** Splits values into `size`-long chunks. */
function chunked<V>(values: V[], size: number): V[][] {
  if (values.length <= size) return [values];
  const chunks: V[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

/**
 * The distinct, non-null values of `key` across `rows`, preserving order.
 *
 * Used to collect the keys a relation lookup should match on. Null keys are
 * dropped: a parent with no foreign key has no related row, and `IN (NULL)`
 * never matches anything anyway.
 */
function distinctKeys(rows: Record<string, any>[], key: string): any[] {
  const seen = new Set<any>();
  for (const row of rows) {
    const value = row?.[key];
    if (value === null || value === undefined) continue;
    seen.add(value);
  }
  return [...seen];
}

/**
 * Builds the T-SQL statement an upsert has to use.
 *
 * SQL Server supports neither `ON CONFLICT … DO UPDATE` nor
 * `ON DUPLICATE KEY UPDATE`; the equivalent is `MERGE`. The payload is offered
 * as a one-row `source` table whose columns are the bound parameters, and the
 * `WHEN MATCHED` / `WHEN NOT MATCHED` branches then refer to those columns by
 * name — so every value is bound exactly once, on the `USING` line, however
 * many times the column is referenced afterwards.
 *
 * `OUTPUT INSERTED.*` is the T-SQL analogue of `RETURNING *`, and tells the
 * caller which row the statement produced on either branch.
 *
 * Pure, and exported, so the rendered statement can be asserted without a
 * server.
 *
 * @param table The table to merge into.
 * @param columnNames The columns being written, in binding order.
 * @param keyColumns The columns that decide whether a row already exists.
 * @returns The `MERGE` statement, whose placeholders number one per column.
 */
export function buildMSSQLUpsertSQL(
  table: string,
  columnNames: string[],
  keyColumns: string[],
): string {
  if (keyColumns.length === 0) {
    // With nothing to match on there is no row a `MERGE` could resolve
    // against, so the statement can only ever insert.
    return `INSERT INTO ${table} (${columnNames.join(", ")}) OUTPUT INSERTED.* VALUES (${columnNames.map(() => "?").join(", ")})`;
  }

  const source = `SELECT ${columnNames.map((c) => `? AS ${c}`).join(", ")}`;
  const on = keyColumns.map((c) => `target.${c} = source.${c}`).join(" AND ");
  const updates = columnNames.filter((c) => !keyColumns.includes(c));
  const matched =
    updates.length === 0
      ? ""
      : `\nWHEN MATCHED THEN UPDATE SET ${updates
          .map((c) => `target.${c} = source.${c}`)
          .join(", ")}`;
  const notMatched = `\nWHEN NOT MATCHED THEN INSERT (${columnNames.join(
    ", ",
  )}) VALUES (${columnNames.map((c) => `source.${c}`).join(", ")})`;

  // A `MERGE` statement has to be terminated by a semicolon.
  return `MERGE INTO ${table} AS target\nUSING (${source}) AS source\nON (${on})${matched}${notMatched}\nOUTPUT INSERTED.*;`;
}

export class Repository<T> {
  private client: DBClient;
  private cache: Cache | null;
  private table: string;
  private columns: Record<
    string,
    {
      name: string;
      type: string;
      required?: boolean;
      unique?: boolean;
      minLength?: number;
      maxLength?: number;
      pattern?: RegExp;
      customValidator?: (val: any) => boolean | string;
      encrypted?: boolean;
      softDelete?: boolean;
      optimisticLock?: boolean;
    }
  >;
  private validators: Record<string, string[]>;
  private relations: Record<
    string,
    {
      type: RelationType;
      targetModel: () => any;
      foreignKey?: string;
      inverseKey?: string;
      joinTable?: string;
    }
  >;
  private softDeleteField: string | null;
  private logger: Logger;
  private versioned: boolean;
  private historyTable: string;
  private model: new (...args: any[]) => T;
  private optimisticLockField: string | null;
  private autoIncrementField: string | null;
  private timestampsConfig: { createdAt?: string; updatedAt?: string } | null;

  constructor(
    client: DBClient,
    model: new (...args: any[]) => T,
    cacheConfig: CacheConfig = { enabled: false, ttl: 60 },
    logger: Logger = new StabilizeLogger(),
    sharedCache?: Cache | null,
  ) {
    this.client = client;
    // A caller that already owns a cache passes it in. Otherwise every
    // repository built one of its own — a second Redis connection that nothing
    // ever disconnected and that `getCacheStats()` never looked at, because it
    // reports on the ORM's own cache instance.
    this.cache =
      sharedCache ??
      (cacheConfig.enabled ? new Cache(cacheConfig, logger) : null);
    this.table = MetadataStorage.getTableName(model);
    this.columns = Object.fromEntries(
      Object.entries(MetadataStorage.getColumns(model)).map(([key, col]) => [
        key,
        {
          name: col.name ?? key,
          type: typeof col.type === "string" ? col.type : DataTypes[col.type],
          required: col.required,
          unique: col.unique,
          minLength: col.minLength,
          maxLength: col.maxLength,
          pattern: col.pattern,
          customValidator: col.customValidator,
          encrypted: col.encrypted,
          softDelete: col.softDelete,
          optimisticLock: col.optimisticLock,
        },
      ])
    );
    this.relations = Object.fromEntries(
      Object.entries(MetadataStorage.getRelations(model)).map(([key, rel]) => [
        key,
        {
          type: rel.type,
          targetModel: rel.target,
          foreignKey: rel.foreignKey,
          inverseKey: rel.inverseKey,
          joinTable: rel.joinTable,
        },
      ]),
    );
    this.validators = MetadataStorage.getValidators(model);
    this.softDeleteField = MetadataStorage.getSoftDeleteField(model);
    this.optimisticLockField = this.getOptimisticLockField(model);
    this.autoIncrementField = this.getAutoIncrementField();
    this.timestampsConfig = MetadataStorage.getTimestamps(model);
    this.logger = logger;
    this.versioned = MetadataStorage.isVersioned(model);
    this.historyTable = `${this.table}_history`;
    this.model = model;
  }

  /**
   * Builds the cache key under which a single row is stored.
   *
   * A `findOne` that eager-loads relations returns a different shape from one
   * that does not, so the relation set is part of the key. The set is sorted so
   * that the same relations requested in a different order share one entry, and
   * the no-relations case gets the bare key rather than a `:undefined` suffix —
   * the suffix that previously made every write-through `set` and every
   * `invalidate` address a key that no read ever looked up.
   */
  private rowCacheKey(
    id: number | string,
    relations?: string[],
  ): string {
    const base = `findOne:${this.table}:${id}`;
    if (!relations || relations.length === 0) return base;
    return `${base}:${[...relations].sort().join(",")}`;
  }

  /**
   * Invalidates every cached copy of a row: the bare key plus each
   * relation-loaded variant, which differ only by a suffix.
   */
  private async invalidateRowCache(id: number | string): Promise<void> {
    if (!this.cache) return;
    const base = `findOne:${this.table}:${id}`;
    await this.cache.invalidate([base, `find:${this.table}`]);
    await this.cache.invalidatePattern(`${base}:*`);
    // List/lookup queries for this table may embed the row too.
    await this.cache.invalidatePattern(`find:${this.table}:*`);
  }

  /**
   * Clears every cached entry for this table.
   *
   * Multi-row writes (bulk update/delete, `deleteWhere`, `truncate`) cannot
   * enumerate the affected ids, so the per-row entries have to go too —
   * otherwise a bulk update leaves `findOne` serving the pre-update row.
   */
  private async invalidateTableCache(): Promise<void> {
    if (!this.cache) return;
    await this.cache.invalidate([`find:${this.table}`]);
    await this.cache.invalidatePattern(`find:${this.table}:*`);
    await this.cache.invalidatePattern(`findOne:${this.table}:*`);
  }

  /** Writes a row through to the cache (no-op unless strategy is write-through). */
  private async writeThroughRow(id: number | string, row: any): Promise<void> {
    if (!this.cache) return;
    if (this.cache.getStrategy() !== "write-through") return;
    // Cache the plain shape: a write-through row was not loaded with relations,
    // so it must not occupy a relation variant's key.
    await this.cache.set(this.rowCacheKey(id), [row], 60);
  }

  private getOptimisticLockField(model: Function): string | null {
    for (const [key, col] of Object.entries(
      MetadataStorage.getColumns(model),
    )) {
      if (col.optimisticLock) return key;
    }
    return null;
  }

  /**
   * Finds the auto-incrementing primary key, if the model has one.
   *
   * The database generates this value, so `create()` must not require it from
   * the caller. A string/UUID primary key is supplied by the caller and stays
   * required. Mirrors the primary-key handling in `generateMigration`.
   */
  private getAutoIncrementField(): string | null {
    const idColumn = this.columns["id"];
    if (!idColumn) return null;
    const type = String(idColumn.type).toUpperCase();
    if (type === "STRING" || type === "TEXT" || type === "UUID") return null;
    return "id";
  }

  /**
   * The SQL column backing the soft-delete property.
   *
   * A column may carry a `name` that differs from its property key, and rows
   * read back from the database are keyed by SQL name. Interpolating the
   * property key into a query therefore fails with "no such column" whenever
   * the column is renamed.
   */
  private get softDeleteColumn(): string | null {
    return this.softDeleteField
      ? (this.columns[this.softDeleteField]?.name ?? this.softDeleteField)
      : null;
  }

  /** True when any column of this model is encrypted. */
  private get hasEncryptedColumns(): boolean {
    return Object.values(this.columns).some((col) => col.encrypted);
  }

  /** The SQL column backing the optimistic-lock property. @see softDeleteColumn */
  private get optimisticLockColumn(): string | null {
    return this.optimisticLockField
      ? (this.columns[this.optimisticLockField]?.name ??
          this.optimisticLockField)
      : null;
  }

  private getDBType(_client?: DBClient): DBType {
    const client = _client || this.client;
    return client.config.type;
  }

  /**
   * The trailing clause that keeps a statement to a single row.
   *
   * T-SQL has no `LIMIT`. The history queries below always order their rows, so
   * the `OFFSET … FETCH NEXT` pair — which requires an `ORDER BY` — is enough,
   * with no need for the constant `ORDER BY (SELECT NULL)` a bare limit needs.
   */
  private topOneClause(client: DBClient): string {
    return this.getDBType(client) === DBType.MSSQL
      ? " OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY"
      : " LIMIT 1";
  }

  /**
   * Collects every validation failure in `entity`, at most one per column.
   *
   * Shared by {@link validate}, which needs only the first failure, and
   * {@link validateAll}, which needs all of them.
   */
  private collectValidationErrors(
    entity: Partial<T>,
    skipRequired: boolean = false,
  ): string[] {
    const errors: string[] = [];
    // Iterate the column map rather than the validator rules: every column is
    // guaranteed to be present here, so a column carrying only a length,
    // pattern or custom validator is still checked.
    for (const [key, column] of Object.entries(this.columns)) {
      const value = (entity as any)[key];
      const rules = this.validators[key] ?? [];

      if (
        !skipRequired &&
        key !== this.autoIncrementField &&
        (column.required || rules.includes("required")) &&
        (value === undefined || value === null)
      ) {
        errors.push(`Field ${key} is required`);
        continue;
      }

      if (value === undefined || value === null) continue;

      if (
        column.minLength &&
        typeof value === "string" &&
        value.length < column.minLength
      ) {
        errors.push(`Field ${key} too short`);
        continue;
      }

      if (
        column.maxLength &&
        typeof value === "string" &&
        value.length > column.maxLength
      ) {
        errors.push(`Field ${key} too long`);
        continue;
      }

      if (
        column.pattern &&
        typeof value === "string" &&
        !column.pattern.test(value)
      ) {
        errors.push(`Field ${key} does not match pattern`);
        continue;
      }

      if (typeof column.customValidator === "function") {
        const result = column.customValidator(value);
        if (result !== true) {
          errors.push(result as string);
        }
      }
    }
    return errors;
  }

  private validate(entity: Partial<T>, skipRequired: boolean = false) {
    const [first] = this.collectValidationErrors(entity, skipRequired);
    if (first) {
      // The first failure only: a write has nothing to do with the rest.
      throw new StabilizeError(first, "VALIDATION_ERROR");
    }
  }

  /**
   * Validates an entity against the model's column rules and returns every
   * failure, rather than throwing on the first one.
   *
   * `validate` stops at the first problem, which is what a write wants, but a
   * caller validating a form wants the whole list instead of discovering one
   * bad field per round trip.
   *
   * @param entity The values to check.
   * @param skipRequired Skip the `required` rules, as an update does.
   * @returns One message per invalid column; empty when the entity is valid.
   * @example
   * ```
   * const errors = repo.validateAll({ email: "nope" });
   * if (errors.length) res.status(422).json({ errors });
   * ```
   */
  validateAll(entity: Partial<T>, skipRequired: boolean = false): string[] {
    return this.collectValidationErrors(entity, skipRequired);
  }

  private async runHooks(entity: any, type: HookType): Promise<void> {
    // The model is passed explicitly rather than inferred from the entity:
    // `after*` hooks are handed a row read back from the database, whose
    // prototype is `Object.prototype`, so the metadata lookup failed and the
    // hooks never ran.
    for (const hook of getHooks(entity, type, this.model)) {
      await hook.callback(entity);
    }
  }

  /**
   * Wraps a row read from the database in a model instance.
   *
   * Hooks receive entities, and class-method hooks (`async afterCreate() {}`)
   * only resolve on a real instance, so a plain row is not enough.
   */
  private hydrate<R>(row: R | null): R {
    if (row === null || row === undefined) return row as R;
    return Object.assign(new this.model() as any, row) as R;
  }

  /**
   * Merges a hook-mutated instance back into the payload that will be written.
   *
   * A key is carried over when the caller supplied it, when a hook introduced
   * it, or when a hook changed it. A key the hook left alone is skipped: it
   * came from the existing row, which was decrypted on read, so writing it
   * back would store plaintext in an encrypted column.
   */
  private mergeHookOutput<R extends Record<string, any>>(
    payload: R,
    instance: any,
    previous: Record<string, any> | null,
  ): R {
    const merged: Record<string, any> = { ...payload };
    for (const key of Object.keys(instance)) {
      if (!this.columns[key]) continue;
      if (key in payload) {
        merged[key] = instance[key];
        continue;
      }
      if (previous && key in previous && instance[key] === previous[key]) {
        continue;
      }
      merged[key] = instance[key];
    }
    return merged as R;
  }

  /** The model's primary-key property. */
  private get primaryKeyField(): string {
    return "id";
  }

  /** The SQL column backing the primary key. @see softDeleteColumn */
  private get primaryKeyColumn(): string {
    return this.columns[this.primaryKeyField]?.name ?? this.primaryKeyField;
  }

  /**
   * Attaches the decrypting row transform to a builder owned by this
   * repository.
   *
   * Applied wherever a builder is created rather than inside one hand-picked
   * method, so `findBy`, `first`, `paginate`, `pluck`, `findDeleted` and the
   * rest all return plaintext instead of ciphertext.
   */
  private withRowTransform(qb: QueryBuilder<T>): QueryBuilder<T> {
    if (this.hasEncryptedColumns) {
      qb.rowTransform = (rows) => rows.map((row) => this.processForLoad(row));
    }
    return qb;
  }

  find(): QueryBuilder<T> {
    const qb = new QueryBuilder<T>(this.table);
    // `execute` stamps the dialect too, but a builder handed to `union` or
    // `whereExists` is rendered while it is being attached — before any client
    // is in sight — so it has to know the dialect from the outset.
    qb.withDialect(this.client.config.type);
    if (this.softDeleteField) {
      qb.whereNull(`${this.table}.${this.softDeleteColumn}`);
    }
    // Lets `find().withRelations(...)` work: the builder records the paths and
    // calls back here to load them, since only the repository has the model
    // metadata and the relation queries.
    qb.relationLoader = (rows, relations, client) =>
      this.loadRelations(rows, relations, client);
    return this.withRowTransform(qb);
  }

  scope(name: string, ...args: any[]): QueryBuilder<T> {
    this.logger.logDebug(`Applying scope ${name} to ${this.table}`);
    return this.find().scope(name, ...args);
  }

  async findOne(
    id: number | string,
    options: { relations?: string[] } = {},
    _client?: DBClient,
  ): Promise<T | null> {
    const client = _client || this.client;
    const start = performance.now();
    this.logger.logDebug(`Finding one ${this.table} with ID ${id}`);
    const cacheKey = this.rowCacheKey(id, options.relations);
    // `execute` applies the row transform from `find()` (so the rows arrive
    // decrypted) and calls back into `loadRelations` before writing the cache,
    // so a cached entry holds the relations a later hit is asked for.
    const result = await this.find()
      .whereEq(`${this.table}.id`, id)
      .limit(1)
      .withRelations(options.relations ?? [])
      .execute(client, this.cache!, cacheKey);

    this.logger.logDebug(
      `Found ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return result[0] || null;
  }

  async asOf(
    id: number | string,
    asOfDate: Date,
    _client?: DBClient,
  ): Promise<T | null> {
    if (!this.versioned)
      throw new StabilizeError("Model is not versioned", "VERSIONING_ERROR");
    const client = _client || this.client;
    // Bind an ISO string rather than the `Date` itself: SQLite rejects a Date
    // as a parameter, so every `asOf` call used to throw there, and the
    // history timestamps are written as ISO strings anyway.
    const at = asOfDate instanceof Date ? asOfDate.toISOString() : asOfDate;
    const rows = await client.query<T>(
      `SELECT * FROM ${this.historyTable} WHERE id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY version DESC${this.topOneClause(client)}`,
      [id, at, at],
    );
    return rows[0] || null;
  }

  async history(id: number | string, _client?: DBClient): Promise<T[]> {
    if (!this.versioned)
      throw new StabilizeError("Model is not versioned", "VERSIONING_ERROR");
    const client = _client || this.client;
    return client.query<T>(
      `SELECT * FROM ${this.historyTable} WHERE id = ? ORDER BY version ASC`,
      [id],
    );
  }

  async rollback(
    id: number | string,
    version: number,
    _client?: DBClient,
  ): Promise<T> {
    if (!this.versioned)
      throw new StabilizeError("Model is not versioned", "VERSIONING_ERROR");
    const client = _client || this.client;
    return client.transaction(async (txClient) => {
      const rows = await txClient.query<T>(
        `SELECT * FROM ${this.historyTable} WHERE id = ? AND version = ?${this.topOneClause(txClient)}`,
        [id, version],
      );
      if (!rows.length)
        throw new StabilizeError("Version not found", "ROLLBACK_ERROR");

      const entity = rows[0];
      const columns = Object.keys(this.columns).filter((c) => c !== "id");
      const setClause = columns
        .map((c) => `${this.columns[c]!.name} = ?`)
        .join(", ");
      const params = columns.map((c) => (entity as any)[c]);

      await txClient.query(
        `UPDATE ${this.table} SET ${setClause} WHERE id = ?`,
        [...params, id],
      );
      await this.writeHistory(
        { ...entity, version: version + 1 },
        "update",
        txClient,
      );
      return this.findOne(id, {}, txClient) as Promise<T>;
    });
  }

  private async writeHistory(
    entity: any,
    operation: VersionOperation,
    client: DBClient,
    user?: string,
  ) {
    if (!this.versioned) return;

    const propertyKeys = Object.keys(this.columns);
    const sqlColumnNames = propertyKeys.map((k) => this.columns[k]!.name);

    const historyColumns = [
      ...sqlColumnNames,
      "operation",
      "version",
      "valid_from",
      "valid_to",
      "modified_by",
      "modified_at",
    ];

    const dbType = client.config.type;
    const values = propertyKeys.map((k) =>
      sanitizeSqlValue(entity?.[k], dbType),
    );
    const params = [
      ...values,
      sanitizeSqlValue(operation, dbType),
      sanitizeSqlValue(entity.version || 1, dbType),
      sanitizeSqlValue(new Date(), dbType),
      sanitizeSqlValue(null, dbType),
      sanitizeSqlValue(user || "system", dbType),
      sanitizeSqlValue(new Date(), dbType),
    ];

    let placeholders: string;
    if (client.config.type === DBType.Postgres) {
      placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
    } else {
      placeholders = params.map(() => "?").join(", ");
    }

    await client.query(
      `INSERT INTO ${this.historyTable} (${historyColumns.join(", ")}) VALUES (${placeholders})`,
      params,
    );
  }

  async create(
    entity: Partial<T>,
    options: { relations?: string[] } = {},
    _client?: DBClient,
  ): Promise<T> {
    return (_client || this.client).transaction(async (txClient) => {
      const instance = new this.model() as T;
      Object.assign(instance as object, entity);

      await this.runHooks(instance, "beforeCreate");
      await this.runHooks(instance, "beforeSave");

      // Insert the hook-mutated instance rather than the argument. A
      // `beforeCreate` that fills in a slug or normalises a field had its work
      // discarded, because the original payload was what got written.
      const result = await this._create(instance as Partial<T>, options, txClient);

      const hydrated = this.hydrate(result);
      await this.runHooks(hydrated, "afterCreate");
      await this.runHooks(hydrated, "afterSave");

      await this.writeHistory(hydrated, "insert", txClient);

      // The option was accepted and then ignored, so a caller asking for a
      // relation got the bare row back with no error to explain it.
      await this.loadRelations([hydrated], options.relations, txClient);
      return hydrated;
    });
  }

  /**
   * Fills in the columns a create writes that the caller did not supply.
   *
   * Shared by the SQL and MongoDB insert paths, so the two cannot drift on
   * which defaults a new row carries.
   *
   * @param entity The entity as the create hooks left it.
   * @returns A copy carrying the seeded timestamps and optimistic lock.
   */
  private seedCreateDefaults(entity: Partial<T>): Record<string, any> {
    const timestamps = this.timestampsConfig;
    const row = { ...entity } as Record<string, any>;
    if (timestamps?.createdAt && !row[timestamps.createdAt]) {
      row[timestamps.createdAt] = new Date().toISOString();
    }
    if (timestamps?.updatedAt && !row[timestamps.updatedAt]) {
      row[timestamps.updatedAt] = new Date().toISOString();
    }
    // Seed the optimistic lock so the first `update()` has a version to match
    // on; without this the column stays NULL and `version = NULL` never
    // matches, which makes every update look like a conflict.
    if (
      this.optimisticLockField &&
      row[this.optimisticLockField] === undefined
    ) {
      row[this.optimisticLockField] = 1;
    }
    return row;
  }

  /**
   * The repository's own members, narrowed to what the MongoDB write bodies
   * need. Built here rather than handed over as `this` because most of what
   * they reach for is private, and because the object literal is a single
   * readable list of exactly what the Mongo path depends on.
   */
  private get mongoCtx(): MongoRepositoryHost {
    return {
      table: this.table,
      columns: this.columns,
      idProperty: ID_PROPERTY,
      idColumn: this.columns[ID_PROPERTY]?.name ?? ID_PROPERTY,
      autoIncrementField: this.autoIncrementField,
      logger: this.logger,
      validate: (entity) => this.validate(entity),
      seedCreateDefaults: (entity) => this.seedCreateDefaults(entity as Partial<T>),
      processForSave: (entity) => this.processForSave(entity),
      processForLoad: (row) => this.processForLoad(row),
      findOne: (id, options, client) => this.findOne(id, options, client),
      loadRelations: (rows, relations, client) =>
        this.loadRelations(rows, relations, client),
      invalidateRowCache: (id) => this.invalidateRowCache(id),
      invalidateTableCache: () => this.invalidateTableCache(),
      writeThroughRow: (id, row) => this.writeThroughRow(id, row),
    };
  }

  private async _create(
    entity: Partial<T>,
    options: { relations?: string[] },
    client: DBClient,
  ): Promise<T> {
    if (this.getDBType(client) === DBType.MongoDB) {
      return mongoCreate(this.mongoCtx, entity as Record<string, any>, options, client) as Promise<T>;
    }

    const start = performance.now();
    this.logger.logDebug(
      `Creating ${this.table} with data: ${JSON.stringify(entity)}`,
    );
    this.validate(entity);

    const entityWithTimestamps = this.seedCreateDefaults(entity);

    // Encrypt after the timestamp and lock columns are in place, so everything
    // bound below passes through the same coercion.
    const entityToSave = this.processForSave(entityWithTimestamps);
    Object.assign(entityWithTimestamps, entityToSave);

    const keys = Object.keys(entityWithTimestamps).filter(
      (k) => this.columns[k],
    );
    const columnNames = keys.map((k) => this.columns[k]?.name).join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const params = keys.map((k) => (entityWithTimestamps as any)[k]);
    const dbType = this.getDBType(client);

    // `OUTPUT INSERTED.*` is the T-SQL spelling of `RETURNING *`, but the two
    // do not sit in the same place: `RETURNING` trails the statement, whereas
    // T-SQL wants `OUTPUT` between the column list and `VALUES`. Appending it
    // is a syntax error ("Incorrect syntax near 'OUTPUT'").
    let query = `INSERT INTO ${this.table} (${columnNames})`;
    if (dbType === DBType.MSSQL) {
      query += " OUTPUT INSERTED.*";
    }
    query += ` VALUES (${placeholders})`;
    if (dbType === DBType.Postgres) {
      query += " RETURNING *";
    }

    let insertedResult: T[] | undefined;
    let id: number | string | undefined;

    if (dbType === DBType.Postgres || dbType === DBType.MSSQL) {
      // Both clauses hand back raw column values, so encrypted columns need
      // the same decoding a read would apply.
      insertedResult = (await client.query<T>(query, params)).map((row) =>
        this.processForLoad(row),
      );
      id = (insertedResult?.[0] as any)?.id;
    } else {
      await client.query(query, params);
      // If the entity already has an id value (UUID, string, etc.), use it directly
      const entityId = (entityWithTimestamps as any).id;
      if (entityId !== undefined && entityId !== null) {
        id = entityId;
      } else if (dbType === DBType.SQLite) {
        id = (
          await client.query<{ id: number }>("SELECT last_insert_rowid() as id")
        )[0]?.id;
      } else if (dbType === DBType.MySQL) {
        const result = await client.query<{ "LAST_INSERT_ID()": number }>(
          "SELECT LAST_INSERT_ID()",
        );
        id = result[0]?.["LAST_INSERT_ID()"];
      }
    }

    if (!id)
      throw new StabilizeError(
        "Failed to retrieve inserted ID",
        "INSERT_ERROR",
      );

    const result =
      insertedResult?.[0] ?? ((await this.findOne(id, options, client)) as T);

    await this.invalidateRowCache(id);
    await this.writeThroughRow(id, result);

    this.logger.logDebug(
      `Created ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return result;
  }

  async bulkCreate(
    entities: Partial<T>[],
    options: { relations?: string[]; batchSize?: number } = {},
    _client?: DBClient,
  ): Promise<T[]> {
    return (_client || this.client).transaction(async (txClient) => {
      const preparedEntities = entities.map((data) => {
        const instance = new (this as any).model();
        Object.assign(instance, data);
        return instance;
      });

      for (const entity of preparedEntities) {
        await this.runHooks(entity, "beforeCreate");
        await this.runHooks(entity, "beforeSave");
      }

      const results = await this._bulkCreate(
        preparedEntities as Partial<T>[],
        options,
        txClient,
      );

      for (let i = 0; i < results.length; i++) {
        // Hydrated so `after*` hooks and class-method hooks resolve, and so a
        // hook's mutation is visible on what `bulkCreate` returns.
        const hydrated = this.hydrate(results[i]!);
        await this.runHooks(hydrated, "afterCreate");
        await this.runHooks(hydrated, "afterSave");
        if (this.versioned) {
          await this.writeHistory(hydrated, "insert", txClient);
        }
        results[i] = hydrated;
      }

      // Loaded once for the whole batch rather than per row. @see create
      await this.loadRelations(results, options.relations, txClient);
      return results;
    });
  }

  private async _bulkCreate(
    entities: Partial<T>[],
    options: { relations?: string[]; batchSize?: number },
    client: DBClient,
  ): Promise<T[]> {
    if (this.getDBType(client) === DBType.MongoDB) {
      return mongoBulkCreate(
        this.mongoCtx,
        entities as Record<string, any>[],
        options,
        client,
      ) as Promise<T[]>;
    }

    const start = performance.now();
    this.logger.logDebug(
      `Bulk creating ${entities.length} ${this.table} entities`,
    );
    if (!entities.length) return [];

    const batchSize = options.batchSize || 1000;
    entities.forEach((entity) => this.validate(entity));

    const timestamps = this.timestampsConfig;
    const prepared = entities.map((entity) => {
      const row = { ...entity } as Record<string, any>;
      if (timestamps?.createdAt && !row[timestamps.createdAt]) {
        row[timestamps.createdAt] = new Date().toISOString();
      }
      if (timestamps?.updatedAt && !row[timestamps.updatedAt]) {
        row[timestamps.updatedAt] = new Date().toISOString();
      }
      if (
        this.optimisticLockField &&
        row[this.optimisticLockField] === undefined
      ) {
        row[this.optimisticLockField] = 1;
      }
      // The same coercion `create()` applies: encrypt encrypted columns and
      // normalise Dates. Without it a bulk insert wrote plaintext into an
      // encrypted column and bound a raw `Date`, which SQLite rejects.
      return this.processForSave(row) as Partial<T>;
    });

    const dbType = this.getDBType(client);
    const pkField = this.primaryKeyField;
    const pkColumn = this.primaryKeyColumn;
    const results: T[] = [];

    for (let i = 0; i < prepared.length; i += batchSize) {
      const batch = prepared.slice(i, i + batchSize);
      // Union the keys across the batch. Taking them from `batch[0]` alone
      // silently dropped every column the first row happened not to carry,
      // so a caller passing a mix of shapes lost data on the wider rows.
      const keys: string[] = [];
      for (const row of batch) {
        for (const key of Object.keys(row)) {
          if (this.columns[key] && !keys.includes(key)) keys.push(key);
        }
      }
      const columnNames = keys.map((k) => this.columns[k]?.name ?? k).join(", ");
      const params: any[] = batch.flatMap((row) =>
        keys.map((k) => (row as any)[k] ?? null),
      );

      if (dbType === DBType.Postgres) {
        let paramIdx = 1;
        const valuePlaceholders = batch
          .map(() => `(${keys.map(() => `$${paramIdx++}`).join(", ")})`)
          .join(", ");
        const query = `INSERT INTO ${this.table} (${columnNames}) VALUES ${valuePlaceholders} RETURNING *`;
        const batchResults = await client.query<T>(query, params);
        // `RETURNING` hands back raw values, so encrypted columns need the
        // same decoding a read applies.
        results.push(...batchResults.map((row) => this.processForLoad(row)));
        continue;
      }

      const placeholders = `(${keys.map(() => "?").join(", ")})`;
      const valuesClause = batch.map(() => placeholders).join(", ");

      if (dbType === DBType.MSSQL) {
        // As in `_create`, `OUTPUT INSERTED.*` replaces the read-back the other
        // dialects need, so the new keys are known without asking the server
        // for an identity value afterwards.
        const query = `INSERT INTO ${this.table} (${columnNames}) OUTPUT INSERTED.* VALUES ${valuesClause}`;
        const batchResults = await client.query<T>(query, params);
        results.push(...batchResults.map((row) => this.processForLoad(row)));
        continue;
      }

      const query = `INSERT INTO ${this.table} (${columnNames}) VALUES ${valuesClause}`;
      await client.query(query, params);

      const ids = await this.resolveInsertedIds(
        batch,
        client,
        dbType,
        pkField,
        pkColumn,
      );
      if (ids.length === 0) continue;

      const queryBuilder = this.find().whereIn(
        `${this.table}.${pkColumn}`,
        ids,
      );
      const fetched = await queryBuilder.execute(client);
      await this.loadRelations(fetched, options.relations, client);
      // The `IN` query returns rows in whatever order the planner picked, so
      // re-order them to match the caller's input.
      const byKey = new Map(fetched.map((row: any) => [row[pkColumn], row]));
      for (const id of ids) {
        const row = byKey.get(id);
        if (row) results.push(row as T);
      }
    }

    await this.invalidateTableCache();

    this.logger.logDebug(
      `Bulk created ${results.length} ${this.table} entities in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return results;
  }

  /**
   * Works out the primary keys a single multi-row INSERT just created.
   *
   * These used to be guessed with `SELECT id FROM table ORDER BY id DESC LIMIT
   * n`, which returns whatever rows happen to be newest — including rows a
   * concurrent writer inserted in between — and cannot work at all when the
   * primary key is a UUID rather than a counter.
   */
  private async resolveInsertedIds(
    batch: Partial<T>[],
    client: DBClient,
    dbType: DBType,
    pkField: string,
    pkColumn: string,
  ): Promise<any[]> {
    // A caller-supplied key (UUID, string id) is already known.
    const explicit = batch.map(
      (row) => (row as any)[pkField] ?? (row as any)[pkColumn],
    );
    if (explicit.every((value) => value !== undefined && value !== null)) {
      return explicit;
    }

    if (!this.autoIncrementField) return [];

    // SQLite reports the rowid of the LAST row a multi-row INSERT assigned,
    // MySQL the FIRST. Either way the batch occupies one contiguous run.
    // SQL Server needs no probe of its own: every MSSQL insert path in this
    // repository returns its rows through an `OUTPUT INSERTED.*` clause, so
    // there is nothing left to look up here.
    if (dbType === DBType.MSSQL) return [];

    const reported =
      dbType === DBType.SQLite
        ? (
            await client.query<{ id: number }>(
              "SELECT last_insert_rowid() as id",
            )
          )[0]?.id
        : (
            await client.query<any>("SELECT LAST_INSERT_ID() as id")
          )[0]?.["LAST_INSERT_ID()"];

    if (reported === undefined || reported === null) return [];

    const first = dbType === DBType.SQLite ? reported - batch.length + 1 : reported;
    return Array.from({ length: batch.length }, (_, n) => first + n);
  }

  async update(
    id: number | string,
    entity: Partial<T>,
    _client?: DBClient,
  ): Promise<T> {
    return (_client || this.client).transaction(async (txClient) => {
      const before = await this.findOne(id, {}, txClient);
      if (!before) throw new StabilizeError("Not found", "UPDATE_ERROR");
      const instance = new this.model() as T;
      Object.assign(instance as object, before, entity);

      await this.runHooks(instance, "beforeUpdate");
      await this.runHooks(instance, "beforeSave");

      // Write the hook-mutated values, not the raw argument, so a
      // `beforeUpdate` that normalises a field is not thrown away.
      const result = await this._update(
        id,
        this.mergeHookOutput({ ...entity }, instance, before as any),
        before,
        txClient,
      );

      // Hydrated so `after*` hooks and class-method hooks resolve.
      const hydrated = this.hydrate(result);
      await this.runHooks(hydrated, "afterUpdate");
      await this.runHooks(hydrated, "afterSave");

      await this.writeHistory(
        {
          ...hydrated,
          version: (before as any).version ? (before as any).version + 1 : 1,
        },
        "update",
        txClient,
      );
      return hydrated;
    });
  }

  private async _update(
    id: number | string,
    entity: Partial<T>,
    before: T,
    client: DBClient,
  ): Promise<T> {
    const start = performance.now();
    this.logger.logDebug(`Updating ${this.table} with ID ${id}`);
    this.validate(entity, true);

    const timestamps = this.timestampsConfig;
    const entityWithTimestamps = { ...entity } as Record<string, any>;
    if (timestamps?.updatedAt && !entityWithTimestamps[timestamps.updatedAt]) {
      entityWithTimestamps[timestamps.updatedAt] = new Date().toISOString();
    }

    // Encrypt and coerce the payload. `processForSave` used to run only on
    // create, so an update wrote plaintext into an encrypted column and bound
    // raw `Date` objects that SQLite rejects.
    Object.assign(entityWithTimestamps, this.processForSave(entityWithTimestamps));

    // Advance the optimistic lock as part of the same UPDATE. This has to
    // happen before the column list is derived, otherwise the version column
    // is left out of the SET clause and never actually changes.
    let lockValue: any;
    let lockIsNull = false;
    if (this.optimisticLockField) {
      // Rows read back from the database are keyed by SQL column name, so a
      // renamed column must be looked up under its `name` too — otherwise the
      // value is undefined and the lock silently does nothing.
      lockValue =
        (before as any)[this.optimisticLockField] ??
        (this.optimisticLockColumn
          ? (before as any)[this.optimisticLockColumn]
          : undefined);

      // A caller that passes the version it read expects a conflict if someone
      // else has written since. Guard on the caller's value, not the one just
      // SELECTed inside this transaction, which would always match.
      const callerVersion = (entity as any)[this.optimisticLockField];
      const expected =
        callerVersion !== undefined && callerVersion !== null
          ? callerVersion
          : lockValue;

      if (expected !== undefined) {
        lockValue = expected;
        lockIsNull = expected === null;
        entityWithTimestamps[this.optimisticLockField] =
          typeof expected === "number" ? expected + 1 : 1;
      }
    }

    const keys = Object.keys(entityWithTimestamps).filter(
      (k) => this.columns[k],
    );
    const setClause = keys
      .map((k) => `${this.columns[k]?.name} = ?`)
      .join(", ");

    const whereParts: string[] = ["id = ?"];
    // Bind from `entityWithTimestamps`, not `entity`: timestamp and lock
    // columns are injected above and would otherwise bind as undefined.
    const queryParams = [...keys.map((k) => entityWithTimestamps[k]), id];

    if (this.optimisticLockField && lockValue !== undefined) {
      // `col = NULL` is never true in SQL, so a NULL version needs IS NULL.
      whereParts.push(
        lockIsNull
          ? `${this.optimisticLockColumn} IS NULL`
          : `${this.optimisticLockColumn} = ?`,
      );
      if (!lockIsNull) queryParams.push(lockValue);
    }

    if (this.softDeleteField) {
      whereParts.push(`${this.softDeleteColumn} IS NULL`);
    }

    const query = `UPDATE ${this.table} SET ${setClause} WHERE ${whereParts.join(" AND ")}`;
    const { affectedRows } = await client.queryExec(query, queryParams);

    if (this.optimisticLockField && lockValue !== undefined) {
      if (affectedRows === 0) {
        throw new StabilizeError(
          `Record was modified by another transaction (optimistic lock conflict on ${this.optimisticLockField})`,
          "CONCURRENT_MODIFICATION",
        );
      }
    }

    const result = await this.findOne(id, {}, client);

    await this.invalidateRowCache(id);
    await this.writeThroughRow(id, result);

    this.logger.logDebug(
      `Updated ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return result as T;
  }

  async bulkUpdate(
    updates: { where: { condition: string; params: any[] }; set: Partial<T> }[],
    options: { batchSize?: number } = {},
    _client?: DBClient,
  ): Promise<void> {
    return (_client || this.client).transaction((txClient) =>
      this._bulkUpdate(updates, options, txClient),
    );
  }

  private async _bulkUpdate(
    updates: { where: { condition: string; params: any[] }; set: Partial<T> }[],
    options: { batchSize?: number },
    client: DBClient,
  ): Promise<void> {
    const start = performance.now();
    this.logger.logDebug(
      `Bulk updating ${updates.length} ${this.table} entities`,
    );
    if (!updates.length) return;

    const batchSize = options.batchSize || 1000;
    // `set` is a partial patch, exactly like the payload of `update()`, so
    // required columns that are not being changed must not be demanded here.
    updates.forEach((update) => this.validate(update.set, true));

    const timestamps = this.timestampsConfig;

    for (let i = 0; i < updates.length; i += batchSize) {
      const batch = updates.slice(i, i + batchSize);
      for (const update of batch) {
        const rows = await client.query<{ id: number | string }>(
          `SELECT id FROM ${this.table} WHERE ${update.where.condition}${this.softDeleteField ? ` AND ${this.softDeleteColumn} IS NULL` : ""}`,
          update.where.params,
        );
        for (const { id } of rows) {
          const before = await this.findOne(id, {}, client);
          if (!before) continue;

          const updateWithTimestamps = {
            ...update.set,
            ...(timestamps?.updatedAt &&
            !(update.set as Record<string, any>)[timestamps.updatedAt]
              ? { [timestamps.updatedAt]: new Date() }
              : {}),
          } as Partial<T>;

          const keys = Object.keys(updateWithTimestamps).filter(
            (k) => this.columns[k],
          );
          const setClause = keys
            .map((k) => `${this.columns[k]?.name} = ?`)
            .join(", ");
          const query = `UPDATE ${this.table} SET ${setClause} WHERE id = ?${this.softDeleteField ? ` AND ${this.softDeleteColumn} IS NULL` : ""}`;
          const params = [
            ...keys.map((k) => (updateWithTimestamps as any)[k]),
            id,
          ];
          await client.query(query, params);

          const after = await this.findOne(id, {}, client);
          if (after) {
            await this.runHooks(after, "afterUpdate");
            await this.runHooks(after, "afterSave");
            if (this.versioned) {
              await this.writeHistory(
                {
                  ...after,
                  version: (before as any).version
                    ? (before as any).version + 1
                    : 1,
                },
                "update",
                client,
              );
            }
          }
        }
      }
    }

    await this.invalidateTableCache();

    this.logger.logDebug(
      `Bulk updated ${updates.length} ${this.table} entities in ${(performance.now() - start).toFixed(2)}ms`,
    );
  }

  async upsert(
    entity: Partial<T>,
    keys: string[],
    _client?: DBClient,
  ): Promise<T> {
    return (_client || this.client).transaction((txClient) =>
      this._upsert(entity, keys, txClient),
    );
  }

  private async _upsert(
    entity: Partial<T>,
    keys: string[],
    client: DBClient,
  ): Promise<T> {
    const start = performance.now();
    this.logger.logDebug(
      `Upserting ${this.table} with keys: ${keys.join(", ")}`,
    );
    this.validate(entity);

    const dbType = this.getDBType(client);
    const payload: Record<string, any> = { ...entity };
    // Seed the optimistic lock before the hooks run, so a `beforeUpdate` sees
    // the version the write will carry.
    if (
      this.optimisticLockField &&
      payload[this.optimisticLockField] === undefined
    ) {
      payload[this.optimisticLockField] = 1;
    }

    // Which row this will land on is decided by the conflict keys, and that
    // drives the hook pair and the history operation — so resolve it even when
    // the model is not versioned, rather than calling every upsert an insert.
    const before = await this.findRowByKeys(keys, payload, client);
    const isUpdate = !!before;

    const instance = this.hydrate<T>({ ...(before || {}), ...payload } as T);
    if (isUpdate) {
      await this.runHooks(instance, "beforeUpdate");
      await this.runHooks(instance, "beforeSave");
    } else {
      await this.runHooks(instance, "beforeCreate");
      await this.runHooks(instance, "beforeSave");
    }

    const writeValues = this.processForSave(
      this.mergeHookOutput(payload, instance, before as any),
    );
    const columns = Object.keys(writeValues).filter((k) => this.columns[k]);
    const columnNames = columns.map((k) => this.columns[k]?.name).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const conflictColumns = keys.map((k) => this.columns[k]!.name);
    const insertParams = columns.map((k) => writeValues[k]);
    const updateParams = columns
      .filter((c) => !keys.includes(c))
      .map((k) => writeValues[k]);

    let query: string;
    let params = [...insertParams, ...updateParams];

    if (dbType === DBType.SQLite) {
      const updateClause = columns
        .filter((c) => !keys.includes(c))
        .map((c) => `${this.columns[c]?.name} = ?`)
        .join(", ");
      query = `INSERT INTO ${this.table} (${columnNames}) VALUES (${placeholders}) ON CONFLICT(${conflictColumns.join(", ")}) DO UPDATE SET ${updateClause}`;
    } else if (dbType === DBType.MySQL) {
      const updateClause = columns
        .filter((c) => !keys.includes(c))
        .map((c) => `${this.columns[c]?.name} = ?`)
        .join(", ");
      query = `INSERT INTO ${this.table} (${columnNames}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateClause}`;
    } else if (dbType === DBType.MSSQL) {
      // `MERGE` refers to each value by a source column name, so the parameters
      // are the insert payload alone — the update payload is not bound a second
      // time the way the `?`-based dialects above bind it.
      query = buildMSSQLUpsertSQL(
        this.table,
        columns.map((c) => this.columns[c]!.name),
        conflictColumns,
      );
      params = insertParams;
    } else {
      const pgUpdateClause = columns
        .filter((c) => !keys.includes(c))
        .map(
          (c) => `${this.columns[c]?.name} = EXCLUDED.${this.columns[c]?.name}`,
        )
        .join(", ");
      query = `INSERT INTO ${this.table} (${columnNames}) VALUES (${placeholders}) ON CONFLICT (${conflictColumns.join(", ")}) DO UPDATE SET ${pgUpdateClause} RETURNING *`;
      params = insertParams;
    }

    const results = (await client.query<T>(query, params)).map((row) =>
      this.processForLoad(row),
    );

    // SQLite and MySQL report nothing for an `INSERT ... ON CONFLICT`, so the
    // row has to be read back. It must be read back by the conflict keys:
    // on the DO UPDATE path no insert happened, so `last_insert_rowid()` still
    // holds an unrelated earlier statement's value and pointed at a row this
    // upsert never touched.
    let result: T | null = results[0] ?? null;
    if (!result) result = await this.findRowByKeys(keys, writeValues, client);
    if (!result && keys.length === 0) {
      const id = await this.resolveInsertedIds(
        [writeValues as Partial<T>],
        client,
        dbType,
        this.primaryKeyField,
        this.primaryKeyColumn,
      );
      if (id.length > 0) {
        result = await this.findOne(id[0], {}, client);
      }
    }

    if (!result)
      throw new StabilizeError("Failed to retrieve upserted row", "UPSERT_ERROR");

    const id =
      (result as any)[this.primaryKeyField] ??
      (result as any)[this.primaryKeyColumn];

    const hydrated = this.hydrate(result);
    if (isUpdate) {
      await this.runHooks(hydrated, "afterUpdate");
      await this.runHooks(hydrated, "afterSave");
    } else {
      await this.runHooks(hydrated, "afterCreate");
      await this.runHooks(hydrated, "afterSave");
    }

    if (this.versioned) {
      await this.writeHistory(
        {
          ...hydrated,
          version: before
            ? (before as any).version
              ? (before as any).version + 1
              : 1
            : 1,
        },
        isUpdate ? "update" : "insert",
        client,
      );
    }

    if (id !== undefined && id !== null) {
      await this.invalidateRowCache(id);
      await this.writeThroughRow(id, hydrated);
    }

    this.logger.logDebug(
      `Upserted ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return hydrated;
  }

  /**
   * Reads the row a set of conflict keys identifies, or null when there is
   * none. Returns null for an empty key list, which has nothing to match on.
   */
  private async findRowByKeys(
    keys: string[],
    values: Record<string, any>,
    client: DBClient,
  ): Promise<T | null> {
    if (keys.length === 0) return null;
    const qb = this.find();
    for (const key of keys) {
      qb.whereEq(this.columns[key]?.name ?? key, values[key]);
    }
    const found = await qb.limit(1).execute(client);
    return (found[0] as T) ?? null;
  }

  async delete(id: number | string, _client?: DBClient): Promise<void> {
    return (_client || this.client).transaction(async (txClient) => {
      const before = await this.findOne(id, {}, txClient);
      if (!before) throw new StabilizeError("Not found", "DELETE_ERROR");
      await this.runHooks(before, "beforeDelete");

      await this._delete(id, txClient);

      await this.runHooks(before, "afterDelete");
      await this.writeHistory(before, "delete", txClient);
    });
  }

  private async _delete(id: number | string, client: DBClient): Promise<void> {
    const start = performance.now();
    this.logger.logDebug(`Deleting ${this.table} with ID ${id}`);

    const query = this.softDeleteField
      ? `UPDATE ${this.table} SET ${this.softDeleteColumn} = ? WHERE id = ?`
      : `DELETE FROM ${this.table} WHERE id = ?`;
    const params = this.softDeleteField
      ? [sanitizeSqlValue(new Date(), this.getDBType(client)), id]
      : [id];

    await client.query(query, params);

    await this.invalidateRowCache(id);
    this.logger.logDebug(
      `Deleted ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
    );
  }

  async bulkDelete(
    ids: (number | string)[],
    options: { batchSize?: number } = {},
    _client?: DBClient,
  ): Promise<void> {
    return (_client || this.client).transaction((txClient) =>
      this._bulkDelete(ids, options, txClient),
    );
  }

  private async _bulkDelete(
    ids: (number | string)[],
    options: { batchSize?: number },
    client: DBClient,
  ): Promise<void> {
    const start = performance.now();
    this.logger.logDebug(`Bulk deleting ${ids.length} ${this.table} entities`);
    if (!ids.length) return;

    const batchSize = options.batchSize || 1000;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      for (const id of batch) {
        const before = await this.findOne(id, {}, client);
        if (!before) continue;

        await this.runHooks(before, "beforeDelete");

        const query = this.softDeleteField
          ? `UPDATE ${this.table} SET ${this.softDeleteColumn} = ? WHERE id = ?`
          : `DELETE FROM ${this.table} WHERE id = ?`;
        const params = this.softDeleteField
          ? [sanitizeSqlValue(new Date(), this.getDBType(client)), id]
          : [id];

        await client.query(query, params);

        await this.runHooks(before, "afterDelete");

        if (this.versioned) {
          await this.writeHistory(before, "delete", client);
        }
      }
    }

    await this.invalidateTableCache();

    this.logger.logDebug(
      `Bulk deleted ${ids.length} ${this.table} entities in ${(performance.now() - start).toFixed(2)}ms`,
    );
  }

  async recover(id: number | string, _client?: DBClient): Promise<T> {
    return (_client || this.client).transaction((txClient) =>
      this._recover(id, txClient),
    );
  }

  private async _recover(id: number | string, client: DBClient): Promise<T> {
    const start = performance.now();
    this.logger.logDebug(`Recovering ${this.table} with ID ${id}`);
    if (!this.softDeleteField) {
      throw new StabilizeError(
        "Soft delete not enabled for this model",
        "RECOVER_ERROR",
      );
    }

    await client.query(
      `UPDATE ${this.table} SET ${this.softDeleteColumn} = NULL WHERE id = ?`,
      [id],
    );

    const result = await this.findOne(id, {}, client);
    if (!result)
      throw new StabilizeError(
        "Failed to find recovered record.",
        "RECOVER_ERROR",
      );

    await this.invalidateRowCache(id);

    this.logger.logDebug(
      `Recovered ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return result;
  }

  async rawQuery<R = T>(query: string, params: any[] = []): Promise<R[]> {
    const start = performance.now();
    this.logger.logDebug(`Executing raw query: ${query}`);
    const result = await this.client.query<R>(query, params);
    this.logger.logDebug(
      `Raw query completed in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return result;
  }

  /** The SQL column backing a property name. @see softDeleteColumn */
  private columnName(field: string): string {
    return this.columns[field]?.name ?? field;
  }

  /**
   * Builds a repository for a relation's target model, bound to `client`.
   *
   * Loading a relation means reading the target table, so the target's own
   * metadata is needed: its column names, its soft-delete filter, its encrypted
   * columns. Building a repository supplies all three without restating them
   * here.
   *
   * The client is the caller's, not `this.client`: a relation loaded inside a
   * transaction has to be read on the transaction's own connection, or on
   * MySQL and Postgres it would read from a different connection and miss (or
   * deadlock on) the uncommitted rows it is meant to see.
   */
  private relatedRepository(
    rel: { targetModel: () => any },
    client: DBClient,
  ): Repository<any> {
    const target = rel.targetModel();
    if (!MetadataStorage.getTableName(target)) {
      throw new StabilizeError(
        `Relation target ${target?.name ?? "unknown"} is not a model defined with defineModel()`,
        "RELATION_ERROR",
      );
    }
    return new Repository(
      client,
      target,
      this.cache?.config,
      this.logger,
      this.cache,
    );
  }

  /**
   * Reads the target rows whose `column` holds one of `values`.
   *
   * Runs against the target model's own `find()`, so its soft-delete filter and
   * column decryption apply to the related rows just as they do to a direct
   * read. The key list is chunked, see {@link RELATION_BATCH_SIZE}.
   */
  private async fetchRelatedWhereIn(
    column: string,
    values: any[],
    client: DBClient,
  ): Promise<any[]> {
    if (values.length === 0) return [];
    const rows: any[] = [];
    for (const chunk of chunked(values, RELATION_BATCH_SIZE)) {
      const qb = this.find();
      qb.whereIn(`${this.table}.${column}`, chunk);
      rows.push(...(await qb.execute(client)));
    }
    return rows;
  }

  /**
   * Eager-loads `relations` onto an already-fetched result set, attaching each
   * result under the relation's property name.
   *
   * Relations used to be loaded by joining the target table onto the parent
   * query. Nothing ever copied the joined columns onto the parent, so
   * `findOne(1, { relations: ["posts"] })` resolved to a user with no `posts`
   * key at all — the one thing the option was for. The join also multiplied
   * each parent once per related row, so `LIMIT 1` truncated a to-many
   * relation to a single row and `countExec` counted children instead of
   * parents. One batched query per relation avoids both, and it is the only
   * approach that composes with `LIMIT` at all.
   *
   * Paths are grouped by their first segment, so `findMany({ relations:
   * ["posts.comments", "posts.tags"] })` reads `posts` once, and whatever
   * follows the first segment is loaded recursively against the target model.
   */
  private async loadRelations<R>(
    rows: R[],
    relations: string[] | undefined,
    client: DBClient,
  ): Promise<R[]> {
    if (!relations?.length || rows.length === 0) return rows;
    const parents = rows as unknown as Record<string, any>[];

    const grouped = new Map<string, string[]>();
    for (const path of relations) {
      const parts = path.split(".").map((p) => p.trim()).filter(Boolean);
      const head = parts.shift();
      if (!head) continue;
      const rest = grouped.get(head);
      const tail = parts.join(".");
      if (rest) rest.push(tail);
      else grouped.set(head, [tail]);
    }

    for (const [head, rest] of grouped) {
      const rel = this.relations[head];
      if (!rel) {
        throw new StabilizeError(
          `Relation ${head} not found on ${this.table}`,
          "RELATION_ERROR",
        );
      }
      const related = this.relatedRepository(rel, client);
      const children = await this.attachRelation(
        parents,
        head,
        rel,
        related,
        client,
      );

      const deeper = rest.filter((path) => path.length > 0);
      if (deeper.length > 0) {
        await related.loadRelations(children, deeper, client);
      }
    }

    return rows;
  }

  /**
   * Loads one relation's rows and attaches them to each parent, returning the
   * children so a nested path can descend into them.
   */
  private async attachRelation(
    rows: Record<string, any>[],
    name: string,
    rel: {
      type: RelationType;
      foreignKey?: string;
      inverseKey?: string;
      joinTable?: string;
    },
    related: Repository<any>,
    client: DBClient,
  ): Promise<any[]> {
    this.logger.logDebug(`Loading relation ${name} for ${this.table}`);

    if (rel.type === RelationType.ManyToMany) {
      return this.attachManyToMany(rows, name, rel, related, client);
    }

    if (rel.type === RelationType.OneToMany) {
      // The child holds the key, so match the children on the parent's own
      // primary key.
      //
      // `inverseKey` is the documented name, but every example in the README
      // and the docs site writes `foreignKey` for this side. Both mean "the
      // column on the target table that points back here", so accept either
      // rather than fail on a model copied from the documentation.
      const inverseField = rel.inverseKey ?? rel.foreignKey;
      if (!inverseField) {
        throw new StabilizeError(
          `Relation ${name} on ${this.table} needs an inverseKey naming the column on the target table that points back at ${this.table}`,
          "RELATION_ERROR",
        );
      }
      const inverseColumn = related.columnName(inverseField);
      const parentKey = this.primaryKeyColumn;
      const children = await related.fetchRelatedWhereIn(
        inverseColumn,
        distinctKeys(rows, parentKey),
        client,
      );
      const byParent = new Map<any, any[]>();
      for (const child of children) {
        const key = child[inverseColumn];
        const bucket = byParent.get(key);
        if (bucket) bucket.push(child);
        else byParent.set(key, [child]);
      }
      for (const row of rows) {
        row[name] = byParent.get(row[parentKey]) ?? [];
      }
      return children;
    }

    // OneToOne and ManyToOne both keep the key on this side.
    if (!rel.foreignKey) {
      throw new StabilizeError(
        `Relation ${name} on ${this.table} is missing a foreignKey`,
        "RELATION_ERROR",
      );
    }
    const foreignColumn = this.columnName(rel.foreignKey);
    const relatedKey = related.primaryKeyColumn;
    const children = await related.fetchRelatedWhereIn(
      relatedKey,
      distinctKeys(rows, foreignColumn),
      client,
    );
    const byId = new Map(children.map((child) => [child[relatedKey], child]));
    for (const row of rows) {
      row[name] = byId.get(row[foreignColumn]) ?? null;
    }
    return children;
  }

  /**
   * Loads a many-to-many relation through its join table and attaches the
   * target rows to each parent, in join-table order.
   */
  private async attachManyToMany(
    rows: Record<string, any>[],
    name: string,
    rel: { foreignKey?: string; inverseKey?: string; joinTable?: string },
    related: Repository<any>,
    client: DBClient,
  ): Promise<any[]> {
    const { joinTable, foreignKey, inverseKey } = rel;
    if (!joinTable || !foreignKey || !inverseKey) {
      throw new StabilizeError(
        `Relation ${name} on ${this.table} needs a joinTable, foreignKey and inverseKey`,
        "RELATION_ERROR",
      );
    }

    const parentKey = this.primaryKeyColumn;
    const parentIds = distinctKeys(rows, parentKey);
    if (parentIds.length === 0) {
      for (const row of rows) row[name] = [];
      return [];
    }

    // The join table has no model of its own, so its key columns are named by
    // the relation config rather than resolved through column metadata.
    const links: { parent: any; child: any }[] = [];
    for (const chunk of chunked(parentIds, RELATION_BATCH_SIZE)) {
      const found = await client.query<Record<string, any>>(
        `SELECT ${foreignKey} AS __parent, ${inverseKey} AS __child FROM ${joinTable} WHERE ${foreignKey} IN (${chunk.map(() => "?").join(", ")})`,
        chunk,
      );
      for (const link of found) {
        links.push({ parent: link.__parent, child: link.__child });
      }
    }

    const relatedKey = related.primaryKeyColumn;
    const children = await related.fetchRelatedWhereIn(
      relatedKey,
      distinctKeys(links as any, "child"),
      client,
    );
    const byId = new Map(children.map((child) => [child[relatedKey], child]));

    const byParent = new Map<any, any[]>();
    for (const link of links) {
      const child = byId.get(link.child);
      if (!child) continue; // Soft-deleted, or gone between the two reads.
      const bucket = byParent.get(link.parent);
      if (bucket) bucket.push(child);
      else byParent.set(link.parent, [child]);
    }
    for (const row of rows) {
      row[name] = byParent.get(row[parentKey]) ?? [];
    }
    return children;
  }

  async paginate(
    page: number,
    pageSize: number,
    options: any = {},
  ): Promise<{ data: T[]; total: number; page: number; pageSize: number }> {
    const qb = this.find();
    const data = await qb.paginate(page, pageSize).execute(this.client);
    let countQuery = `SELECT COUNT(*) as count FROM ${this.table}`;
    let countParams: any[] = [];
    if (this.softDeleteField) {
      countQuery += ` WHERE ${this.table}.${this.softDeleteColumn} IS NULL`;
    }
    const result = await this.client.query<{ count: number }>(
      countQuery,
      countParams,
    );
    const count = result?.[0]?.count ?? 0;
    return { data, total: Number(count), page, pageSize };
  }

  private processForSave(entity: any): any {
    const processed = { ...entity };
    for (const [key, col] of Object.entries(this.columns)) {
      if ((col as any).encrypted && processed[key]) {
        processed[key] = encrypt(processed[key]);
      }
    }
    // A `Date` is normalised per dialect rather than to ISO for all of them,
    // because MySQL and MariaDB reject the ISO form outright. @see
    // sanitizeSqlValue for both reasons.
    //
    // MongoDB is the exception in the other direction: it has a native date
    // type, and an ISO string would both fail a `{bsonType: "date"}` validator
    // and defeat every range query that could have used an index.
    const dbType = this.getDBType();
    if (dbType === DBType.MongoDB) return processed;
    for (const key of Object.keys(processed)) {
      if (processed[key] instanceof Date) {
        processed[key] = sanitizeSqlValue(processed[key], dbType);
      }
    }
    return processed;
  }

  private processForLoad(row: any): any {
    const processed = { ...row };
    for (const [key, col] of Object.entries(this.columns)) {
      if ((col as any).encrypted && processed[key]) {
        // A failure here means the key is wrong or the value was tampered
        // with. Returning `null` instead made both look like an empty field,
        // so the caller could neither notice nor react.
        try {
          processed[key] = decrypt(processed[key]);
        } catch (error) {
          throw new StabilizeError(
            `Failed to decrypt column "${key}": ${(error as Error).message}`,
            "DECRYPTION_ERROR",
            error as Error,
          );
        }
      }
    }
    return processed;
  }

  // ─── FEATURE 1: findAndCount ──────────────────────────────────────

  async findAndCount(
    options: { relations?: string[] } = {},
  ): Promise<{ data: T[]; total: number }> {
    const data = await this.find().execute(this.client);
    await this.loadRelations(data, options.relations, this.client);
    // Counted without loading relations: a join for a to-many relation would
    // count the children rather than the parents.
    const total = await this.find().countExec(this.client);
    return { data, total };
  }

  // ─── FEATURE 2: findOneBy (TypeORM-style) ─────────────────────────

  async findOneBy(
    conditions: Partial<T>,
    options: { relations?: string[] } = {},
    _client?: DBClient,
  ): Promise<T | null> {
    const client = _client || this.client;
    const qb = this.find();
    for (const [key, value] of Object.entries(conditions)) {
      if (value === null) {
        qb.whereNull(this.columns[key]?.name ?? key);
      } else {
        qb.whereEq(this.columns[key]?.name ?? key, value);
      }
    }
    // Safe to limit before loading: relations no longer multiply the parent
    // rows, which previously made `LIMIT 1` truncate a to-many relation to
    // whichever single child the planner happened to return first.
    const results = await qb.limit(1).execute(client);
    await this.loadRelations(results, options.relations, client);
    return results[0] ?? null;
  }

  // ─── FEATURE 3: findBy (TypeORM-style) ────────────────────────────

  async findBy(
    conditions: Partial<T>,
    options: { relations?: string[]; limit?: number; orderBy?: string } = {},
    _client?: DBClient,
  ): Promise<T[]> {
    const client = _client || this.client;
    const qb = this.find();
    for (const [key, value] of Object.entries(conditions)) {
      if (value === null) {
        qb.whereNull(this.columns[key]?.name ?? key);
      } else {
        qb.whereEq(this.columns[key]?.name ?? key, value);
      }
    }
    if (options.limit) qb.limit(options.limit);
    if (options.orderBy) qb.orderBy(options.orderBy);
    const results = await qb.execute(client);
    return this.loadRelations(results, options.relations, client);
  }

  // ─── FEATURE 4: count (Prisma-style) ──────────────────────────────

  async count(conditions?: Partial<T>): Promise<number> {
    const qb = new QueryBuilder(this.table);
    if (this.softDeleteField) {
      qb.whereNull(this.softDeleteColumn!);
    }
    if (conditions) {
      for (const [key, value] of Object.entries(conditions)) {
        // A `null` condition means IS NULL. Skipping it (as this used to)
        // silently widened the count to every row.
        if (value === null) {
          qb.whereNull(this.columns[key]?.name ?? key);
        } else if (value !== undefined) {
          qb.whereEq(this.columns[key]?.name ?? key, value);
        }
      }
    }
    return qb.countExec(this.client);
  }

  // ─── FEATURE: findAndCountAll ──────────────────────────────────

  async findAndCountAll(options?: {
    page?: number;
    pageSize?: number;
    conditions?: Partial<T>;
  }): Promise<{ data: T[]; total: number }> {
    const page = options?.page || 1;
    const pageSize = options?.pageSize || 20;
    const conditions = options?.conditions;

    const qb = new QueryBuilder(this.table);
    if (this.softDeleteField) {
      qb.whereNull(this.softDeleteColumn!);
    }
    if (conditions) {
      for (const [key, value] of Object.entries(conditions)) {
        if (value !== undefined && value !== null) {
          qb.whereEq(this.columns[key]?.name ?? key, value);
        }
      }
    }

    const data = await qb
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute(this.client);
    const total = await this.count(conditions);
    return { data: data as T[], total };
  }

  // ─── FEATURE: toJSON ──────────────────────────────────────────

  toJSON(entity: T): Record<string, any> {
    const result: Record<string, any> = {};
    for (const key of Object.keys(this.columns)) {
      if (this.softDeleteField && key === this.softDeleteField) continue;
      result[key] = (entity as any)[key];
    }
    return result;
  }

  // ─── FEATURE 5: aggregate (Prisma-style) ──────────────────────────

  async aggregate(options: {
    count?: string | string[];
    sum?: string[];
    avg?: string[];
    min?: string[];
    max?: string[];
  }): Promise<Record<string, any>> {
    const selectParts: string[] = [];

    if (options.count) {
      const cols = Array.isArray(options.count)
        ? options.count
        : [options.count];
      for (const col of cols) {
        const alias = col === "*" ? "count_all" : `count_${col}`;
        selectParts.push(
          `COUNT(${col === "*" ? "*" : this.columns[col]?.name || col}) AS ${alias}`,
        );
      }
    }
    if (options.sum) {
      for (const col of options.sum) {
        selectParts.push(
          `SUM(${this.columns[col]?.name || col}) AS sum_${col}`,
        );
      }
    }
    if (options.avg) {
      for (const col of options.avg) {
        selectParts.push(
          `AVG(${this.columns[col]?.name || col}) AS avg_${col}`,
        );
      }
    }
    if (options.min) {
      for (const col of options.min) {
        selectParts.push(
          `MIN(${this.columns[col]?.name || col}) AS min_${col}`,
        );
      }
    }
    if (options.max) {
      for (const col of options.max) {
        selectParts.push(
          `MAX(${this.columns[col]?.name || col}) AS max_${col}`,
        );
      }
    }

    if (selectParts.length === 0) return {};

    const qb = new QueryBuilder(this.table);
    if (this.softDeleteField) {
      qb.whereNull(this.softDeleteColumn!);
    }
    qb.select(...selectParts);
    const results = await qb.execute(this.client);
    return results[0] ?? {};
  }

  // ─── FEATURE 6: cursor-based pagination (Prisma-style) ────────────

  async findMany(
    options: {
      where?: Partial<T>;
      cursor?: {
        field: string;
        value: any;
        direction?: "forward" | "backward";
      };
      take?: number;
      skip?: number;
      orderBy?: { field: string; direction: "ASC" | "DESC" };
      relations?: string[];
    } = {},
  ): Promise<T[]> {
    const qb = this.find();

    if (options.where) {
      for (const [key, value] of Object.entries(options.where)) {
        if (value === null) {
          qb.whereNull(this.columns[key]?.name ?? key);
        } else {
          qb.whereEq(this.columns[key]?.name ?? key, value);
        }
      }
    }

    if (options.cursor) {
      const { field, value, direction = "forward" } = options.cursor;
      const colName = this.columns[field]?.name || field;
      const dir = options.orderBy?.direction || "ASC";
      if (direction === "forward") {
        qb.whereCompare(colName, dir === "ASC" ? ">" : "<", value);
      } else {
        qb.whereCompare(colName, dir === "ASC" ? "<" : ">", value);
      }
      if (options.orderBy) {
        qb.orderBy(colName, options.orderBy.direction);
      }
    } else if (options.orderBy) {
      qb.orderBy(
        this.columns[options.orderBy.field]?.name || options.orderBy.field,
        options.orderBy.direction,
      );
    }

    if (options.take) qb.take(options.take);
    if (options.skip) qb.skip(options.skip);

    const results = await qb.execute(this.client);
    return this.loadRelations(results, options.relations, this.client);
  }

  // ─── FEATURE 7: bulk upsert (Prisma-style) ────────────────────────

  async bulkUpsert(
    entities: Partial<T>[],
    keys: string[],
    _client?: DBClient,
  ): Promise<T[]> {
    return (_client || this.client).transaction(async (txClient) => {
      const results: T[] = [];
      for (const entity of entities) {
        results.push(await this._upsert(entity, keys, txClient));
      }
      return results;
    });
  }

  // ─── FEATURE 8: exists (TypeORM-style) ────────────────────────────

  async exists(conditions?: Partial<T>): Promise<boolean> {
    const qb = new QueryBuilder(this.table);
    if (this.softDeleteField) {
      qb.whereNull(this.softDeleteColumn!);
    }
    if (conditions) {
      for (const [key, value] of Object.entries(conditions)) {
        // As in `count`, a `null` condition is a real predicate (IS NULL),
        // not one to drop.
        if (value === null) {
          qb.whereNull(this.columns[key]?.name ?? key);
        } else if (value !== undefined) {
          qb.whereEq(this.columns[key]?.name ?? key, value);
        }
      }
    }
    return qb.existsExec(this.client);
  }

  // ─── FEATURE 9: recoverAll (Stabilize-original) ───────────────────

  async recoverAll(_client?: DBClient): Promise<number> {
    if (!this.softDeleteField) {
      throw new StabilizeError(
        "Soft delete not enabled for this model",
        "RECOVER_ERROR",
      );
    }
    const result = await (_client || this.client).queryExec(
      `UPDATE ${this.table} SET ${this.softDeleteColumn} = NULL WHERE ${this.softDeleteColumn} IS NOT NULL`,
    );
    return result.affectedRows;
  }

  // ─── FEATURE 10: truncate (Rails-style) ───────────────────────────

  async truncate(_client?: DBClient): Promise<void> {
    await (_client || this.client).queryExec(`DELETE FROM ${this.table}`);
    await this.invalidateTableCache();
  }

  // ─── FEATURE 11: seed framework (Laravel-style) ───────────────────

  async seed(
    data: Partial<T>[],
    options: { ignoreDuplicates?: boolean } = {},
    _client?: DBClient,
  ): Promise<T[]> {
    if (data.length === 0) return [];

    const client = _client || this.client;
    const existing = await this.find().execute(client);
    if (existing.length > 0 && options.ignoreDuplicates) return existing;

    return this.bulkCreate(data, {}, client);
  }

  // ─── FEATURE 12: healthCheck ──────────────────────────────────────

  async healthCheck(): Promise<{
    status: string;
    table: string;
    rows: number;
    latencyMs: number;
  }> {
    const start = performance.now();
    try {
      const count = await this.count();
      return {
        status: "healthy",
        table: this.table,
        rows: count,
        latencyMs: Number((performance.now() - start).toFixed(2)),
      };
    } catch (error) {
      return {
        status: "unhealthy",
        table: this.table,
        rows: -1,
        latencyMs: Number((performance.now() - start).toFixed(2)),
      };
    }
  }

  // ─── FEATURE 13: distinct count ───────────────────────────────────

  async countDistinct(column: string): Promise<number> {
    const colName = this.columns[column]?.name || column;
    const qb = new QueryBuilder(this.table);
    if (this.softDeleteField) {
      qb.whereNull(this.softDeleteColumn!);
    }
    qb.select(`COUNT(DISTINCT ${colName}) AS __cnt`);
    const results = await qb.execute(this.client);
    return Number((results[0] as any)?.__cnt ?? 0);
  }

  // ─── FEATURE 14: increment / decrement ────────────────────────────

  async increment(
    id: number | string,
    field: string,
    amount: number = 1,
    _client?: DBClient,
  ): Promise<T> {
    const client = _client || this.client;
    const colName = this.columns[field]?.name || field;
    let query = `UPDATE ${this.table} SET ${colName} = ${colName} + ? WHERE id = ?`;
    if (this.softDeleteField) query += ` AND ${this.softDeleteColumn} IS NULL`;
    await client.queryExec(query, [amount, id]);
    // These bypass the normal write path, so clear the row's cached copies
    // before reading it back — otherwise the pre-increment value is returned.
    await this.invalidateRowCache(id);
    return (await this.findOne(id, {}, client)) as T;
  }

  async decrement(
    id: number | string,
    field: string,
    amount: number = 1,
    _client?: DBClient,
  ): Promise<T> {
    const client = _client || this.client;
    const colName = this.columns[field]?.name || field;
    let query = `UPDATE ${this.table} SET ${colName} = ${colName} - ? WHERE id = ?`;
    if (this.softDeleteField) query += ` AND ${this.softDeleteColumn} IS NULL`;
    await client.queryExec(query, [amount, id]);
    // These bypass the normal write path, so clear the row's cached copies
    // before reading it back — otherwise the pre-increment value is returned.
    await this.invalidateRowCache(id);
    return (await this.findOne(id, {}, client)) as T;
  }

  // ─── FEATURE 15: pluck (Rails-style) ──────────────────────────────

  async pluck<K extends keyof T>(column: K): Promise<any[]> {
    const colName = this.columns[column as string]?.name || (column as string);
    const qb = new QueryBuilder(this.table);
    qb.select(colName);
    if (this.softDeleteField) {
      qb.whereNull(this.softDeleteColumn!);
    }
    const results = await qb.execute(this.client);
    return results.map((r: any) => r[colName]);
  }

  // ─── FEATURE 16: selectColumn (Drizzle-style) ─────────────────────

  async selectColumns(...columns: (keyof T)[]): Promise<Partial<T>[]> {
    const colNames = columns.map(
      (c) => this.columns[c as string]?.name || (c as string),
    );
    const qb = new QueryBuilder<T>(this.table);
    qb.select(...colNames);
    if (this.softDeleteField) {
      qb.whereNull(this.softDeleteColumn!);
    }
    const results = await this.withRowTransform(qb).execute(this.client);
    return results as Partial<T>[];
  }

  // ─── FEATURE 17: toggle (Rails-style) ─────────────────────────────

  async toggle(
    id: number | string,
    field: string,
    _client?: DBClient,
  ): Promise<T> {
    const client = _client || this.client;
    const colName = this.columns[field]?.name || field;
    const dbType = this.getDBType();
    const expr =
      dbType === DBType.Postgres
        ? `NOT ${colName}`
        : dbType === DBType.MySQL
          ? `NOT ${colName}`
          : `CASE WHEN ${colName} = 1 THEN 0 ELSE 1 END`;
    let query = `UPDATE ${this.table} SET ${colName} = ${expr} WHERE id = ?`;
    if (this.softDeleteField) query += ` AND ${this.softDeleteColumn} IS NULL`;
    await client.queryExec(query, [id]);
    await this.invalidateRowCache(id);
    return (await this.findOne(id, {}, client)) as T;
  }

  // ─── FEATURE 18: updateBy (TypeORM-style) ─────────────────────────

  /**
   * Rejects a condition set that would match every row in the table.
   *
   * `updateBy({}, …)` and `deleteBy({})` compiled to a statement with no WHERE
   * clause, so calling either with an empty filter silently rewrote or deleted
   * the entire table. `truncate()` is the explicit way to do that.
   */
  private assertConditions(
    conditions: Record<string, any>,
    method: string,
  ): void {
    if (Object.keys(conditions).length === 0) {
      throw new StabilizeError(
        `${method}() requires at least one condition; refusing to affect every row of ${this.table}. Use truncate() for that.`,
        "UNSAFE_QUERY",
      );
    }
  }

  async updateBy(
    conditions: Partial<T>,
    updates: Partial<T>,
    _client?: DBClient,
  ): Promise<number> {
    const client = _client || this.client;
    this.assertConditions(conditions, "updateBy");

    const payload: Record<string, any> = { ...updates };
    const timestamps = this.timestampsConfig;
    if (timestamps?.updatedAt) {
      // Set before the key list is built. It used to be assigned afterwards,
      // so it never made it into the SET clause and `updatedAt` never moved.
      // An ISO string, not a `Date`: SQLite refuses to bind a Date object.
      payload[timestamps.updatedAt] = new Date().toISOString();
    }
    // Encrypt and coerce, exactly as a single-row `update()` does — otherwise a
    // bulk update wrote plaintext straight into an encrypted column.
    const writeValues = this.processForSave(payload);

    const setParts: string[] = [];
    const setParams: any[] = [];
    for (const key of Object.keys(writeValues)) {
      if (!this.columns[key]) continue;
      setParts.push(`${this.columns[key]!.name} = ?`);
      setParams.push(writeValues[key]);
    }
    // A bulk update advances the version too, so the rows it touched are not
    // left holding a version that no longer matches and rejecting the next
    // ordinary write as a conflict.
    if (
      this.optimisticLockField &&
      !(this.optimisticLockField in writeValues)
    ) {
      const lockColumn = this.columns[this.optimisticLockField]!.name;
      setParts.push(`${lockColumn} = ${lockColumn} + 1`);
    }
    if (setParts.length === 0) return 0;
    const setClause = setParts.join(", ");

    const whereParts: string[] = [];
    const whereParams: any[] = [];
    for (const [key, value] of Object.entries(conditions)) {
      if (value === null) {
        whereParts.push(`${this.columns[key]?.name} IS NULL`);
      } else {
        whereParts.push(`${this.columns[key]?.name} = ?`);
        whereParams.push(value);
      }
    }
    if (this.softDeleteField) {
      whereParts.push(`${this.softDeleteColumn} IS NULL`);
    }

    const whereClause =
      whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
    const query = `UPDATE ${this.table} SET ${setClause}${whereClause}`;
    const result = await client.queryExec(query, [
      ...setParams,
      ...whereParams,
    ]);

    await this.invalidateTableCache();
    return result.affectedRows;
  }

  // ─── FEATURE 19: deleteBy (TypeORM-style) ─────────────────────────

  async deleteBy(conditions: Partial<T>, _client?: DBClient): Promise<number> {
    const client = _client || this.client;
    this.assertConditions(conditions, "deleteBy");
    const whereParts: string[] = [];
    const whereParams: any[] = [];
    for (const [key, value] of Object.entries(conditions)) {
      if (value === null) {
        whereParts.push(`${this.columns[key]?.name} IS NULL`);
      } else {
        whereParts.push(`${this.columns[key]?.name} = ?`);
        whereParams.push(value);
      }
    }

    if (this.softDeleteField) {
      whereParts.push(`${this.softDeleteColumn} IS NULL`);
      const whereClause =
        whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
      const query = `UPDATE ${this.table} SET ${this.softDeleteColumn} = ?${whereClause}`;
      const result = await client.queryExec(query, [
        sanitizeSqlValue(new Date(), this.getDBType(client)),
        ...whereParams,
      ]);
      await this.invalidateTableCache();
      return result.affectedRows;
    }

    const whereClause =
      whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
    const result = await client.queryExec(
      `DELETE FROM ${this.table}${whereClause}`,
      whereParams,
    );
    await this.invalidateTableCache();
    return result.affectedRows;
  }

  // ─── FEATURE 20: restoreBy (soft-delete recovery by condition) ────

  async restoreBy(conditions: Partial<T>, _client?: DBClient): Promise<number> {
    if (!this.softDeleteField) {
      throw new StabilizeError("Soft delete not enabled", "RECOVER_ERROR");
    }
    const client = _client || this.client;
    const whereParts: string[] = [`${this.softDeleteColumn} IS NOT NULL`];
    const whereParams: any[] = [];
    for (const [key, value] of Object.entries(conditions)) {
      if (value !== undefined && value !== null) {
        whereParts.push(`${this.columns[key]?.name} = ?`);
        whereParams.push(value);
      }
    }
    const query = `UPDATE ${this.table} SET ${this.softDeleteColumn} = NULL WHERE ${whereParts.join(" AND ")}`;
    const result = await client.queryExec(query, whereParams);
    await this.invalidateTableCache();
    return result.affectedRows;
  }

  // ─── FEATURE 21: onlyTrashed (query soft-deleted only) ────────────

  findDeleted(): QueryBuilder<T> {
    if (!this.softDeleteField) {
      throw new StabilizeError("Soft delete not enabled", "QUERY_ERROR");
    }
    const qb = new QueryBuilder<T>(this.table);
    qb.whereNotNull(this.softDeleteColumn!);
    return this.withRowTransform(qb);
  }

  // ─── FEATURE 22: withTrashed (include soft-deleted in query) ──────

  withTrashed(): QueryBuilder<T> {
    return this.withRowTransform(new QueryBuilder<T>(this.table));
  }

  // ─── FEATURE 23: upsertMany (batch upsert) ────────────────────────

  async upsertMany(
    entities: Partial<T>[],
    keys: string[],
    batchSize: number = 100,
    _client?: DBClient,
  ): Promise<T[]> {
    const client = _client || this.client;
    const results: T[] = [];
    for (let i = 0; i < entities.length; i += batchSize) {
      const batch = entities.slice(i, i + batchSize);
      const batchResults = await this.bulkUpsert(batch, keys, client);
      results.push(...batchResults);
    }
    return results;
  }

  // ─── FEATURE 24: map (transform results) ──────────────────────────

  async map<R>(
    query: QueryBuilder<T>,
    transform: (item: T) => R,
  ): Promise<R[]> {
    const results = await query.execute(this.client);
    return results.map(transform);
  }

  // ─── FEATURE 25: each (iterate with callback) ─────────────────────

  async each(
    query: QueryBuilder<T>,
    callback: (item: T, index: number) => void | Promise<void>,
    pageSize: number = 100,
  ): Promise<void> {
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const batch = await query
        .clone()
        .offset(offset)
        .limit(pageSize)
        .execute(this.client);
      for (let i = 0; i < batch.length; i++) {
        await callback(batch[i]!, offset + i);
      }
      hasMore = batch.length === pageSize;
      offset += pageSize;
    }
  }

  // ─── FEATURE 26: batch processing callback ────────────────────────

  async eachBatch(
    query: QueryBuilder<T>,
    callback: (batch: T[]) => void | Promise<void>,
    batchSize: number = 100,
  ): Promise<void> {
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const batch = await query
        .clone()
        .offset(offset)
        .limit(batchSize)
        .execute(this.client);
      await callback(batch);
      hasMore = batch.length === batchSize;
      offset += batchSize;
    }
  }

  // ─── FEATURE 27: lockForUpdate (MySQL/Postgres row locking) ───────

  async lockForUpdate(
    id: number | string,
    _client?: DBClient,
  ): Promise<T | null> {
    const client = _client || this.client;
    const dbType = this.getDBType(client);
    const qb = this.find().whereEq("id", id).limit(1);
    if (dbType !== DBType.SQLite && dbType !== DBType.MSSQL) {
      // T-SQL has no `FOR UPDATE`; its equivalent is a table hint
      // (`WITH (UPDLOCK)`), which this builder cannot express. Skipping the
      // clause keeps the statement valid on SQL Server, at the cost of the
      // row lock the other dialects take.
      qb.lock("FOR UPDATE");
    }
    const results = await qb.execute(client);
    return results[0] ?? null;
  }

  // ─── FEATURE 28: createOrGet (Laravel firstOrCreate) ──────────────

  async firstOrCreate(
    conditions: Partial<T>,
    defaults: Partial<T> = {},
    _client?: DBClient,
  ): Promise<T> {
    const client = _client || this.client;
    const existing = await this.findOneBy(conditions, {}, client);
    if (existing) return existing;
    return this.create({ ...conditions, ...defaults }, {}, client);
  }

  // ─── FEATURE 29: createOrGet (Laravel updateOrCreate) ─────────────

  async updateOrCreate(
    conditions: Partial<T>,
    updates: Partial<T>,
    _client?: DBClient,
  ): Promise<T> {
    const client = _client || this.client;
    const existing = await this.findOneBy(conditions, {}, client);
    if (existing) {
      return this.update((existing as any).id, updates, client);
    }
    return this.create({ ...conditions, ...updates }, {}, client);
  }

  // ─── FEATURE 30: first (get first matching row) ───────────────────

  async first(conditions?: Partial<T>): Promise<T | null> {
    const qb = this.find();
    if (conditions) {
      for (const [key, value] of Object.entries(conditions)) {
        if (value === null) {
          qb.whereNull(this.columns[key]?.name ?? key);
        } else {
          qb.whereEq(this.columns[key]?.name ?? key, value);
        }
      }
    }
    qb.limit(1);
    const results = await qb.execute(this.client);
    return results[0] ?? null;
  }

  // ─── FEATURE 31: last (get last matching row) ─────────────────────

  async last(field: string = "id"): Promise<T | null> {
    const colName = this.columns[field]?.name || field;
    const qb = this.find().orderBy(`${colName}`, "DESC").limit(1);
    const results = await qb.execute(this.client);
    return results[0] ?? null;
  }

  // ─── FEATURE 32: random (get a random row) ────────────────────────

  async random(): Promise<T | null> {
    const dbType = this.getDBType();
    let orderByExpr: string;
    if (dbType === DBType.MySQL) {
      orderByExpr = "RAND()";
    } else if (dbType === DBType.MSSQL) {
      // T-SQL has no `RANDOM()`; ordering by a fresh `uniqueidentifier` is the
      // usual way to shuffle rows.
      orderByExpr = "NEWID()";
    } else if (dbType === DBType.SQLite) {
      orderByExpr = "RANDOM()";
    } else {
      orderByExpr = "RANDOM()";
    }
    const qb = this.find().orderBy(orderByExpr).limit(1);
    const results = await qb.execute(this.client);
    return results[0] ?? null;
  }

  // ─── findOrFail / firstOrFail ─────────────────────────────────────

  /**
   * Like {@link findOne}, but throws when nothing matches.
   *
   * Every caller of `findOne` otherwise repeats the same null check, and the
   * one that forgets it fails later, somewhere else, on a missing field.
   *
   * @throws StabilizeError with code `NOT_FOUND_ERROR`.
   * @example
   * ```
   * const user = await repo.findOrFail(id); // never null
   * ```
   */
  async findOrFail(
    id: number | string,
    options: { relations?: string[] } = {},
    _client?: DBClient,
  ): Promise<T> {
    const found = await this.findOne(id, options, _client);
    if (!found) {
      throw new StabilizeError(
        `${this.table} with id ${id} not found`,
        "NOT_FOUND_ERROR",
      );
    }
    return found;
  }

  /**
   * Like {@link first}, but throws when nothing matches. @see findOrFail
   *
   * @throws StabilizeError with code `NOT_FOUND_ERROR`.
   */
  async firstOrFail(
    conditions: Partial<T> = {},
    options: { relations?: string[] } = {},
    _client?: DBClient,
  ): Promise<T> {
    const found = await this.findOneBy(conditions, options, _client);
    if (!found) {
      throw new StabilizeError(
        `No ${this.table} matched ${JSON.stringify(conditions)}`,
        "NOT_FOUND_ERROR",
      );
    }
    return found;
  }

  // ─── Many-to-many link management ─────────────────────────────────

  /**
   * Resolves a relation that must be many-to-many, with its join table and
   * both key columns present.
   */
  private requireJoinRelation(
    relation: string,
    method: string,
  ): { joinTable: string; foreignKey: string; inverseKey: string } {
    const rel = this.relations[relation];
    if (!rel) {
      throw new StabilizeError(
        `Relation ${relation} not found on ${this.table}`,
        "RELATION_ERROR",
      );
    }
    if (rel.type !== RelationType.ManyToMany) {
      throw new StabilizeError(
        `${method}() needs a ManyToMany relation, but ${relation} on ${this.table} is ${RelationType[rel.type]}`,
        "RELATION_ERROR",
      );
    }
    const { joinTable, foreignKey, inverseKey } = rel;
    if (!joinTable || !foreignKey || !inverseKey) {
      throw new StabilizeError(
        `Relation ${relation} on ${this.table} needs a joinTable, foreignKey and inverseKey`,
        "RELATION_ERROR",
      );
    }
    return { joinTable, foreignKey, inverseKey };
  }

  /**
   * Normalises the target ids of a link operation into a deduplicated list.
   *
   * Accepts a single id or a list, drops nullish entries, and collapses
   * duplicates — a list naming the same id twice must link it once, and would
   * otherwise insert two identical rows, since the join table carries no unique
   * constraint to reject the second.
   */
  private normalizeLinkTargets(
    targetIds: number | string | (number | string)[],
  ): (number | string)[] {
    const targets: (number | string)[] = [];
    const seen = new Set<string>();
    for (const value of Array.isArray(targetIds) ? targetIds : [targetIds]) {
      if (value === null || value === undefined) continue;
      const key = String(value);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(value);
    }
    return targets;
  }

  /**
   * The raw values linked to `id` through a many-to-many relation's join table.
   */
  private async fetchLinkedIds(
    id: number | string,
    relation: string,
    client: DBClient,
  ): Promise<any[]> {
    const { joinTable, foreignKey, inverseKey } = this.requireJoinRelation(
      relation,
      "fetchLinkedIds",
    );
    const rows = await client.query<Record<string, any>>(
      `SELECT ${inverseKey} FROM ${joinTable} WHERE ${foreignKey} = ?`,
      [id],
    );
    return rows.map((row) => row[inverseKey]);
  }

  /**
   * Links each of `targetIds` to `id` through a many-to-many relation's join
   * table.
   *
   * Idempotent: a pair that is already linked is left alone, so calling this
   * twice does not create the second link twice.
   *
   * @returns how many links were created.
   * @example
   * ```
   * await postRepo.attach(postId, "tags", [1, 2, 3]);
   * ```
   */
  async attach(
    id: number | string,
    relation: string,
    targetIds: number | string | (number | string)[],
    _client?: DBClient,
  ): Promise<number> {
    const client = _client || this.client;
    const { joinTable, foreignKey, inverseKey } = this.requireJoinRelation(
      relation,
      "attach",
    );
    const wanted = this.normalizeLinkTargets(targetIds);
    if (wanted.length === 0) return 0;

    // Compared as strings: an id read back from the driver is a number while a
    // caller may pass one from a URL as a string, and treating those as
    // different would insert the same link twice.
    const linked = new Set(
      (await this.fetchLinkedIds(id, relation, client)).map((value) =>
        String(value),
      ),
    );
    const missing = wanted.filter((value) => !linked.has(String(value)));
    if (missing.length === 0) return 0;

    await client.queryExec(
      `INSERT INTO ${joinTable} (${foreignKey}, ${inverseKey}) VALUES ${missing
        .map(() => "(?, ?)")
        .join(", ")}`,
      missing.flatMap((targetId) => [id, targetId]),
    );
    await this.invalidateRowCache(id);
    return missing.length;
  }

  /**
   * Removes links between `id` and `targetIds` from a many-to-many relation's
   * join table.
   *
   * Omitting `targetIds` unlinks everything, which is the usual way to clear a
   * relation.
   *
   * @returns how many links were removed.
   * @example
   * ```
   * await postRepo.detach(postId, "tags", [3]); // unlink one tag
   * await postRepo.detach(postId, "tags");      // unlink them all
   * ```
   */
  async detach(
    id: number | string,
    relation: string,
    targetIds?: number | string | (number | string)[],
    _client?: DBClient,
  ): Promise<number> {
    const client = _client || this.client;
    const { joinTable, foreignKey, inverseKey } = this.requireJoinRelation(
      relation,
      "detach",
    );

    let query = `DELETE FROM ${joinTable} WHERE ${foreignKey} = ?`;
    const params: any[] = [id];
    if (targetIds !== undefined) {
      const wanted = this.normalizeLinkTargets(targetIds);
      if (wanted.length === 0) return 0;
      query += ` AND ${inverseKey} IN (${wanted.map(() => "?").join(", ")})`;
      params.push(...wanted);
    }

    const { affectedRows } = await client.queryExec(query, params);
    await this.invalidateRowCache(id);
    return affectedRows;
  }

  /**
   * Makes the set of rows linked to `id` exactly `targetIds`: missing links are
   * created, links absent from the list are removed, and links that are already
   * correct are left untouched.
   *
   * Runs in one transaction, so a failure part way through cannot leave the
   * relation half-updated.
   *
   * @returns how many links were added and how many removed.
   * @example
   * ```
   * await postRepo.sync(postId, "tags", [1, 2]); // ends up linked to 1 and 2
   * ```
   */
  async sync(
    id: number | string,
    relation: string,
    targetIds: (number | string)[],
    _client?: DBClient,
  ): Promise<{ attached: number; detached: number }> {
    const client = _client || this.client;
    const { joinTable, foreignKey, inverseKey } = this.requireJoinRelation(
      relation,
      "sync",
    );

    return client.transaction(async (txClient) => {
      const wanted = this.normalizeLinkTargets(targetIds ?? []);
      const wantedKeys = new Set(wanted.map((value) => String(value)));
      const existing = await this.fetchLinkedIds(id, relation, txClient);
      const existingKeys = new Set(existing.map((value) => String(value)));

      const toAttach = wanted.filter(
        (value) => !existingKeys.has(String(value)),
      );
      const toDetach = existing.filter(
        (value) => !wantedKeys.has(String(value)),
      );

      if (toAttach.length > 0) {
        await txClient.queryExec(
          `INSERT INTO ${joinTable} (${foreignKey}, ${inverseKey}) VALUES ${toAttach
            .map(() => "(?, ?)")
            .join(", ")}`,
          toAttach.flatMap((targetId) => [id, targetId]),
        );
      }
      if (toDetach.length > 0) {
        await txClient.queryExec(
          `DELETE FROM ${joinTable} WHERE ${foreignKey} = ? AND ${inverseKey} IN (${toDetach.map(() => "?").join(", ")})`,
          [id, ...toDetach],
        );
      }

      await this.invalidateRowCache(id);
      return { attached: toAttach.length, detached: toDetach.length };
    });
  }

  // ─── FEATURE 33: columnExists helper ──────────────────────────────

  hasColumn(field: string): boolean {
    return !!this.columns[field];
  }

  // ─── FEATURE 34: getTableName / getSoftDeleteField ────────────────

  getTableName(): string {
    return this.table;
  }

  getSoftDeleteField(): string | null {
    return this.softDeleteField;
  }

  getIsVersioned(): boolean {
    return this.versioned;
  }
}
