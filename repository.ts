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
} from "./decorators";

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
    return this.client.transaction((txClient) =>
      this._create(entity, options, txClient),
    );
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
    return this.client.transaction((txClient) =>
      this._bulkCreate(entities, options, txClient),
    );
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
    return this.client.transaction((txClient) =>
      this._update(id, entity, txClient),
    );
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
        const keys = Object.keys(update.set).filter((k) => this.columns[k]);
        const setClause = keys.map((k) => `${this.columns[k]?.name} = ?`).join(", ");
        const query = `UPDATE ${this.table} SET ${setClause} WHERE ${update.where.condition}${this.softDeleteField ? ` AND ${this.softDeleteField} IS NULL` : ""}`;
        const params = [
          ...keys.map((k) => (update.set as any)[k]),
          ...update.where.params,
        ];
        await client.query(query, params);
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

    if (this.cache) {
      await this.cache.invalidatePattern(`find:${this.table}:*`);
      if (this.cache.getStrategy() === "write-through") {
        await this.cache.set(`findOne:${this.table}:${id}`, [result], 60);
      }
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
    return this.client.transaction((txClient) => this._delete(id, txClient));
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
      const placeholders = batch.map(() => "?").join(", ");
      const query = this.softDeleteField
        ? `UPDATE ${this.table} SET ${this.softDeleteField} = ? WHERE id IN (${placeholders})`
        : `DELETE FROM ${this.table} WHERE id IN (${placeholders})`;
      const params = this.softDeleteField
        ? [new Date().toISOString(), ...batch]
        : batch;
      await client.query(query, params);
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