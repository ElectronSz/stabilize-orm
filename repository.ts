/**
 * @file repository.ts
 * @description Provides a data access layer for a specific model, handling all CRUD operations.
 * @author ElectronSz
 */

import { Cache } from "./cache";
import { DBClient } from "./client";
import { ConsoleLogger, type Logger } from "./logger";
import { QueryBuilder } from "./query-builder";
import {
  DBType,
  RelationType,
  StabilizeError,
  type CacheConfig,
} from "./types";
import {
  ModelKey,
  ColumnKey,
  ValidatorKey,
  RelationKey,
  SoftDeleteKey,
  VersionedKey,
} from "./decorators";
import { getHooks, type HookType } from "./hooks";

type VersionOperation = "insert" | "update" | "delete";


/**
 * Provides a generic repository for a model `T`.
 * This class abstracts the database interactions for a specific model,
 * offering methods for creating, reading, updating, and deleting records.
 * @template T The model entity type.
 */
export class Repository<T> {
  private client: DBClient;
  private cache: Cache | null;
  private table: string;
  private columns: Record<string, { name: string; type: string }>;
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

  /**
   * Creates an instance of Repository.
   * @param client The database client instance for executing queries.
   * @param model The model class constructor, decorated with `@Model`.
   * @param cacheConfig Optional configuration for caching.
   * @param logger A logger instance for logging messages.
   */
  constructor(
    client: DBClient,
    model: new (...args: any[]) => T,
    cacheConfig: CacheConfig = { enabled: false, ttl: 60 },
    logger: Logger = new ConsoleLogger(),
  ) {
    this.client = client;
    this.cache = cacheConfig.enabled ? new Cache(cacheConfig, logger) : null;
    this.table = Reflect.getMetadata(ModelKey, model) || "";
    this.columns = Reflect.getMetadata(ColumnKey, model.prototype) || {};
    this.validators = Reflect.getMetadata(ValidatorKey, model.prototype) || {};
    this.relations = Reflect.getMetadata(RelationKey, model.prototype) || {};
    this.softDeleteField =
      Reflect.getMetadata(SoftDeleteKey, model.prototype) || null;
    this.logger = logger;
    this.versioned = !!Reflect.getMetadata(VersionedKey, model);
    this.historyTable = `${this.table}_history`;
  }

  /**
   * @internal
   * Gets the database type from the client's configuration.
   * @param _client An optional client instance (used in transactions).
   * @returns The `DBType` enum for the current database.
   */
  private getDBType(_client?: DBClient): DBType {
    const client = _client || this.client;
    return client.config.type;
  }

  /**
   * @internal
   * Validates an entity against the 'required' constraints defined in decorators.
   * @param entity The partial entity to validate.
   */
  private validate(entity: Partial<T>) {
    for (const [key, rules] of Object.entries(this.validators)) {
      const value = (entity as any)[key];
      if (
        rules.includes("required") &&
        (value === undefined || value === null)
      ) {
        throw new StabilizeError(
          `Field ${key} is required`,
          "VALIDATION_ERROR",
        );
      }
    }
  }

  /**
  * Runs lifecycle hooks of a given type for the entity.
  * @param entity The entity instance.
  * @param type The hook type (e.g., 'beforeCreate').
  */
  private async runHooks(entity: any, type: HookType): Promise<void> {
    for (const hook of getHooks(entity, type)) {
      await hook();
    }
  }

  /**
   * Creates a new `QueryBuilder` instance for the repository's table.
   * Automatically adds a `WHERE` clause to exclude soft-deleted records if applicable.
   * @returns A `QueryBuilder` instance for constructing a query.
   * @example
   * ```
   * const activeUsersQuery = userRepository.find().where('status = ?', 'active');
   * ```
   */
  find(): QueryBuilder<T> {
    const qb = new QueryBuilder<T>(this.table);
    if (this.softDeleteField) {
      qb.where(`${this.softDeleteField} IS NULL`);
    }
    return qb;
  }

  /**
   * Finds a single record by its primary key (id).
   * @param id The ID of the record to find.
   * @param options Optional: Specify relations to load.
   * @param _client Optional: An internal client for transactions.
   * @returns A promise that resolves to the entity or `null` if not found.
   * @example
   * ```
   * const user = await userRepository.findOne(1);
   * ```
   */
  async findOne(
    id: number | string,
    options: { relations?: string[] } = {},
    _client?: DBClient,
  ): Promise<T | null> {
    const client = _client || this.client;
    const start = performance.now();
    this.logger.logDebug(`Finding one ${this.table} with ID ${id}`);
    const queryBuilder = this.find().where("id = ?", id).limit(1);
    if (options.relations) {
      for (const rel of options.relations) {
        await this.loadRelation(queryBuilder, rel);
      }
    }
    const cacheKey = `findOne:${this.table}:${id}:${options.relations?.join(",")}`;
    const results = await queryBuilder.execute(client, this.cache!, cacheKey);
    this.logger.logDebug(
      `Found ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return results[0] || null;
  }

  /**
 * Snapshot query: get record as it was at a point in time.
 */
  async asOf(
    id: number | string,
    asOfDate: Date,
    _client?: DBClient
  ): Promise<T | null> {
    if (!this.versioned) throw new StabilizeError("Model is not versioned", "VERSIONING_ERROR");
    const client = _client || this.client;
    const rows = await client.query<T>(
      `SELECT * FROM ${this.historyTable} WHERE id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY version DESC LIMIT 1`,
      [id, asOfDate, asOfDate]
    );
    return rows[0] || null;
  }

  /**
 * Get all history for a record.
 */
  async history(
    id: number | string,
    _client?: DBClient
  ): Promise<T[]> {
    if (!this.versioned) throw new StabilizeError("Model is not versioned", "VERSIONING_ERROR");
    const client = _client || this.client;
    return client.query<T>(
      `SELECT * FROM ${this.historyTable} WHERE id = ? ORDER BY version ASC`,
      [id]
    );
  }



  /**
   * Rollback a record to a previous version.
   */
  async rollback(
    id: number | string,
    version: number,
    _client?: DBClient
  ): Promise<T> {
    if (!this.versioned) throw new StabilizeError("Model is not versioned", "VERSIONING_ERROR");
    const client = _client || this.client;
    return client.transaction(async (txClient) => {
      const rows = await txClient.query<T>(
        `SELECT * FROM ${this.historyTable} WHERE id = ? AND version = ? LIMIT 1`,
        [id, version]
      );
      if (!rows.length) throw new StabilizeError("Version not found", "ROLLBACK_ERROR");

      const entity = rows[0];
      const columns = Object.keys(this.columns).filter((c) => c !== "id");
      const setClause = columns.map((c) => `${this.columns[c]!.name} = ?`).join(", ");
      const params = columns.map((c) => (entity as any)[c]);

      await txClient.query(
        `UPDATE ${this.table} SET ${setClause} WHERE id = ?`,
        [...params, id]
      );
      await this.writeHistory({ ...entity, version: version + 1 }, "update", txClient);
      return this.findOne(id, {}, txClient) as Promise<T>;
    });
  }


  /**
   * Writes a versioned history row for the entity to the history table.
   *
   * This method maps entity property keys to their corresponding SQL column names
   * (as defined in metadata) to ensure that inserts match the schema for all supported
   * databases (Postgres, MySQL, SQLite).
   *
   * This function works for Postgres, MySQL, and SQLite, and uses positional parameters
   * (properly formatted for the target database) for safety and compatibility.
   *
   * @param entity - The entity object being versioned
   * @param operation - The operation performed ("insert", "update", "delete")
   * @param client - The database client to use for the insert
   * @param user - The user/system responsible for the change (default: "system")
   */
  private async writeHistory(
    entity: any,
    operation: VersionOperation,
    client: DBClient,
    user?: string
  ) {
    if (!this.versioned) return;

    // Get property keys and corresponding SQL column names
    const propertyKeys = Object.keys(this.columns);
    const sqlColumnNames = propertyKeys.map((k) => this.columns[k]!.name);

    // Build historyColumns using SQL column names
    const historyColumns = [
      ...sqlColumnNames,
      "operation",
      "version",
      "valid_from",
      "valid_to",
      "modified_by",
      "modified_at"
    ];

    // Map values from entity using property keys
    const values = propertyKeys.map((k) => entity[k]);

    const params = [
      ...values,
      operation,
      entity.version || 1,
      new Date(),
      null,
      user || "system",
      new Date()
    ];
    // Database-agnostic placeholder formatting
    let placeholders: string;
    if (client.config.type === DBType.Postgres) {
      placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
    } else {
      placeholders = params.map(() => "?").join(", ");
    }

    await client.query(
      `INSERT INTO ${this.historyTable} (${historyColumns.join(", ")}) VALUES (${placeholders})`,
      params
    );
  }

  /**
   * Creates a new record in the database within a transaction.
   * @param entity The data for the new record.
   * @param options Optional: Specify relations to load on the returned entity.
   * @returns A promise that resolves to the newly created entity.
   * @example
   * ```
   * const newUser = await userRepository.create({ name: 'Ciniso Dlamini', email: 'lwazicd@icloud.com' });
   * ```
   */
  async create(
    entity: Partial<T>,
    options: { relations?: string[] } = {},
  ): Promise<T> {
    return this.client.transaction(async (txClient) => {
      const instance = new (Object.getPrototypeOf(entity).constructor || Object)();
      Object.assign(instance, entity);

      await this.runHooks(instance, "beforeCreate");
      await this.runHooks(instance, "beforeSave");

      const result = await this._create(entity, options, txClient);

      await this.runHooks(result, "afterCreate");
      await this.runHooks(result, "afterSave");

      await this.writeHistory(result, "insert", txClient);
      return result;
    });
  }
  /**
   * @internal
   * The private implementation for creating a record, executed within a transaction.
   */
  private async _create(
    entity: Partial<T>,
    options: { relations?: string[] },
    client: DBClient,
  ): Promise<T> {
    const start = performance.now();
    this.logger.logDebug(
      `Creating ${this.table} with data: ${JSON.stringify(entity)}`,
    );
    this.validate(entity);

    const keys = Object.keys(entity).filter((k) => this.columns[k]);
    const columnNames = keys.map((k) => this.columns[k]?.name).join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const params = keys.map((k) => (entity as any)[k]);
    let query = `INSERT INTO ${this.table} (${columnNames}) VALUES (${placeholders})`;

    let insertedResult: T[] | undefined;
    let id: number | string | undefined;
    const dbType = this.getDBType(client);

    if (dbType === DBType.Postgres) {
      query += " RETURNING *";
      insertedResult = await client.query<T>(query, params);
      id = (insertedResult?.[0] as any)?.id;
    } else {
      await client.query(query, params);
      if (dbType === DBType.SQLite) {
        id = (await client.query<{ id: number }>("SELECT last_insert_rowid() as id"))[0]?.id;
      } else if (dbType === DBType.MySQL) {
        const result = await client.query<{ "LAST_INSERT_ID()": number }>("SELECT LAST_INSERT_ID()");
        id = result[0]?.["LAST_INSERT_ID()"];
      }
    }

    if (!id) throw new StabilizeError("Failed to retrieve inserted ID", "INSERT_ERROR");

    const result = insertedResult?.[0] ?? ((await this.findOne(id, options, client)) as T);

    if (this.cache) {
      const cacheKeys = [`find:${this.table}`, `findOne:${this.table}:${id}`];
      await this.cache.invalidate(cacheKeys);
      if (this.cache.getStrategy() === "write-through") {
        await this.cache.set(`findOne:${this.table}:${id}`, [result], 60);
      }
    }

    this.logger.logDebug(
      `Created ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return result;
  }

  /**
   * Creates multiple records in the database in batches.
   * @param entities An array of entities to create.
   * @param options Optional: Specify relations or batch size.
   * @returns A promise that resolves to an array of the newly created entities.
   * @example
   * ```
   * const newUsers = await userRepository.bulkCreate([
   *   { name: 'Ciniso' },
   *   { name: 'Lwazi' }
   * ]);
   * ```
   */
  async bulkCreate(
    entities: Partial<T>[],
    options: { relations?: string[]; batchSize?: number } = {},
  ): Promise<T[]> {
    return this.client.transaction(async (txClient) => {
      // Prepare entity instances for hooks
      const preparedEntities = entities.map(data => {
        const instance = new (this as any).model();
        Object.assign(instance, data);
        return instance;
      });

      for (const entity of preparedEntities) {
        await this.runHooks(entity, "beforeCreate");
        await this.runHooks(entity, "beforeSave");
      }

      const results = await this._bulkCreate(entities, options, txClient);

      for (const result of results) {
        await this.runHooks(result, "afterCreate");
        await this.runHooks(result, "afterSave");
        if (this.versioned) {
          await this.writeHistory(result, "insert", txClient);
        }
      }
      return results;
    });
  }

  /**
   * @internal
   * The private implementation for bulk creating records, executed within a transaction.
   */
  private async _bulkCreate(
    entities: Partial<T>[],
    options: { relations?: string[]; batchSize?: number },
    client: DBClient,
  ): Promise<T[]> {
    const start = performance.now();
    this.logger.logDebug(
      `Bulk creating ${entities.length} ${this.table} entities`,
    );
    if (!entities.length) return [];

    const batchSize = options.batchSize || 1000;
    entities.forEach((entity) => this.validate(entity));

    const dbType = this.getDBType(client);
    const results: T[] = [];

    for (let i = 0; i < entities.length; i += batchSize) {
      const batch = entities.slice(i, i + batchSize);
      const keys = Object.keys(batch[0]!).filter((k) => this.columns[k]);
      const columnNames = keys.map((k) => this.columns[k]?.name).join(", ");

      let query: string;
      let params: any[] = batch.flatMap((entity) =>
        keys.map((k) => (entity as any)[k]),
      );

      if (dbType === DBType.Postgres) {
        // PostgreSQL: numbered placeholders ($1, $2, ...)
        let paramIdx = 1;
        const valuePlaceholders = batch
          .map(
            () =>
              `(${keys.map(() => `$${paramIdx++}`).join(", ")})`
          )
          .join(", ");
        query = `INSERT INTO ${this.table} (${columnNames}) VALUES ${valuePlaceholders} RETURNING *`;
        const batchResults = await client.query<T>(query, params);
        const ids = batchResults.map((r) => (r as any).id);

        // Handle relation loading if needed
        let finalResults = batchResults;
        if (ids.length > 0 && batchResults.length === 0) {
          const queryBuilder = this.find().where(
            `id IN (${ids.map(() => "?").join(", ")})`,
            ...ids,
          );
          if (options.relations) {
            for (const rel of options.relations) {
              await this.loadRelation(queryBuilder, rel);
            }
          }
          finalResults = await queryBuilder.execute(client);
        }
        results.push(...finalResults);

      } else {
        // SQLite/MySQL: ? placeholders
        const placeholders = `(${keys.map(() => "?").join(", ")})`;
        query = `INSERT INTO ${this.table} (${columnNames}) VALUES ${batch.map(() => placeholders).join(", ")}`;
        await client.query(query, params);
        const ids = (
          await client.query<{ id: number }>(
            `SELECT id FROM ${this.table} ORDER BY id DESC LIMIT ?`,
            [batch.length],
          )
        ).map((row) => row.id);

        let batchResults: T[] = [];
        if (ids.length > 0) {
          const queryBuilder = this.find().where(
            `id IN (${ids.map(() => "?").join(", ")})`,
            ...ids,
          );
          if (options.relations) {
            for (const rel of options.relations) {
              await this.loadRelation(queryBuilder, rel);
            }
          }
          batchResults = await queryBuilder.execute(client);
        }
        results.push(...batchResults);
      }
    }

    if (this.cache) await this.cache.invalidatePattern(`find:${this.table}:*`);

    this.logger.logDebug(
      `Bulk created ${results.length} ${this.table} entities in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return results;
  }

  /**
   * Updates a record by its ID within a transaction.
   * @param id The ID of the record to update.
   * @param entity An object containing the fields to update.
   * @returns A promise that resolves to the updated entity.
   * @example
   * ```
   * const updatedUser = await userRepository.update(1, { name: 'Ciniso Dlamini' });
   * ```
   */
  async update(id: number | string, entity: Partial<T>): Promise<T> {
    return this.client.transaction(async (txClient) => {
      const before = await this.findOne(id, {}, txClient);
      if (!before) throw new StabilizeError("Not found", "UPDATE_ERROR");
      const instance = new (Object.getPrototypeOf(before).constructor || Object)();
      Object.assign(instance, before, entity);

      await this.runHooks(instance, "beforeUpdate");
      await this.runHooks(instance, "beforeSave");

      const result = await this._update(id, entity, txClient);

      await this.runHooks(result, "afterUpdate");
      await this.runHooks(result, "afterSave");

      await this.writeHistory(
        { ...before, ...entity, version: (before as any).version ? (before as any).version + 1 : 1 },
        "update",
        txClient
      );
      return result;
    });
  }

  /**
   * @internal
   * The private implementation for updating a record, executed within a transaction.
   */
  private async _update(
    id: number | string,
    entity: Partial<T>,
    client: DBClient,
  ): Promise<T> {
    const start = performance.now();
    this.logger.logDebug(`Updating ${this.table} with ID ${id}`);
    this.validate(entity);

    const keys = Object.keys(entity).filter((k) => this.columns[k]);
    const setClause = keys.map((k) => `${this.columns[k]?.name} = ?`).join(", ");
    const query = `UPDATE ${this.table} SET ${setClause} WHERE id = ?${this.softDeleteField ? ` AND ${this.softDeleteField} IS NULL` : ""}`;
    const params = [...keys.map((k) => (entity as any)[k]), id];
    await client.query(query, params);

    const result = await this.findOne(id, {}, client);
    if (!result) throw new StabilizeError("Failed to find updated record.", "UPDATE_ERROR");

    if (this.cache) {
      const cacheKeys = [`find:${this.table}`, `findOne:${this.table}:${id}`];
      await this.cache.invalidate(cacheKeys);
      if (this.cache.getStrategy() === "write-through") {
        await this.cache.set(`findOne:${this.table}:${id}`, [result], 60);
      }
    }

    this.logger.logDebug(
      `Updated ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return result;
  }

  /**
   * Updates multiple records based on different conditions.
   * @param updates An array of update operations, each with a `where` and `set` clause.
   * @param options Optional: Specify batch size.
   * @returns A promise that resolves when the operation is complete.
   * @example
   * ```
   * await userRepository.bulkUpdate([
   *   { where: { condition: 'id = ?', params: [1] }, set: { status: 'inactive' } },
   *   { where: { condition: 'id = ?', params: [2] }, set: { status: 'inactive' } }
   * ]);
   * ```
   */
  async bulkUpdate(
    updates: { where: { condition: string; params: any[] }; set: Partial<T> }[],
    options: { batchSize?: number } = {},
  ): Promise<void> {
    return this.client.transaction((txClient) =>
      this._bulkUpdate(updates, options, txClient),
    );
  }

  /**
   * @internal
   * The private implementation for bulk updating records, executed within a transaction.
   */
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
    updates.forEach((update) => this.validate(update.set));

    for (let i = 0; i < updates.length; i += batchSize) {
      const batch = updates.slice(i, i + batchSize);
      for (const update of batch) {
        // Find all IDs matching the where clause
        const rows = await client.query<{ id: number | string }>(
          `SELECT id FROM ${this.table} WHERE ${update.where.condition}${this.softDeleteField ? ` AND ${this.softDeleteField} IS NULL` : ""}`,
          update.where.params,
        );
        for (const { id } of rows) {
          // Fetch record before update for versioning
          const before = await this.findOne(id, {}, client);
          if (!before) continue;

          // Prepare instance for hooks
          const instance = new ((this as any).model || Object)();
          Object.assign(instance, before, update.set);

          await this.runHooks(instance, "beforeUpdate");
          await this.runHooks(instance, "beforeSave");

          const keys = Object.keys(update.set).filter((k) => this.columns[k]);
          const setClause = keys.map((k) => `${this.columns[k]?.name} = ?`).join(", ");
          const query = `UPDATE ${this.table} SET ${setClause} WHERE id = ?${this.softDeleteField ? ` AND ${this.softDeleteField} IS NULL` : ""}`;
          const params = [
            ...keys.map((k) => (update.set as any)[k]),
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
                  version: (before as any).version ? (before as any).version + 1 : 1
                },
                "update",
                client
              );
            }
          }
        }
      }
    }

    if (this.cache) await this.cache.invalidatePattern(`find:${this.table}:*`);

    this.logger.logDebug(
      `Bulk updated ${updates.length} ${this.table} entities in ${(performance.now() - start).toFixed(2)}ms`,
    );
  }
  /**
   * Performs an "update or insert" operation based on a set of unique keys.
   * @param entity The entity to upsert.
   * @param keys The list of key names that uniquely identify a record.
   * @returns A promise that resolves to the upserted entity.
   * @example
   * ```
   * const user = await userRepository.upsert({ email: 'lwazicd@icloud.com', name: 'Lwazi' }, ['email']);
   * ```
   */
  async upsert(entity: Partial<T>, keys: string[]): Promise<T> {
    return this.client.transaction((txClient) =>
      this._upsert(entity, keys, txClient),
    );
  }

  /**
   * @internal
   * The private implementation for an upsert operation, executed within a transaction.
   */
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
    const columns = Object.keys(entity).filter((k) => this.columns[k]);
    const columnNames = columns.map((k) => this.columns[k]?.name).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const updateClause = columns
      .filter((c) => !keys.includes(c))
      .map((c) => `${this.columns[c]?.name} = ?`).join(", ");

    let query: string;
    const updateParams = columns.filter((c) => !keys.includes(c)).map((k) => (entity as any)[k]);
    const insertParams = columns.map((k) => (entity as any)[k]);
    let params = [...insertParams, ...updateParams];

    // Try to find the record before upsert
    let before: T | null = null;
    let isUpdate = false;
    if (this.versioned && keys.length > 0) {
      const whereClause = keys.map((k) => `${this.columns[k]?.name} = ?`).join(" AND ");
      const whereParams = keys.map((k) => (entity as any)[k]);
      const found = await client.query<T>(
        `SELECT * FROM ${this.table} WHERE ${whereClause} LIMIT 1`,
        whereParams
      );
      before = found[0] || null;
      isUpdate = !!before;
    }

    // Prepare instance for hooks
    const instance = new ((this as any).model || Object)();
    Object.assign(instance, before || {}, entity);

    if (isUpdate) {
      await this.runHooks(instance, "beforeUpdate");
      await this.runHooks(instance, "beforeSave");
    } else {
      await this.runHooks(instance, "beforeCreate");
      await this.runHooks(instance, "beforeSave");
    }

    if (dbType === DBType.SQLite) {
      query = `INSERT INTO ${this.table} (${columnNames}) VALUES (${placeholders}) ON CONFLICT(${keys.map((k) => this.columns[k]!.name).join(", ")}) DO UPDATE SET ${updateClause}`;
    } else if (dbType === DBType.MySQL) {
      query = `INSERT INTO ${this.table} (${columnNames}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateClause}`;
    } else { // PostgreSQL
      const pgUpdateClause = columns
        .filter((c) => !keys.includes(c))
        .map((c) => `${this.columns[c]?.name} = EXCLUDED.${this.columns[c]?.name}`).join(", ");
      query = `INSERT INTO ${this.table} (${columnNames}) VALUES (${placeholders}) ON CONFLICT (${keys.map((k) => this.columns[k]!.name).join(", ")}) DO UPDATE SET ${pgUpdateClause} RETURNING *`;
      params = insertParams;
    }

    const results = await client.query<T>(query, params);
    let id: number | string | undefined = (results[0] as any)?.id || (entity as any).id;

    if (!id && dbType !== DBType.Postgres) {
      if (dbType === DBType.SQLite) {
        id = (await client.query<{ id: number }>("SELECT last_insert_rowid() as id"))[0]?.id;
      } else if (dbType === DBType.MySQL) {
        const result = await client.query<{ "LAST_INSERT_ID()": number }>("SELECT LAST_INSERT_ID()");
        id = result[0]?.["LAST_INSERT_ID()"];
      }
    }

    if (!id) throw new StabilizeError("Failed to retrieve upserted ID", "UPSERT_ERROR");

    const result = results[0] ?? ((await this.findOne(id, {}, client)) as T);

    if (isUpdate) {
      await this.runHooks(result, "afterUpdate");
      await this.runHooks(result, "afterSave");
    } else {
      await this.runHooks(result, "afterCreate");
      await this.runHooks(result, "afterSave");
    }

    if (this.cache) {
      await this.cache.invalidatePattern(`find:${this.table}:*`);
      if (this.cache.getStrategy() === "write-through") {
        await this.cache.set(`findOne:${this.table}:${id}`, [result], 60);
      }
    }

    if (this.versioned) {
      await this.writeHistory(
        { ...result, version: before ? ((before as any).version ? (before as any).version + 1 : 1) : 1 },
        before ? "update" : "insert",
        client
      );
    }

    this.logger.logDebug(
      `Upserted ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return result;
  }
  /**
   * Deletes a record by its ID. Performs a soft delete if enabled on the model.
   * @param id The ID of the record to delete.
   * @returns A promise that resolves when the operation is complete.
   * @example
   * ```
   * await userRepository.delete(1);
   * ```
   */
  async delete(id: number | string): Promise<void> {
    return this.client.transaction(async (txClient) => {
      const before = await this.findOne(id, {}, txClient);
      if (!before) throw new StabilizeError("Not found", "DELETE_ERROR");
      await this.runHooks(before, "beforeDelete");

      await this._delete(id, txClient);

      await this.runHooks(before, "afterDelete");
      await this.writeHistory(before, "delete", txClient);
    });
  }

  /**
   * @internal
   * The private implementation for deleting a record, executed within a transaction.
   */
  private async _delete(id: number | string, client: DBClient): Promise<void> {
    const start = performance.now();
    this.logger.logDebug(`Deleting ${this.table} with ID ${id}`);

    const query = this.softDeleteField
      ? `UPDATE ${this.table} SET ${this.softDeleteField} = ? WHERE id = ?`
      : `DELETE FROM ${this.table} WHERE id = ?`;
    const params = this.softDeleteField ? [new Date().toISOString(), id] : [id];

    await client.query(query, params);

    if (this.cache) {
      await this.cache.invalidate([
        `find:${this.table}`,
        `findOne:${this.table}:${id}`,
      ]);
    }
    this.logger.logDebug(
      `Deleted ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
    );
  }

  /**
   * Deletes multiple records by their IDs in batches.
   * @param ids An array of IDs to delete.
   * @param options Optional: Specify batch size.
   * @returns A promise that resolves when the operation is complete.
   * @example
   * ```
   * await userRepository.bulkDelete([1, 2, 3]);
   * ```
   */
  async bulkDelete(
    ids: (number | string)[],
    options: { batchSize?: number } = {},
  ): Promise<void> {
    return this.client.transaction((txClient) =>
      this._bulkDelete(ids, options, txClient),
    );
  }

  /**
   * @internal
   * The private implementation for bulk deleting records, executed within a transaction.
   */
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
          ? `UPDATE ${this.table} SET ${this.softDeleteField} = ? WHERE id = ?`
          : `DELETE FROM ${this.table} WHERE id = ?`;
        const params = this.softDeleteField ? [new Date().toISOString(), id] : [id];

        await client.query(query, params);

        await this.runHooks(before, "afterDelete");

        if (this.versioned) {
          await this.writeHistory(before, "delete", client);
        }
      }
    }

    if (this.cache) await this.cache.invalidatePattern(`find:${this.table}:*`);

    this.logger.logDebug(
      `Bulk deleted ${ids.length} ${this.table} entities in ${(performance.now() - start).toFixed(2)}ms`,
    );
  }
  /**
   * Recovers a soft-deleted record by its ID.
   * Throws an error if soft delete is not enabled on the model.
   * @param id The ID of the record to recover.
   * @returns A promise that resolves to the recovered entity.
   * @example
   * ```
   * const recoveredUser = await userRepository.recover(1);
   * ```
   */
  async recover(id: number | string): Promise<T> {
    return this.client.transaction((txClient) => this._recover(id, txClient));
  }

  /**
   * @internal
   * The private implementation for recovering a record, executed within a transaction.
   */
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
      `UPDATE ${this.table} SET ${this.softDeleteField} = NULL WHERE id = ?`,
      [id],
    );

    const result = await this.findOne(id, {}, client);
    if (!result) throw new StabilizeError("Failed to find recovered record.", "RECOVER_ERROR");

    if (this.cache) {
      await this.cache.invalidate([
        `find:${this.table}`,
        `findOne:${this.table}:${id}`,
      ]);
    }

    this.logger.logDebug(
      `Recovered ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return result;
  }

  /**
   * Executes a raw SQL query directly against the database.
   * Bypasses most ORM abstractions. Use with caution.
   * @param query The raw SQL query string with `?` placeholders.
   * @param params An array of parameters to bind to the query.
   * @returns A promise that resolves to an array of results.
   * @example
   * ```
   * const activeUsers = await userRepository.rawQuery('SELECT * FROM users WHERE status = ?', ['active']);
   * ```
   */
  async rawQuery<T>(query: string, params: any[] = []): Promise<T[]> {
    const start = performance.now();
    this.logger.logDebug(`Executing raw query: ${query}`);
    const result = await this.client.query<T>(query, params);
    this.logger.logDebug(
      `Raw query completed in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return result;
  }

  /**
   * @internal
   * Loads a relation by adding the appropriate JOIN clause to a query builder.
   * @param queryBuilder The `QueryBuilder` instance to modify.
   * @param relation The name of the relation to load.
   */
  private async loadRelation(queryBuilder: QueryBuilder<T>, relation: string) {
    this.logger.logDebug(`Loading relation ${relation} for ${this.table}`);
    const rel = this.relations[relation];
    if (!rel)
      throw new StabilizeError(
        `Relation ${relation} not found`,
        "RELATION_ERROR",
      );

    const relatedTable = Reflect.getMetadata(ModelKey, rel.targetModel());
    if (
      rel.type === RelationType.OneToOne ||
      rel.type === RelationType.ManyToOne
    ) {
      queryBuilder.join(
        relatedTable,
        `${this.table}.${rel.foreignKey} = ${relatedTable}.id`,
      );
    } else if (rel.type === RelationType.OneToMany) {
      queryBuilder.join(
        relatedTable,
        `${relatedTable}.${rel.inverseKey} = ${this.table}.id`,
      );
    } else if (rel.type === RelationType.ManyToMany) {
      queryBuilder
        .join(
          rel.joinTable!,
          `${rel.joinTable}.${rel.foreignKey} = ${this.table}.id`,
        )
        .join(
          relatedTable,
          `${relatedTable}.id = ${rel.joinTable}.${rel.inverseKey}`,
        );
    }
  }
}