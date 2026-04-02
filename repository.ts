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

type VersionOperation = "insert" | "update" | "delete";

export class Repository<T> {
  private client: DBClient;
  private cache: Cache | null;
  private table: string;
  private columns: Record<
    string,
    {
      name: string;
      type: string;
      minLength?: number;
      maxLength?: number;
      pattern?: RegExp;
      customValidator?: (val: any) => boolean | string;
      encrypted?: boolean;
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
  private timestampsConfig: { createdAt?: string; updatedAt?: string } | null;

  constructor(
    client: DBClient,
    model: new (...args: any[]) => T,
    cacheConfig: CacheConfig = { enabled: false, ttl: 60 },
    logger: Logger = new StabilizeLogger(),
  ) {
    this.client = client;
    this.cache = cacheConfig.enabled ? new Cache(cacheConfig, logger) : null;
    this.table = MetadataStorage.getTableName(model);
    this.columns = Object.fromEntries(
      Object.entries(MetadataStorage.getColumns(model)).map(([key, col]) => [
        key,
        {
          name: col.name ?? key,
          type: typeof col.type === "string" ? col.type : DataTypes[col.type],
        },
      ]),
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
    this.timestampsConfig = MetadataStorage.getTimestamps(model);
    this.logger = logger;
    this.versioned = MetadataStorage.isVersioned(model);
    this.historyTable = `${this.table}_history`;
    this.model = model;
  }

  private getOptimisticLockField(model: Function): string | null {
    const columns = MetadataStorage.getColumns(model);
    for (const [key, col] of Object.entries(columns)) {
      if ((col as any).optimisticLock) return key;
    }
    return null;
  }

  private getDBType(_client?: DBClient): DBType {
    const client = _client || this.client;
    return client.config.type;
  }

  private validate(entity: Partial<T>, skipRequired: boolean = false) {
    for (const [key, rules] of Object.entries(this.validators)) {
      const value = (entity as any)[key];

      if (
        !skipRequired &&
        rules.includes("required") &&
        (value === undefined || value === null)
      ) {
        throw new StabilizeError(
          `Field ${key} is required`,
          "VALIDATION_ERROR",
        );
      }

      if (value === undefined || value === null) continue;

      const column = this.columns?.[key];
      if (!column) continue;

      if (
        column.minLength &&
        typeof value === "string" &&
        value.length < column.minLength
      ) {
        throw new StabilizeError(`Field ${key} too short`, "VALIDATION_ERROR");
      }

      if (
        column.maxLength &&
        typeof value === "string" &&
        value.length > column.maxLength
      ) {
        throw new StabilizeError(`Field ${key} too long`, "VALIDATION_ERROR");
      }

      if (
        column.pattern &&
        typeof value === "string" &&
        !column.pattern.test(value)
      ) {
        throw new StabilizeError(
          `Field ${key} does not match pattern`,
          "VALIDATION_ERROR",
        );
      }

      if (typeof column.customValidator === "function") {
        const result = column.customValidator(value);
        if (result !== true) {
          throw new StabilizeError(result as string, "VALIDATION_ERROR");
        }
      }
    }
  }

  private async runHooks(entity: any, type: HookType): Promise<void> {
    for (const hook of getHooks(entity, type)) {
      await hook.callback(entity);
    }
  }

  find(): QueryBuilder<T> {
    const qb = new QueryBuilder<T>(this.table);
    if (this.softDeleteField) {
      qb.where(`${this.table}.${this.softDeleteField} IS NULL`);
    }
    return qb;
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
    const queryBuilder = this.find().where(`${this.table}.id = ?`, id).limit(1);
    if (options.relations) {
      for (const rel of options.relations) {
        if (rel.includes(".")) {
          await this.loadNestedRelations(queryBuilder, rel);
        } else {
          await this.loadRelation(queryBuilder, rel);
        }
      }
      // Use qualified SELECT to avoid ambiguous columns with joins
      queryBuilder.select(`${this.table}.*`);
    }
    const cacheKey = `findOne:${this.table}:${id}:${options.relations?.join(",")}`;
    const results = await queryBuilder.execute(client, this.cache!, cacheKey);
    const result = this.processForLoad(results);
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
    const rows = await client.query<T>(
      `SELECT * FROM ${this.historyTable} WHERE id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY version DESC LIMIT 1`,
      [id, asOfDate, asOfDate],
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
        `SELECT * FROM ${this.historyTable} WHERE id = ? AND version = ? LIMIT 1`,
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
  ): Promise<T> {
    return this.client.transaction(async (txClient) => {
      const instance = new this.model() as T;
      Object.assign(instance as object, entity);

      await this.runHooks(instance, "beforeCreate");
      await this.runHooks(instance, "beforeSave");

      const result = await this._create(entity, options, txClient);

      await this.runHooks(result, "afterCreate");
      await this.runHooks(result, "afterSave");

      await this.writeHistory(result, "insert", txClient);
      return result;
    });
  }

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
    const entityToSave = this.processForSave(entity);

    const timestamps = this.timestampsConfig;
    const entityWithTimestamps = { ...entityToSave } as Record<string, any>;
    if (timestamps?.createdAt && !entityWithTimestamps[timestamps.createdAt]) {
      entityWithTimestamps[timestamps.createdAt] = new Date();
    }
    if (timestamps?.updatedAt && !entityWithTimestamps[timestamps.updatedAt]) {
      entityWithTimestamps[timestamps.updatedAt] = new Date();
    }

    const keys = Object.keys(entityWithTimestamps).filter(
      (k) => this.columns[k],
    );
    const columnNames = keys.map((k) => this.columns[k]?.name).join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const params = keys.map((k) => (entityWithTimestamps as any)[k]);
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

  async bulkCreate(
    entities: Partial<T>[],
    options: { relations?: string[]; batchSize?: number } = {},
  ): Promise<T[]> {
    return this.client.transaction(async (txClient) => {
      const preparedEntities = entities.map((data) => {
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

    const timestamps = this.timestampsConfig;
    const entitiesWithTimestamps = entities.map((entity) => ({
      ...entity,
      ...(timestamps?.createdAt &&
      !(entity as Record<string, any>)[timestamps.createdAt]
        ? { [timestamps.createdAt]: new Date() }
        : {}),
      ...(timestamps?.updatedAt &&
      !(entity as Record<string, any>)[timestamps.updatedAt]
        ? { [timestamps.updatedAt]: new Date() }
        : {}),
    })) as Partial<T>[];

    const dbType = this.getDBType(client);
    const results: T[] = [];

    for (let i = 0; i < entitiesWithTimestamps.length; i += batchSize) {
      const batch = entitiesWithTimestamps.slice(i, i + batchSize);
      const keys = Object.keys(batch[0]!).filter((k) => this.columns[k]);
      const columnNames = keys.map((k) => this.columns[k]?.name).join(", ");

      let query: string;
      let params: any[] = batch.flatMap((entity) =>
        keys.map((k) => (entity as any)[k]),
      );

      if (dbType === DBType.Postgres) {
        let paramIdx = 1;
        const valuePlaceholders = batch
          .map(() => `(${keys.map(() => `$${paramIdx++}`).join(", ")})`)
          .join(", ");
        query = `INSERT INTO ${this.table} (${columnNames}) VALUES ${valuePlaceholders} RETURNING *`;
        const batchResults = await client.query<T>(query, params);
        results.push(...batchResults);
      } else {
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

  async update(id: number | string, entity: Partial<T>): Promise<T> {
    return this.client.transaction(async (txClient) => {
      const before = await this.findOne(id, {}, txClient);
      if (!before) throw new StabilizeError("Not found", "UPDATE_ERROR");
      const instance = new this.model() as T;
      Object.assign(instance as object, before, entity);

      await this.runHooks(instance, "beforeUpdate");
      await this.runHooks(instance, "beforeSave");

      const result = await this._update(id, entity, before, txClient);

      await this.runHooks(result, "afterUpdate");
      await this.runHooks(result, "afterSave");

      await this.writeHistory(
        {
          ...before,
          ...entity,
          version: (before as any).version ? (before as any).version + 1 : 1,
        },
        "update",
        txClient,
      );
      return result;
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
      entityWithTimestamps[timestamps.updatedAt] = new Date();
    }

    const keys = Object.keys(entityWithTimestamps).filter(
      (k) => this.columns[k],
    );
    const setClause = keys
      .map((k) => `${this.columns[k]?.name} = ?`)
      .join(", ");

    const whereParts: string[] = ["id = ?"];
    const queryParams = [...keys.map((k) => (entity as any)[k]), id];

    if (this.optimisticLockField) {
      const lockValue = (before as any)[this.optimisticLockField];
      if (lockValue !== undefined) {
        whereParts.push(`${this.optimisticLockField} = ?`);
        queryParams.push(lockValue);
        const newLockVal =
          typeof lockValue === "number" ? lockValue + 1 : lockValue;
        entityWithTimestamps[this.optimisticLockField] = newLockVal;
        const lockColIdx = keys.findIndex(
          (k) => k === this.optimisticLockField,
        );
        if (lockColIdx !== -1) {
          queryParams[lockColIdx] = newLockVal;
        }
      }
    }

    if (this.softDeleteField) {
      whereParts.push(`${this.softDeleteField} IS NULL`);
    }

    const query = `UPDATE ${this.table} SET ${setClause} WHERE ${whereParts.join(" AND ")}`;
    const { affectedRows } = await client.queryExec(query, queryParams);

    if (
      this.optimisticLockField &&
      (before as any)[this.optimisticLockField] !== undefined
    ) {
      if (affectedRows === 0) {
        throw new StabilizeError(
          `Record was modified by another transaction (optimistic lock conflict on ${this.optimisticLockField})`,
          "CONCURRENT_MODIFICATION",
        );
      }
    }

    const result = await this.findOne(id, {}, client);

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
    return result as T;
  }

  async bulkUpdate(
    updates: { where: { condition: string; params: any[] }; set: Partial<T> }[],
    options: { batchSize?: number } = {},
  ): Promise<void> {
    return this.client.transaction((txClient) =>
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
    updates.forEach((update) => this.validate(update.set));

    const timestamps = this.timestampsConfig;

    for (let i = 0; i < updates.length; i += batchSize) {
      const batch = updates.slice(i, i + batchSize);
      for (const update of batch) {
        const rows = await client.query<{ id: number | string }>(
          `SELECT id FROM ${this.table} WHERE ${update.where.condition}${this.softDeleteField ? ` AND ${this.softDeleteField} IS NULL` : ""}`,
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
          const query = `UPDATE ${this.table} SET ${setClause} WHERE id = ?${this.softDeleteField ? ` AND ${this.softDeleteField} IS NULL` : ""}`;
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

    if (this.cache) await this.cache.invalidatePattern(`find:${this.table}:*`);

    this.logger.logDebug(
      `Bulk updated ${updates.length} ${this.table} entities in ${(performance.now() - start).toFixed(2)}ms`,
    );
  }

  async upsert(entity: Partial<T>, keys: string[]): Promise<T> {
    return this.client.transaction((txClient) =>
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
    const columns = Object.keys(entity).filter((k) => this.columns[k]);
    const columnNames = columns.map((k) => this.columns[k]?.name).join(", ");
    const placeholders = columns.map(() => "?").join(", ");

    const updateClause = columns
      .filter((c) => !keys.includes(c))
      .map((c) => `${this.columns[c]?.name} = ?`)
      .join(", ");

    let query: string;
    const updateParams = columns
      .filter((c) => !keys.includes(c))
      .map((k) => (entity as any)[k]);
    const insertParams = columns.map((k) => (entity as any)[k]);
    let params = [...insertParams, ...updateParams];

    let before: T | null = null;
    let isUpdate = false;
    if (this.versioned && keys.length > 0) {
      const whereClause = keys
        .map((k) => `${this.columns[k]?.name} = ?`)
        .join(" AND ");
      const whereParams = keys.map((k) => (entity as any)[k]);
      const found = await client.query<T>(
        `SELECT * FROM ${this.table} WHERE ${whereClause} LIMIT 1`,
        whereParams,
      );
      before = found[0] || null;
      isUpdate = !!before;
    }

    const instance = new this.model() as T;
    Object.assign(instance as object, before || {}, entity);

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
    } else {
      const pgUpdateClause = columns
        .filter((c) => !keys.includes(c))
        .map(
          (c) => `${this.columns[c]?.name} = EXCLUDED.${this.columns[c]?.name}`,
        )
        .join(", ");
      query = `INSERT INTO ${this.table} (${columnNames}) VALUES (${placeholders}) ON CONFLICT (${keys.map((k) => this.columns[k]!.name).join(", ")}) DO UPDATE SET ${pgUpdateClause} RETURNING *`;
      params = insertParams;
    }

    const results = await client.query<T>(query, params);
    let id: number | string | undefined =
      (results[0] as any)?.id || (entity as any).id;

    if (!id && dbType !== DBType.Postgres) {
      if (dbType === DBType.SQLite) {
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
        "Failed to retrieve upserted ID",
        "UPSERT_ERROR",
      );

    const result = results[0] ?? ((await this.findOne(id, {}, client)) as T);

    if (isUpdate) {
      await this.runHooks(result, "afterUpdate");
      await this.runHooks(result, "afterSave");
    } else {
      await this.runHooks(result, "afterCreate");
      await this.runHooks(result, "afterSave");
    }

    if (this.versioned) {
      await this.writeHistory(
        {
          ...result,
          version: before
            ? (before as any).version
              ? (before as any).version + 1
              : 1
            : 1,
        },
        before ? "update" : "insert",
        client,
      );
    }

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

  async bulkDelete(
    ids: (number | string)[],
    options: { batchSize?: number } = {},
  ): Promise<void> {
    return this.client.transaction((txClient) =>
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
          ? `UPDATE ${this.table} SET ${this.softDeleteField} = ? WHERE id = ?`
          : `DELETE FROM ${this.table} WHERE id = ?`;
        const params = this.softDeleteField
          ? [new Date().toISOString(), id]
          : [id];

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

  async recover(id: number | string): Promise<T> {
    return this.client.transaction((txClient) => this._recover(id, txClient));
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
      `UPDATE ${this.table} SET ${this.softDeleteField} = NULL WHERE id = ?`,
      [id],
    );

    const result = await this.findOne(id, {}, client);
    if (!result)
      throw new StabilizeError(
        "Failed to find recovered record.",
        "RECOVER_ERROR",
      );

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

  async rawQuery<R = T>(query: string, params: any[] = []): Promise<R[]> {
    const start = performance.now();
    this.logger.logDebug(`Executing raw query: ${query}`);
    const result = await this.client.query<R>(query, params);
    this.logger.logDebug(
      `Raw query completed in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return result;
  }

  private async loadRelation(queryBuilder: QueryBuilder<T>, relation: string) {
    this.logger.logDebug(`Loading relation ${relation} for ${this.table}`);
    const rel = this.relations[relation];
    if (!rel)
      throw new StabilizeError(
        `Relation ${relation} not found`,
        "RELATION_ERROR",
      );

    const relatedTable = MetadataStorage.getTableName(rel.targetModel());
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

  private async loadNestedRelations(
    queryBuilder: QueryBuilder<T>,
    relationPath: string,
  ) {
    const parts = relationPath.split(".");
    let currentTable = this.table;
    let currentRelations = this.relations;

    for (let i = 0; i < parts.length; i++) {
      const relName = parts[i]!;
      const rel = currentRelations[relName];
      if (!rel)
        throw new StabilizeError(
          `Relation ${relName} not found on ${currentTable}`,
          "RELATION_ERROR",
        );

      const relatedTable = MetadataStorage.getTableName(rel.targetModel());
      if (
        rel.type === RelationType.OneToOne ||
        rel.type === RelationType.ManyToOne
      ) {
        queryBuilder.join(
          relatedTable,
          `${currentTable}.${rel.foreignKey} = ${relatedTable}.id`,
        );
      } else if (rel.type === RelationType.OneToMany) {
        queryBuilder.join(
          relatedTable,
          `${relatedTable}.${rel.inverseKey} = ${currentTable}.id`,
        );
      } else if (rel.type === RelationType.ManyToMany) {
        queryBuilder
          .join(
            rel.joinTable!,
            `${rel.joinTable}.${rel.foreignKey} = ${currentTable}.id`,
          )
          .join(
            relatedTable,
            `${relatedTable}.id = ${rel.joinTable}.${rel.inverseKey}`,
          );
      }

      if (i < parts.length - 1) {
        const nestedModel = rel.targetModel();
        const nestedRels = MetadataStorage.getRelations(nestedModel);
        currentRelations = nestedRels as any;
        currentTable = relatedTable;
      }
    }
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
      countQuery += ` WHERE ${this.table}.${this.softDeleteField} IS NULL`;
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
    return processed;
  }

  private processForLoad(row: any): any {
    const processed = { ...row };
    for (const [key, col] of Object.entries(this.columns)) {
      if ((col as any).encrypted && processed[key]) {
        try {
          processed[key] = decrypt(processed[key]);
        } catch {
          processed[key] = null;
        }
      }
    }
    return processed;
  }

  // ─── FEATURE 1: findAndCount ──────────────────────────────────────

  async findAndCount(
    options: { relations?: string[] } = {},
  ): Promise<{ data: T[]; total: number }> {
    const qb = this.find();
    if (options.relations) {
      for (const rel of options.relations) {
        await this.loadRelation(qb, rel);
      }
    }
    const data = await qb.execute(this.client);
    const total = await qb.clone().countExec(this.client);
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
        qb.whereNull(key);
      } else {
        qb.where(`${this.columns[key]?.name} = ?`, value);
      }
    }
    if (options.relations) {
      for (const rel of options.relations) {
        await this.loadRelation(qb, rel);
      }
    }
    const results = await qb.limit(1).execute(client);
    return results[0] ?? null;
  }

  // ─── FEATURE 3: findBy (TypeORM-style) ────────────────────────────

  async findBy(
    conditions: Partial<T>,
    options: { relations?: string[]; limit?: number; orderBy?: string } = {},
  ): Promise<T[]> {
    const qb = this.find();
    for (const [key, value] of Object.entries(conditions)) {
      if (value === null) {
        qb.whereNull(key);
      } else {
        qb.where(`${this.columns[key]?.name} = ?`, value);
      }
    }
    if (options.relations) {
      for (const rel of options.relations) {
        await this.loadRelation(qb, rel);
      }
    }
    if (options.limit) qb.limit(options.limit);
    if (options.orderBy) qb.orderBy(options.orderBy);
    return qb.execute(this.client);
  }

  // ─── FEATURE 4: count (Prisma-style) ──────────────────────────────

  async count(conditions?: Partial<T>): Promise<number> {
    const qb = new QueryBuilder(this.table);
    if (this.softDeleteField) {
      qb.where(`${this.softDeleteField} IS NULL`);
    }
    if (conditions) {
      for (const [key, value] of Object.entries(conditions)) {
        if (value !== undefined && value !== null) {
          qb.where(`${this.columns[key]?.name} = ?`, value);
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
      qb.where(`${this.softDeleteField} IS NULL`);
    }
    if (conditions) {
      for (const [key, value] of Object.entries(conditions)) {
        if (value !== undefined && value !== null) {
          qb.where(`${this.columns[key]?.name} = ?`, value);
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
      qb.where(`${this.softDeleteField} IS NULL`);
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
          qb.whereNull(key);
        } else {
          qb.where(`${this.columns[key]?.name} = ?`, value);
        }
      }
    }

    if (options.cursor) {
      const { field, value, direction = "forward" } = options.cursor;
      const colName = this.columns[field]?.name || field;
      const dir = options.orderBy?.direction || "ASC";
      if (direction === "forward") {
        qb.where(`${colName} ${dir === "ASC" ? ">" : "<"} ?`, value);
      } else {
        qb.where(`${colName} ${dir === "ASC" ? "<" : ">"} ?`, value);
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
    if (options.relations) {
      for (const rel of options.relations) {
        await this.loadRelation(qb, rel);
      }
    }

    return qb.execute(this.client);
  }

  // ─── FEATURE 7: bulk upsert (Prisma-style) ────────────────────────

  async bulkUpsert(entities: Partial<T>[], keys: string[]): Promise<T[]> {
    return this.client.transaction(async (txClient) => {
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
      qb.where(`${this.softDeleteField} IS NULL`);
    }
    if (conditions) {
      for (const [key, value] of Object.entries(conditions)) {
        if (value !== undefined && value !== null) {
          qb.where(`${this.columns[key]?.name} = ?`, value);
        }
      }
    }
    return qb.existsExec(this.client);
  }

  // ─── FEATURE 9: recoverAll (Stabilize-original) ───────────────────

  async recoverAll(): Promise<number> {
    if (!this.softDeleteField) {
      throw new StabilizeError(
        "Soft delete not enabled for this model",
        "RECOVER_ERROR",
      );
    }
    const result = await this.client.queryExec(
      `UPDATE ${this.table} SET ${this.softDeleteField} = NULL WHERE ${this.softDeleteField} IS NOT NULL`,
    );
    return result.affectedRows;
  }

  // ─── FEATURE 10: truncate (Rails-style) ───────────────────────────

  async truncate(): Promise<void> {
    await this.client.queryExec(`DELETE FROM ${this.table}`);
    if (this.cache) {
      await this.cache.invalidatePattern(`find:${this.table}:*`);
    }
  }

  // ─── FEATURE 11: seed framework (Laravel-style) ───────────────────

  async seed(
    data: Partial<T>[],
    options: { ignoreDuplicates?: boolean } = {},
  ): Promise<T[]> {
    if (data.length === 0) return [];

    const existing = await this.find().execute(this.client);
    if (existing.length > 0 && options.ignoreDuplicates) return existing;

    return this.bulkCreate(data);
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
      qb.where(`${this.softDeleteField} IS NULL`);
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
  ): Promise<T> {
    const colName = this.columns[field]?.name || field;
    let query = `UPDATE ${this.table} SET ${colName} = ${colName} + ? WHERE id = ?`;
    if (this.softDeleteField) query += ` AND ${this.softDeleteField} IS NULL`;
    await this.client.queryExec(query, [amount, id]);
    return (await this.findOne(id)) as T;
  }

  async decrement(
    id: number | string,
    field: string,
    amount: number = 1,
  ): Promise<T> {
    const colName = this.columns[field]?.name || field;
    let query = `UPDATE ${this.table} SET ${colName} = ${colName} - ? WHERE id = ?`;
    if (this.softDeleteField) query += ` AND ${this.softDeleteField} IS NULL`;
    await this.client.queryExec(query, [amount, id]);
    return (await this.findOne(id)) as T;
  }

  // ─── FEATURE 15: pluck (Rails-style) ──────────────────────────────

  async pluck<K extends keyof T>(column: K): Promise<any[]> {
    const colName = this.columns[column as string]?.name || (column as string);
    const qb = new QueryBuilder(this.table);
    qb.select(colName);
    if (this.softDeleteField) {
      qb.where(`${this.softDeleteField} IS NULL`);
    }
    const results = await qb.execute(this.client);
    return results.map((r: any) => r[colName]);
  }

  // ─── FEATURE 16: selectColumn (Drizzle-style) ─────────────────────

  async selectColumns(...columns: (keyof T)[]): Promise<Partial<T>[]> {
    const colNames = columns.map(
      (c) => this.columns[c as string]?.name || (c as string),
    );
    const qb = new QueryBuilder(this.table);
    qb.select(...colNames);
    if (this.softDeleteField) {
      qb.where(`${this.softDeleteField} IS NULL`);
    }
    const results = await qb.execute(this.client);
    return results as Partial<T>[];
  }

  // ─── FEATURE 17: toggle (Rails-style) ─────────────────────────────

  async toggle(id: number | string, field: string): Promise<T> {
    const colName = this.columns[field]?.name || field;
    const dbType = this.getDBType();
    const expr =
      dbType === DBType.Postgres
        ? `NOT ${colName}`
        : dbType === DBType.MySQL
          ? `NOT ${colName}`
          : `CASE WHEN ${colName} = 1 THEN 0 ELSE 1 END`;
    let query = `UPDATE ${this.table} SET ${colName} = ${expr} WHERE id = ?`;
    if (this.softDeleteField) query += ` AND ${this.softDeleteField} IS NULL`;
    await this.client.queryExec(query, [id]);
    return (await this.findOne(id)) as T;
  }

  // ─── FEATURE 18: updateBy (TypeORM-style) ─────────────────────────

  async updateBy(conditions: Partial<T>, updates: Partial<T>): Promise<number> {
    const setKeys = Object.keys(updates).filter((k) => this.columns[k]);
    if (setKeys.length === 0) return 0;

    const timestamps = this.timestampsConfig;
    if (timestamps?.updatedAt) {
      (updates as any)[timestamps.updatedAt] = new Date();
    }

    const setClause = setKeys
      .map((k) => `${this.columns[k]?.name} = ?`)
      .join(", ");
    const setParams = setKeys.map((k) => (updates as any)[k]);

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
      whereParts.push(`${this.softDeleteField} IS NULL`);
    }

    const whereClause =
      whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
    const query = `UPDATE ${this.table} SET ${setClause}${whereClause}`;
    const result = await this.client.queryExec(query, [
      ...setParams,
      ...whereParams,
    ]);

    if (this.cache) await this.cache.invalidatePattern(`find:${this.table}:*`);
    return result.affectedRows;
  }

  // ─── FEATURE 19: deleteBy (TypeORM-style) ─────────────────────────

  async deleteBy(conditions: Partial<T>): Promise<number> {
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
      whereParts.push(`${this.softDeleteField} IS NULL`);
      const whereClause =
        whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
      const query = `UPDATE ${this.table} SET ${this.softDeleteField} = ?${whereClause}`;
      const result = await this.client.queryExec(query, [
        new Date().toISOString(),
        ...whereParams,
      ]);
      if (this.cache)
        await this.cache.invalidatePattern(`find:${this.table}:*`);
      return result.affectedRows;
    }

    const whereClause =
      whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
    const result = await this.client.queryExec(
      `DELETE FROM ${this.table}${whereClause}`,
      whereParams,
    );
    if (this.cache) await this.cache.invalidatePattern(`find:${this.table}:*`);
    return result.affectedRows;
  }

  // ─── FEATURE 20: restoreBy (soft-delete recovery by condition) ────

  async restoreBy(conditions: Partial<T>): Promise<number> {
    if (!this.softDeleteField) {
      throw new StabilizeError("Soft delete not enabled", "RECOVER_ERROR");
    }
    const whereParts: string[] = [`${this.softDeleteField} IS NOT NULL`];
    const whereParams: any[] = [];
    for (const [key, value] of Object.entries(conditions)) {
      if (value !== undefined && value !== null) {
        whereParts.push(`${this.columns[key]?.name} = ?`);
        whereParams.push(value);
      }
    }
    const query = `UPDATE ${this.table} SET ${this.softDeleteField} = NULL WHERE ${whereParts.join(" AND ")}`;
    const result = await this.client.queryExec(query, whereParams);
    if (this.cache) await this.cache.invalidatePattern(`find:${this.table}:*`);
    return result.affectedRows;
  }

  // ─── FEATURE 21: onlyTrashed (query soft-deleted only) ────────────

  findDeleted(): QueryBuilder<T> {
    if (!this.softDeleteField) {
      throw new StabilizeError("Soft delete not enabled", "QUERY_ERROR");
    }
    const qb = new QueryBuilder<T>(this.table);
    qb.whereNotNull(this.softDeleteField);
    return qb;
  }

  // ─── FEATURE 22: withTrashed (include soft-deleted in query) ──────

  withTrashed(): QueryBuilder<T> {
    return new QueryBuilder<T>(this.table);
  }

  // ─── FEATURE 23: upsertMany (batch upsert) ────────────────────────

  async upsertMany(
    entities: Partial<T>[],
    keys: string[],
    batchSize: number = 100,
  ): Promise<T[]> {
    const results: T[] = [];
    for (let i = 0; i < entities.length; i += batchSize) {
      const batch = entities.slice(i, i + batchSize);
      const batchResults = await this.bulkUpsert(batch, keys);
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
    const qb = this.find().where("id = ?", id).limit(1);
    if (dbType !== DBType.SQLite) {
      qb.lock("FOR UPDATE");
    }
    const results = await qb.execute(client);
    return results[0] ?? null;
  }

  // ─── FEATURE 28: createOrGet (Laravel firstOrCreate) ──────────────

  async firstOrCreate(
    conditions: Partial<T>,
    defaults: Partial<T> = {},
  ): Promise<T> {
    const existing = await this.findOneBy(conditions);
    if (existing) return existing;
    return this.create({ ...conditions, ...defaults });
  }

  // ─── FEATURE 29: createOrGet (Laravel updateOrCreate) ─────────────

  async updateOrCreate(
    conditions: Partial<T>,
    updates: Partial<T>,
  ): Promise<T> {
    const existing = await this.findOneBy(conditions);
    if (existing) {
      return this.update((existing as any).id, updates);
    }
    return this.create({ ...conditions, ...updates });
  }

  // ─── FEATURE 30: first (get first matching row) ───────────────────

  async first(conditions?: Partial<T>): Promise<T | null> {
    const qb = this.find();
    if (conditions) {
      for (const [key, value] of Object.entries(conditions)) {
        if (value === null) {
          qb.whereNull(key);
        } else {
          qb.where(`${this.columns[key]?.name} = ?`, value);
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
    } else if (dbType === DBType.SQLite) {
      orderByExpr = "RANDOM()";
    } else {
      orderByExpr = "RANDOM()";
    }
    const qb = this.find().orderBy(orderByExpr).limit(1);
    const results = await qb.execute(this.client);
    return results[0] ?? null;
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
