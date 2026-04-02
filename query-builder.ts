/**
 * @file query-builder.ts
 * @description A feature-rich SQL query builder inspired by Knex.js, TypeORM, Prisma, and Drizzle.
 * @author ElectronSz
 */

import { DBClient } from "./client";
import { Cache } from "./cache";
import { MetadataStorage } from "./model";
import { StabilizeError } from "./types";

type JoinType = "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS";
type LockMode =
  | "FOR UPDATE"
  | "FOR SHARE"
  | "FOR NO KEY UPDATE"
  | "FOR KEY SHARE";

export class QueryBuilder<T> {
  private table: string;
  private tableAlias: string | null = null;
  private selectFields: string[] = ["*"];
  private isDistinct = false;
  private joins: string[] = [];
  private whereConditions: string[] = [];
  private whereParams: any[] = [];
  private orderByClauses: string[] = [];
  private limitValue: number | null = null;
  private offsetValue: number | null = null;
  private groupByClauses: string[] = [];
  private havingConditions: string[] = [];
  private havingParams: any[] = [];
  private lockMode: LockMode | null = null;
  private eagerRelations: string[] = [];
  private unions: { query: string; params: any[]; all: boolean }[] = [];
  private ctas: {
    name: string;
    query: string;
    params: any[];
    recursive: boolean;
  }[] = [];

  constructor(table: string) {
    this.table = table;
  }

  // ─── SELECT ───────────────────────────────────────────────────────

  select(...fields: string[]): QueryBuilder<T> {
    this.selectFields = fields.length > 0 ? fields : ["*"];
    return this;
  }

  selectRaw(expression: string, ...params: any[]): QueryBuilder<T> {
    this.selectFields.push(expression);
    this.whereParams.push(...params);
    return this;
  }

  distinct(): QueryBuilder<T> {
    this.isDistinct = true;
    return this;
  }

  as(alias: string): QueryBuilder<T> {
    this.tableAlias = alias;
    return this;
  }

  // ─── AGGREGATE SHORTCUTS (Prisma / Sequelize style) ───────────────

  count(column: string = "*", alias: string = "count"): QueryBuilder<T> {
    this.selectFields = [`COUNT(${column}) AS ${alias}`];
    return this;
  }

  sum(column: string, alias: string = "sum"): QueryBuilder<T> {
    this.selectFields = [`SUM(${column}) AS ${alias}`];
    return this;
  }

  avg(column: string, alias: string = "avg"): QueryBuilder<T> {
    this.selectFields = [`AVG(${column}) AS ${alias}`];
    return this;
  }

  min(column: string, alias: string = "min"): QueryBuilder<T> {
    this.selectFields = [`MIN(${column}) AS ${alias}`];
    return this;
  }

  max(column: string, alias: string = "max"): QueryBuilder<T> {
    this.selectFields = [`MAX(${column}) AS ${alias}`];
    return this;
  }

  // ─── WHERE ────────────────────────────────────────────────────────

  where(condition: string, ...params: any[]): QueryBuilder<T> {
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${condition}`);
    } else {
      this.whereConditions.push(condition);
    }
    this.whereParams.push(...params);
    return this;
  }

  orWhere(condition: string, ...params: any[]): QueryBuilder<T> {
    if (this.whereConditions.length === 0) {
      this.whereConditions.push(condition);
    } else {
      this.whereConditions.push(`OR (${condition})`);
    }
    this.whereParams.push(...params);
    return this;
  }

  whereNot(condition: string, ...params: any[]): QueryBuilder<T> {
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND NOT (${condition})`);
    } else {
      this.whereConditions.push(`NOT (${condition})`);
    }
    this.whereParams.push(...params);
    return this;
  }

  whereIn(column: string, values: any[]): QueryBuilder<T> {
    if (values.length === 0) {
      if (this.whereConditions.length > 0) {
        this.whereConditions.push("AND 1 = 0");
      } else {
        this.whereConditions.push("1 = 0");
      }
      return this;
    }
    const placeholders = values.map(() => "?").join(", ");
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} IN (${placeholders})`);
    } else {
      this.whereConditions.push(`${column} IN (${placeholders})`);
    }
    this.whereParams.push(...values);
    return this;
  }

  whereNotIn(column: string, values: any[]): QueryBuilder<T> {
    if (values.length === 0) return this;
    const placeholders = values.map(() => "?").join(", ");
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} NOT IN (${placeholders})`);
    } else {
      this.whereConditions.push(`${column} NOT IN (${placeholders})`);
    }
    this.whereParams.push(...values);
    return this;
  }

  whereNull(column: string): QueryBuilder<T> {
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} IS NULL`);
    } else {
      this.whereConditions.push(`${column} IS NULL`);
    }
    return this;
  }

  whereNotNull(column: string): QueryBuilder<T> {
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} IS NOT NULL`);
    } else {
      this.whereConditions.push(`${column} IS NOT NULL`);
    }
    return this;
  }

  whereBetween(column: string, start: any, end: any): QueryBuilder<T> {
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} BETWEEN ? AND ?`);
    } else {
      this.whereConditions.push(`${column} BETWEEN ? AND ?`);
    }
    this.whereParams.push(start, end);
    return this;
  }

  whereNotBetween(column: string, start: any, end: any): QueryBuilder<T> {
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} NOT BETWEEN ? AND ?`);
    } else {
      this.whereConditions.push(`${column} NOT BETWEEN ? AND ?`);
    }
    this.whereParams.push(start, end);
    return this;
  }

  whereLike(column: string, pattern: string): QueryBuilder<T> {
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} LIKE ?`);
    } else {
      this.whereConditions.push(`${column} LIKE ?`);
    }
    this.whereParams.push(pattern);
    return this;
  }

  whereILike(column: string, pattern: string): QueryBuilder<T> {
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} ILIKE ?`);
    } else {
      this.whereConditions.push(`${column} ILIKE ?`);
    }
    this.whereParams.push(pattern);
    return this;
  }

  whereExists(builderOrSql: string | QueryBuilder<any>): QueryBuilder<T> {
    const sql =
      typeof builderOrSql === "string"
        ? builderOrSql
        : builderOrSql.build().query;
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND EXISTS (${sql})`);
    } else {
      this.whereConditions.push(`EXISTS (${sql})`);
    }
    if (typeof builderOrSql !== "string") {
      this.whereParams.push(...builderOrSql.build().params);
    }
    return this;
  }

  whereNotExists(builderOrSql: string | QueryBuilder<any>): QueryBuilder<T> {
    const sql =
      typeof builderOrSql === "string"
        ? builderOrSql
        : builderOrSql.build().query;
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND NOT EXISTS (${sql})`);
    } else {
      this.whereConditions.push(`NOT EXISTS (${sql})`);
    }
    if (typeof builderOrSql !== "string") {
      this.whereParams.push(...builderOrSql.build().params);
    }
    return this;
  }

  whereRaw(rawSql: string, ...params: any[]): QueryBuilder<T> {
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${rawSql}`);
    } else {
      this.whereConditions.push(rawSql);
    }
    this.whereParams.push(...params);
    return this;
  }

  /** Knex-style column-to-column comparison: .whereRef('orders.user_id', '=', 'users.id') */
  whereRef(leftCol: string, op: string, rightCol: string): QueryBuilder<T> {
    this.whereConditions.push(`${leftCol} ${op} ${rightCol}`);
    return this;
  }

  // ─── JOIN ─────────────────────────────────────────────────────────

  private addJoin(
    type: JoinType,
    table: string,
    condition: string,
  ): QueryBuilder<T> {
    this.joins.push(`${type} JOIN ${table} ON ${condition}`);
    return this;
  }

  join(table: string, condition: string): QueryBuilder<T> {
    return this.addJoin("LEFT", table, condition);
  }

  innerJoin(table: string, condition: string): QueryBuilder<T> {
    return this.addJoin("INNER", table, condition);
  }

  leftJoin(table: string, condition: string): QueryBuilder<T> {
    return this.addJoin("LEFT", table, condition);
  }

  rightJoin(table: string, condition: string): QueryBuilder<T> {
    return this.addJoin("RIGHT", table, condition);
  }

  fullJoin(table: string, condition: string): QueryBuilder<T> {
    return this.addJoin("FULL", table, condition);
  }

  crossJoin(table: string): QueryBuilder<T> {
    this.joins.push(`CROSS JOIN ${table}`);
    return this;
  }

  // ─── ORDER BY ─────────────────────────────────────────────────────

  orderBy(column: string, direction: "ASC" | "DESC" = "ASC"): QueryBuilder<T> {
    this.orderByClauses.push(`${column} ${direction}`);
    return this;
  }

  // ─── GROUP BY / HAVING ────────────────────────────────────────────

  groupBy(...columns: string[]): QueryBuilder<T> {
    this.groupByClauses.push(...columns);
    return this;
  }

  having(condition: string, ...params: any[]): QueryBuilder<T> {
    this.havingConditions.push(condition);
    this.havingParams.push(...params);
    return this;
  }

  // ─── LIMIT / OFFSET (Prisma: take / skip) ─────────────────────────

  limit(limit: number): QueryBuilder<T> {
    this.limitValue = limit;
    return this;
  }

  offset(offset: number): QueryBuilder<T> {
    this.offsetValue = offset;
    return this;
  }

  take(count: number): QueryBuilder<T> {
    return this.limit(count);
  }

  skip(count: number): QueryBuilder<T> {
    return this.offset(count);
  }

  first(): QueryBuilder<T> {
    this.limitValue = 1;
    return this;
  }

  paginate(page: number, pageSize: number): QueryBuilder<T> {
    this.limitValue = pageSize;
    this.offsetValue = (page - 1) * pageSize;
    return this;
  }

  // ─── LOCKING ──────────────────────────────────────────────────────

  lock(mode: LockMode = "FOR UPDATE"): QueryBuilder<T> {
    this.lockMode = mode;
    return this;
  }

  forUpdate(): QueryBuilder<T> {
    this.lockMode = "FOR UPDATE";
    return this;
  }

  forShare(): QueryBuilder<T> {
    this.lockMode = "FOR SHARE";
    return this;
  }

  // ─── SET OPERATIONS ───────────────────────────────────────────────

  union(builder: QueryBuilder<any>): QueryBuilder<T> {
    this.unions.push({
      query: builder.build().query,
      params: builder.build().params,
      all: false,
    });
    return this;
  }

  unionAll(builder: QueryBuilder<any>): QueryBuilder<T> {
    this.unions.push({
      query: builder.build().query,
      params: builder.build().params,
      all: true,
    });
    return this;
  }

  // ─── COMMON TABLE EXPRESSIONS ─────────────────────────────────────

  with(name: string, builder: QueryBuilder<any>): QueryBuilder<T> {
    this.ctas.push({
      name,
      query: builder.build().query,
      params: builder.build().params,
      recursive: false,
    });
    return this;
  }

  withRecursive(name: string, builder: QueryBuilder<any>): QueryBuilder<T> {
    this.ctas.push({
      name,
      query: builder.build().query,
      params: builder.build().params,
      recursive: true,
    });
    return this;
  }

  // ─── SCOPE ────────────────────────────────────────────────────────

  scope(name: string, ...args: any[]): QueryBuilder<T> {
    const model = MetadataStorage.getModelByTableName(this.table);
    if (!model)
      throw new StabilizeError(
        `Model for table ${this.table} not found`,
        "SCOPE_ERROR",
      );
    const scopes = MetadataStorage.getScopes(model);
    const scopeFn = scopes[name];
    if (!scopeFn)
      throw new StabilizeError(`Scope ${name} not found`, "SCOPE_ERROR");
    return scopeFn(this, ...args);
  }

  // ─── CLONE ────────────────────────────────────────────────────────

  clone(): QueryBuilder<T> {
    const q = new QueryBuilder<T>(this.table);
    q.tableAlias = this.tableAlias;
    q.selectFields = [...this.selectFields];
    q.isDistinct = this.isDistinct;
    q.joins = [...this.joins];
    q.whereConditions = [...this.whereConditions];
    q.whereParams = [...this.whereParams];
    q.orderByClauses = [...this.orderByClauses];
    q.limitValue = this.limitValue;
    q.offsetValue = this.offsetValue;
    q.groupByClauses = [...this.groupByClauses];
    q.havingConditions = [...this.havingConditions];
    q.havingParams = [...this.havingParams];
    q.lockMode = this.lockMode;
    q.eagerRelations = [...this.eagerRelations];
    q.unions = [...this.unions];
    q.ctas = [...this.ctas];
    return q;
  }

  // ─── BUILD ────────────────────────────────────────────────────────

  build(): { query: string; params: any[] } {
    const params: any[] = [];
    let ctePrefix = "";

    if (this.ctas.length > 0) {
      const recursive = this.ctas.some((c) => c.recursive) ? "RECURSIVE " : "";
      const ctes = this.ctas
        .map((c) => {
          params.push(...c.params);
          return `${c.name} AS (${c.query})`;
        })
        .join(", ");
      ctePrefix = `WITH ${recursive}${ctes}\n`;
    }

    const table = this.tableAlias
      ? `${this.table} AS ${this.tableAlias}`
      : this.table;
    const distinct = this.isDistinct ? " DISTINCT" : "";

    let query = `${ctePrefix}SELECT${distinct} ${this.selectFields.join(", ")} FROM ${table}`;

    if (this.joins.length > 0) {
      query += "\n" + this.joins.join("\n");
    }

    params.push(...this.whereParams);
    if (this.whereConditions.length > 0) {
      query += "\nWHERE " + this.whereConditions.join(" ");
    }

    if (this.groupByClauses.length > 0) {
      query += "\nGROUP BY " + this.groupByClauses.join(", ");
    }

    params.push(...this.havingParams);
    if (this.havingConditions.length > 0) {
      query += "\nHAVING " + this.havingConditions.join(" ");
    }

    if (this.orderByClauses.length > 0) {
      query += "\nORDER BY " + this.orderByClauses.join(", ");
    }

    if (this.limitValue !== null) {
      query += `\nLIMIT ${this.limitValue}`;
    }
    if (this.offsetValue !== null) {
      query += ` OFFSET ${this.offsetValue}`;
    }

    if (this.lockMode) {
      query += ` ${this.lockMode}`;
    }

    for (const u of this.unions) {
      query += u.all ? `\nUNION ALL (${u.query})` : `\nUNION (${u.query})`;
      params.push(...u.params);
    }

    return { query, params };
  }

  toSQL(): { query: string; params: any[] } {
    return this.build();
  }

  // ─── EXECUTE ──────────────────────────────────────────────────────

  async execute(
    client: DBClient,
    cache?: Cache,
    cacheKey?: string,
  ): Promise<T[]> {
    const { query, params } = this.build();

    if (cache && cacheKey) {
      const cached = await cache.get<T[]>(cacheKey);
      if (cached) return cached;
    }

    const results = await client.query<T>(query, params);

    if (cache && cacheKey && results.length > 0) {
      await cache.set(cacheKey, results, 60);
    }

    return results;
  }

  async countExec(client: DBClient): Promise<number> {
    const clone = this.clone();
    clone.selectFields = ["COUNT(*) AS __cnt"];
    clone.orderByClauses = [];
    clone.limitValue = null;
    clone.offsetValue = null;
    const results = await client.query<any>(
      clone.build().query,
      clone.build().params,
    );
    return Number(results[0]?.__cnt ?? 0);
  }

  async existsExec(client: DBClient): Promise<boolean> {
    const clone = this.clone();
    clone.selectFields = ["1"];
    clone.orderByClauses = [];
    clone.limitValue = 1;
    clone.offsetValue = null;
    const results = await client.query<any>(
      clone.build().query,
      clone.build().params,
    );
    return results.length > 0;
  }
}
