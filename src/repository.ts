import { Cache } from "./cache";
import { DBClient } from "./client";
import { ConsoleLogger, type Logger } from "./logger";
import { QueryBuilder } from "./query-builder";
// DBConfig added to the type imports
import {
  DBType,
  RelationType,
  StabilizeError,
  type CacheConfig,
  type DBConfig,
} from "./types";
import {
  ModelKey,
  ColumnKey,
  ValidatorKey,
  RelationKey,
  SoftDeleteKey,
} from "./decorators";

export class Repository<T> {
  // Client remains DBClient type
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

  private getDBType(): DBType {
    return (this.client as any).config.type;
  }

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
      if (rules.includes("unique")) {
        // Defer unique check to DB
      }
    }
  }

  find(): QueryBuilder<T> {
    const qb = new QueryBuilder<T>(this.table);
    if (this.softDeleteField) {
      qb.where(`${this.softDeleteField} IS NULL`);
    }
    return qb;
  }

  async findOne(
    id: number | string,
    options: { relations?: string[] } = {},
  ): Promise<T | null> {
    const start = performance.now();
    this.logger.logDebug(`Finding one ${this.table} with ID ${id}`);
    const queryBuilder = this.find().where("id = ?", id).limit(1);
    if (options.relations) {
      for (const rel of options.relations) {
        await this.loadRelation(queryBuilder, rel);
      }
    }
    const cacheKey = options.relations
      ? `findOne:${this.table}:${id}:${options.relations.join(",")}`
      : `findOne:${this.table}:${id}`;
    const results = await queryBuilder.execute(
      this.client,
      this.cache!,
      cacheKey,
    );
    this.logger.logDebug(
      `Found ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return results[0] || null;
  }

  async create(
    entity: Partial<T>,
    options: { relations?: string[] } = {},
  ): Promise<T> {
    const start = performance.now();
    this.logger.logDebug(
      `Creating ${this.table} with data: ${JSON.stringify(entity)}`,
    );
    this.validate(entity);
    return await this.client.transaction(async () => {
      const keys = Object.keys(entity).filter((k) => this.columns[k]);
      const columnNames = keys.map((k) => this.columns[k]?.name).join(", ");
      const placeholders = keys.map(() => "?").join(", ");
      const params = keys.map((k) => (entity as any)[k]);

      let query = `INSERT INTO ${this.table} (${columnNames}) VALUES (${placeholders})`;
      let insertedResult: T[] | undefined;
      let id: number | string | undefined;

      const dbType = this.getDBType();

      if (dbType === DBType.Postgres) {
        query += " RETURNING *";
        insertedResult = await this.client.query<T>(query, params);
        id = (insertedResult?.[0] as any)?.id;
      } else {
        await this.client.query(query, params);

        if (dbType === DBType.SQLite) {
          id = (
            await this.client.query<{ id: number }>(
              "SELECT last_insert_rowid() as id",
              [],
            )
          )[0]?.id;
        } else if (dbType === DBType.MySQL) {
          id = (
            await this.client.query<{ id: number }>(
              "SELECT LAST_INSERT_ID() as id",
              [],
            )
          )[0]?.id;
        }
      }

      if (!id)
        throw new StabilizeError(
          "Failed to retrieve inserted ID",
          "INSERT_ERROR",
        );

      const cacheKeys = [`find:${this.table}`, `findOne:${this.table}:${id}`];

      const queryBuilder = this.find().where("id = ?", id);
      if (options.relations) {
        for (const rel of options.relations) {
          await this.loadRelation(queryBuilder, rel);
        }
      }

      // If we are using write-through cache, we fetch the result now and cache it.
      if (this.cache) {
        await this.cache.invalidate(cacheKeys);
        if (this.cache.getStrategy() === "write-through") {
          // Fetch the full result for write-through cache, explicitly casting to T.
          const result = (insertedResult?.[0] ||
            (await queryBuilder.execute(this.client))[0]) as T;
          await this.cache.set(`findOne:${this.table}:${id}`, [result], 60);
          this.logger.logDebug(
            `Created ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
          );
          return result;
        }
      }

      const result = (insertedResult?.[0] ||
        (await queryBuilder.execute(this.client))[0]) as T;
      this.logger.logDebug(
        `Created ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
      );
      return result;
    });
  }

  async bulkCreate(
    entities: Partial<T>[],
    options: { relations?: string[]; batchSize?: number } = {},
  ): Promise<T[]> {
    const start = performance.now();
    this.logger.logDebug(
      `Bulk creating ${entities.length} ${this.table} entities`,
    );
    if (!entities.length) return [];
    const batchSize = options.batchSize || 1000;
    entities.forEach((entity) => this.validate(entity));

    const dbType = this.getDBType();
    const results: T[] = [];

    for (let i = 0; i < entities.length; i += batchSize) {
      const batch = entities.slice(i, i + batchSize);
      await this.client.transaction(async () => {
        const keys = Object.keys(batch[0]!).filter((k) => this.columns[k]);
        const columnNames = keys.map((k) => this.columns[k]?.name).join(", ");
        const placeholders = `(${keys.map(() => "?").join(", ")})`;
        let query = `INSERT INTO ${this.table} (${columnNames}) VALUES ${batch.map(() => placeholders).join(", ")}`;
        const params = batch.flatMap((entity) =>
          keys.map((k) => (entity as any)[k]),
        );

        let batchResults: T[] = [];
        let ids: (number | string)[] = [];

        if (dbType === DBType.Postgres) {
          // PostgreSQL supports RETURNING * for multiple inserts
          query += " RETURNING *";
          batchResults = await this.client.query<T>(query, params);
          ids = batchResults.map((r) => (r as any).id);
        } else {
          // SQLite/MySQL batch insert. ID retrieval remains complex.
          await this.client.query(query, params);

          // Unreliable ID retrieval kept for consistency, but should be reviewed for concurrency
          ids = (
            await this.client.query<{ id: number }>(
              `SELECT id FROM ${this.table} ORDER BY id DESC LIMIT ?`,
              [batch.length],
            )
          ).map((row) => row.id);
        }

        const cacheKeys = ids
          .map((id) => `findOne:${this.table}:${id}`)
          .concat(`find:${this.table}`);

        // If batchResults is empty (non-PostgreSQL), we need to fetch the full records.
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
          batchResults = await queryBuilder.execute(this.client);
        }

        if (this.cache) {
          await this.cache.invalidate(cacheKeys);
          if (this.cache.getStrategy() === "write-through") {
            await this.cache.set(
              `bulkCreate:${this.table}:${ids.join(",")}`,
              batchResults,
              60,
            );
          }
        }
        results.push(...batchResults);
      });
    }
    this.logger.logDebug(
      `Bulk created ${results.length} ${this.table} entities in ${(performance.now() - start).toFixed(2)}ms`,
    );
    return results;
  }

  async update(id: number | string, entity: Partial<T>): Promise<T> {
    const start = performance.now();
    this.logger.logDebug(`Updating ${this.table} with ID ${id}`);
    this.validate(entity);
    return await this.client.transaction(async () => {
      const keys = Object.keys(entity).filter((k) => this.columns[k]);
      const setClause = keys
        .map((k) => `${this.columns[k]?.name} = ?`)
        .join(", ");
      const query = `UPDATE ${this.table} SET ${setClause} WHERE id = ?${this.softDeleteField ? ` AND ${this.softDeleteField} IS NULL` : ""}`;
      const params = [...keys.map((k) => (entity as any)[k]), id];
      await this.client.query(query, params);

      let result: T;

      const cacheKeys = [`find:${this.table}`, `findOne:${this.table}:${id}`];
      if (this.cache) {
        await this.cache.invalidate(cacheKeys);
        if (this.cache.getStrategy() === "write-through") {
          const queryBuilder = this.find().where("id = ?", id);
          // Fetch the result and explicitly cast to T to satisfy the return type.
          result = (await queryBuilder.execute(this.client))[0] as T;
          await this.cache.set(`findOne:${this.table}:${id}`, [result], 60);
          this.logger.logDebug(
            `Updated ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
          );
          return result;
        }
      }

      // Fetch the result and explicitly cast to T. Logically, since we just updated the record, it must exist.
      result = (await this.findOne(id)) as T;
      this.logger.logDebug(
        `Updated ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
      );
      return result;
    });
  }

  async bulkUpdate(
    updates: { where: { condition: string; params: any[] }; set: Partial<T> }[],
    options: { batchSize?: number } = {},
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
      await this.client.transaction(async () => {
        for (const update of batch) {
          const keys = Object.keys(update.set).filter((k) => this.columns[k]);
          const setClause = keys
            .map((k) => `${this.columns[k]?.name} = ?`)
            .join(", ");
          const query = `UPDATE ${this.table} SET ${setClause} WHERE ${update.where.condition}${this.softDeleteField ? ` AND ${this.softDeleteField} IS NULL` : ""}`;
          const params = [
            ...keys.map((k) => (update.set as any)[k]),
            ...update.where.params,
          ];
          await this.client.query(query, params);
        }
        if (this.cache) {
          await this.cache.invalidatePattern(`find:${this.table}:*`);
        }
      });
    }
    this.logger.logDebug(
      `Bulk updated ${updates.length} ${this.table} entities in ${(performance.now() - start).toFixed(2)}ms`,
    );
  }

  async upsert(entity: Partial<T>, keys: string[]): Promise<T> {
    const start = performance.now();
    this.logger.logDebug(
      `Upserting ${this.table} with keys: ${keys.join(", ")}`,
    );
    this.validate(entity);
    return await this.client.transaction(async () => {
      const dbType = this.getDBType();
      const columns = Object.keys(entity).filter((k) => this.columns[k]);
      const columnNames = columns.map((k) => this.columns[k]?.name).join(", ");
      const placeholders = columns.map(() => "?").join(", ");
      const updateClause = columns
        .filter((c) => !keys.includes(c))
        .map((c) => `${this.columns[c]?.name} = ?`)
        .join(", ");

      let query: string;

      if (dbType === DBType.SQLite) {
        query = `INSERT INTO ${this.table} (${columnNames}) VALUES (${placeholders}) ON CONFLICT(${keys.map((k) => this.columns[k]!.name).join(", ")}) DO UPDATE SET ${updateClause}`;
      } else if (dbType === DBType.MySQL) {
        query = `INSERT INTO ${this.table} (${columnNames}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateClause}`;
      } else {
        // PostgreSQL and default
        query = `INSERT INTO ${this.table} (${columnNames}) VALUES (${placeholders}) ON CONFLICT (${keys.map((k) => this.columns[k]!.name).join(", ")}) DO UPDATE SET ${updateClause} RETURNING *`;
      }

      const params = [
        ...columns.map((k) => (entity as any)[k]),
        ...columns
          .filter((c) => !keys.includes(c))
          .map((k) => (entity as any)[k]),
      ];
      const results = await this.client.query<T>(query, params);

      let id: number | string | undefined =
        (results[0] as any)?.id || (entity as any).id;

      // Fallback ID retrieval for non-PostgreSQL if the driver didn't return it
      if (!id && dbType === DBType.SQLite) {
        id = (
          await this.client.query<{ id: number }>(
            "SELECT last_insert_rowid() as id",
            [],
          )
        )[0]?.id;
      } else if (!id && dbType === DBType.MySQL) {
        id = (
          await this.client.query<{ id: number }>(
            "SELECT LAST_INSERT_ID() as id",
            [],
          )
        )[0]?.id;
      }

      if (!id)
        throw new StabilizeError(
          "Failed to retrieve upserted ID",
          "UPSERT_ERROR",
        );

      if (this.cache) {
        await this.cache.invalidatePattern(`find:${this.table}:*`);
        if (this.cache.getStrategy() === "write-through") {
          const queryBuilder = this.find().where("id = ?", id);
          const result = (await queryBuilder.execute(this.client))[0] as T;
          await this.cache.set(`findOne:${this.table}:${id}`, [result], 60);
          this.logger.logDebug(
            `Upserted ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
          );
          return result;
        }
      }

      const result = (await this.findOne(id)) as T;
      this.logger.logDebug(
        `Upserted ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
      );
      return result;
    });
  }

  async delete(id: number | string): Promise<void> {
    const start = performance.now();
    this.logger.logDebug(`Deleting ${this.table} with ID ${id}`);
    if (this.softDeleteField) {
      await this.client.query(
        `UPDATE ${this.table} SET ${this.softDeleteField} = ? WHERE id = ?`,
        [new Date().toISOString(), id],
      );
    } else {
      await this.client.query(`DELETE FROM ${this.table} WHERE id = ?`, [id]);
    }
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
    const start = performance.now();
    this.logger.logDebug(`Bulk deleting ${ids.length} ${this.table} entities`);
    if (!ids.length) return;
    const batchSize = options.batchSize || 1000;

    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      await this.client.transaction(async () => {
        const placeholders = batch.map(() => "?").join(", ");
        const query = this.softDeleteField
          ? `UPDATE ${this.table} SET ${this.softDeleteField} = ? WHERE id IN (${placeholders})`
          : `DELETE FROM ${this.table} WHERE id IN (${placeholders})`;
        const params = this.softDeleteField
          ? [new Date().toISOString(), ...batch]
          : batch;
        await this.client.query(query, params);
      });
    }
    if (this.cache) {
      await this.cache.invalidatePattern(`find:${this.table}:*`);
    }
    this.logger.logDebug(
      `Bulk deleted ${ids.length} ${this.table} entities in ${(performance.now() - start).toFixed(2)}ms`,
    );
  }

  async recover(id: number | string): Promise<T> {
    const start = performance.now();
    this.logger.logDebug(`Recovering ${this.table} with ID ${id}`);
    if (!this.softDeleteField) {
      throw new StabilizeError(
        "Soft delete not enabled for this model",
        "RECOVER_ERROR",
      );
    }
    return await this.client.transaction(async () => {
      await this.client.query(
        `UPDATE ${this.table} SET ${this.softDeleteField} = NULL WHERE id = ?`,
        [id],
      );
      if (this.cache) {
        await this.cache.invalidate([
          `find:${this.table}`,
          `findOne:${this.table}:${id}`,
        ]);
      }
      const result = (await this.findOne(id))!;
      this.logger.logDebug(
        `Recovered ${this.table} with ID ${id} in ${(performance.now() - start).toFixed(2)}ms`,
      );
      return result;
    });
  }

  async rawQuery<T>(query: string, params: any[] = []): Promise<T[]> {
    const start = performance.now();
    this.logger.logDebug(`Executing raw query: ${query}`);
    const result = await this.client.query<T>(query, params);
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
