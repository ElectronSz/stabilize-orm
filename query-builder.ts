/**
 * @file query-builder.ts
 * @description A feature-rich SQL query builder inspired by Knex.js, TypeORM, Prisma, and Drizzle.
 * @author ElectronSz
 */

import { DBClient } from "./client";
import { Cache } from "./cache";
import { MetadataStorage } from "./model";
import { DBType, StabilizeError } from "./types";

type JoinType = "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS";
type LockMode =
  | "FOR UPDATE"
  | "FOR SHARE"
  | "FOR NO KEY UPDATE"
  | "FOR KEY SHARE";

/**
 * Builds the clause that limits how many rows a statement returns.
 *
 * SQLite, MySQL and PostgreSQL all spell this `LIMIT … OFFSET …`, and the three
 * are emitted here exactly as they always were. T-SQL has no `LIMIT`: it needs
 * `OFFSET … ROWS FETCH NEXT … ROWS ONLY`, and both of those clauses are legal
 * only on a statement that has an `ORDER BY`. A statement with no ordering is
 * therefore given `ORDER BY (SELECT NULL)` — a constant ordering, which leaves
 * the row order undefined exactly as an unordered `LIMIT` did — purely to
 * satisfy that requirement.
 *
 * Pure, and exported, so every case can be asserted without a server.
 *
 * @param limit The `LIMIT` value, or null when none was set.
 * @param offset The `OFFSET` value, or null when none was set.
 * @param hasOrderBy Whether the statement already carries an `ORDER BY`.
 * @param dbType The target database dialect. Defaults to the LIMIT dialects.
 * @returns The clause to append, or an empty string when neither was set.
 */
export function buildLimitClause(
  limit: number | null,
  offset: number | null,
  hasOrderBy: boolean,
  dbType?: DBType,
): string {
  if (limit === null && offset === null) return "";

  if (dbType === DBType.MSSQL) {
    const orderBy = hasOrderBy ? "" : "\nORDER BY (SELECT NULL)";
    if (offset === null) {
      // `FETCH NEXT` cannot appear without an `OFFSET`, so a bare limit skips
      // no rows rather than being translated into a different clause.
      return `${orderBy}\nOFFSET 0 ROWS FETCH NEXT ${limit} ROWS ONLY`;
    }
    const offsetClause = `\nOFFSET ${offset} ROWS`;
    return limit === null
      ? `${orderBy}${offsetClause}`
      : `${orderBy}${offsetClause} FETCH NEXT ${limit} ROWS ONLY`;
  }

  let clause = "";
  if (limit !== null) {
    clause += `\nLIMIT ${limit}`;
  }
  if (offset !== null) {
    // SQLite and MySQL reject a bare OFFSET; every dialect accepts an
    // explicitly large LIMIT, so supply one when no limit was set.
    if (limit === null) {
      clause += "\nLIMIT 9223372036854775807";
    }
    clause += ` OFFSET ${offset}`;
  }
  return clause;
}

export class QueryBuilder<T> {
  private table: string;
  /**
   * The dialect row limiting is spelled for.
   *
   * Left unset until a client is known — `execute` and its siblings set it from
   * the client they are handed — so a builder that is only ever rendered
   * without one keeps emitting the `LIMIT` form the three row-limiting dialects
   * share.
   */
  private dialect: DBType | null = null;
  private tableAlias: string | null = null;
  private selectFields: string[] = ["*"];
  private selectParams: any[] = [];
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
  /**
   * Per-row post-processing applied to every result set this builder returns.
   * The repository uses it to decrypt encrypted columns, so the transform has
   * to run on all read paths rather than on a single hand-picked one.
   */
  public rowTransform: ((rows: any[]) => any[]) | null = null;
  /**
   * Eager-loads {@link eagerRelations} onto a result set.
   *
   * Supplied by the repository, which owns the model metadata and the database
   * access that loading a relation needs. Running it here — rather than in one
   * repository method — means every builder a caller can reach honours
   * `withRelations()`, and it runs before the result is cached so a cache hit
   * carries the relations too.
   */
  public relationLoader:
    | ((rows: any[], relations: string[], client: DBClient) => Promise<any[]>)
    | null = null;
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
    // Kept separate from `whereParams`: the SELECT list is emitted before the
    // WHERE clause, so sharing one array would bind the values out of order.
    this.selectParams.push(...params);
    return this;
  }

  distinct(): QueryBuilder<T> {
    this.isDistinct = true;
    return this;
  }

  /**
   * Declares the dialect this builder renders for, so dialect-specific clauses
   * (today, only the row limit) are spelled correctly.
   *
   * `execute` sets this from the client it is given, so an ordinary
   * `… .execute(db.client)` needs nothing. It is public for the cases where a
   * builder is rendered without a client, and for a nested builder — one passed
   * to `union` or `whereExists`, say — which is rendered before the outer
   * builder ever sees a client.
   */
  withDialect(dialect: DBType): QueryBuilder<T> {
    this.dialect = dialect;
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
      // Fold the conditions so far and this OR branch into a single group, so
      // a later `where()` constrains the whole disjunction:
      //   (A OR B) AND C   rather than   A OR (B AND C)
      // Without the group, SQL's AND precedence would drop the later filters
      // from the first branch — including the soft-delete predicate.
      this.whereConditions = [
        `(${this.whereConditions.join(" ")} OR (${condition}))`,
      ];
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
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${leftCol} ${op} ${rightCol}`);
    } else {
      this.whereConditions.push(`${leftCol} ${op} ${rightCol}`);
    }
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
    // Also accept the documented single-argument form, orderBy("createdAt DESC"),
    // which would otherwise emit "ORDER BY createdAt DESC ASC".
    const clause = column.trim();
    this.orderByClauses.push(
      / (ASC|DESC)$/i.test(clause) ? clause : `${clause} ${direction}`,
    );
    return this;
  }

  /**
   * Orders by an arbitrary SQL expression.
   *
   * `orderBy` only accepts a column name; an expression such as
   * `CASE WHEN status = 'urgent' THEN 0 ELSE 1 END` has no column to name, and
   * passing it to `orderBy` would have the direction appended to it.
   *
   * @param expression The SQL to order by, e.g. `"LENGTH(name)"`.
   * @param direction Optional sort direction appended to the expression.
   * @example
   * ```
   * repo.find().orderByRaw("CASE WHEN status = 'urgent' THEN 0 ELSE 1 END")
   * ```
   */
  orderByRaw(expression: string, direction?: "ASC" | "DESC"): QueryBuilder<T> {
    const clause = direction ? `${expression} ${direction}` : expression;
    this.orderByClauses.push(clause);
    return this;
  }

  // ─── GROUP BY / HAVING ────────────────────────────────────────────

  groupBy(...columns: string[]): QueryBuilder<T> {
    this.groupByClauses.push(...columns);
    return this;
  }

  /**
   * Groups by an arbitrary SQL expression rather than a column name.
   * @param expression The SQL to group by, e.g. `"strftime('%Y', createdAt)"`.
   * @example
   * ```
   * repo.find().groupByRaw("strftime('%Y-%m', createdAt)")
   * ```
   */
  groupByRaw(expression: string): QueryBuilder<T> {
    this.groupByClauses.push(expression);
    return this;
  }

  having(condition: string, ...params: any[]): QueryBuilder<T> {
    if (this.havingConditions.length > 0) {
      this.havingConditions.push(`AND ${condition}`);
    } else {
      this.havingConditions.push(condition);
    }
    this.havingParams.push(...params);
    return this;
  }

  /**
   * Adds a `HAVING` fragment that references an aggregate by its alias or
   * position, which `having` cannot express without repeating the aggregate.
   *
   * Identical to `having` today; it exists so a caller reading `having("COUNT(*)
   * > ?")` alongside `selectRaw` has the raw form spelled the same way as
   * `whereRaw`, `orderByRaw` and `groupByRaw`.
   *
   * @param condition The raw SQL condition.
   * @param params Values bound to its placeholders.
   */
  havingRaw(condition: string, ...params: any[]): QueryBuilder<T> {
    return this.having(condition, ...params);
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

  // ─── EAGER RELATIONS ──────────────────────────────────────────────

  /**
   * Eager-loads relations onto the result, as `findOne(id, { relations })`
   * does.
   *
   * Nested paths use dot notation (`"roles.permissions"`). The builder records
   * the paths and the repository loads them when `execute()` runs, so this
   * composes with `where`, `limit` and `paginate`, and the loaded rows are
   * cached with their relations.
   *
   * @param relations One or more relation paths.
   * @example
   * ```
   * const user = await userRepository
   *   .find()
   *   .where("isActive = ?", true)
   *   .withRelations("roles", "roles.permissions")
   *   .execute(db.client);
   * ```
   */
  withRelations(...relations: (string | string[])[]): QueryBuilder<T> {
    for (const relation of relations.flat()) {
      const path = relation?.trim();
      // A repeated path would load the same relation twice and overwrite the
      // first result with an identical one.
      if (path && !this.eagerRelations.includes(path)) {
        this.eagerRelations.push(path);
      }
    }
    return this;
  }

  /** The relation paths requested via {@link withRelations}. */
  getRelations(): string[] {
    return [...this.eagerRelations];
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
    q.selectParams = [...this.selectParams];
    q.whereConditions = [...this.whereConditions];
    q.whereParams = [...this.whereParams];
    q.orderByClauses = [...this.orderByClauses];
    q.limitValue = this.limitValue;
    q.offsetValue = this.offsetValue;
    q.dialect = this.dialect;
    q.groupByClauses = [...this.groupByClauses];
    q.havingConditions = [...this.havingConditions];
    q.havingParams = [...this.havingParams];
    q.lockMode = this.lockMode;
    q.eagerRelations = [...this.eagerRelations];
    q.rowTransform = this.rowTransform;
    q.relationLoader = this.relationLoader;
    q.unions = [...this.unions];
    q.ctas = [...this.ctas];
    return q;
  }

  // ─── BUILD ────────────────────────────────────────────────────────

  /**
   * Renders the statement and the values bound to its placeholders.
   *
   * @param dialect Overrides the dialect this builder renders for. Optional, so
   *   every existing call site renders exactly what it always did.
   */
  build(dialect?: DBType): { query: string; params: any[] } {
    const renderedFor = dialect ?? this.dialect ?? undefined;
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

    // The SELECT list is emitted before WHERE/GROUP BY/HAVING, so its params
    // must be collected in that same order.
    params.push(...this.selectParams);

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

    query += buildLimitClause(
      this.limitValue,
      this.offsetValue,
      this.orderByClauses.length > 0,
      renderedFor,
    );

    if (this.lockMode) {
      query += ` ${this.lockMode}`;
    }

    for (const u of this.unions) {
      query += u.all ? `\nUNION ALL (${u.query})` : `\nUNION (${u.query})`;
      params.push(...u.params);
    }

    return { query, params };
  }

  toSQL(dialect?: DBType): { query: string; params: any[] } {
    return this.build(dialect);
  }

  // ─── EXECUTE ──────────────────────────────────────────────────────

  async execute(
    client: DBClient,
    cache?: Cache,
    cacheKey?: string,
  ): Promise<T[]> {
    // Only the client knows which dialect this statement will be sent to, so
    // the row-limiting clause is decided here rather than at build time.
    this.dialect = client.config.type;
    const { query, params } = this.build();

    // Never cache a read taken inside an open transaction: the rows may be
    // rolled back, and a cached copy would outlive the rollback.
    const cacheable =
      cache && cacheKey && !(client as any).isTransactionClient;

    if (cacheable) {
      const cached = await cache.get<T[]>(cacheKey!);
      if (cached) return cached;
    }

    let results = await client.query<T>(query, params);

    // Transform before caching, so a cached row has the same shape a fresh
    // read would produce.
    if (this.rowTransform) results = this.rowTransform(results);

    // Relations are loaded after the transform and before the cache write, so
    // a cached result carries them — caching the pre-hydration rows made every
    // later hit return a row with no relations on it.
    if (this.relationLoader && this.eagerRelations.length > 0) {
      results = await this.relationLoader(results, this.eagerRelations, client);
    }

    if (cacheable && results.length > 0) {
      await cache!.set(cacheKey!, results, cache!.config?.ttl ?? 60);
    }

    return results;
  }

  async countExec(client: DBClient): Promise<number> {
    const clone = this.clone();
    clone.dialect = client.config.type;
    clone.orderByClauses = [];
    clone.limitValue = null;
    clone.offsetValue = null;
    // Aggregate/limit clauses are meaningless in a COUNT and `FOR UPDATE` is
    // rejected alongside aggregates by Postgres.
    clone.lockMode = null;

    // GROUP BY/HAVING/UNION change what a row represents, so count the rows
    // the query actually produces rather than the first group's count.
    if (clone.groupByClauses.length > 0 || clone.unions.length > 0) {
      const inner = clone.build();
      const results = await client.query<any>(
        `SELECT COUNT(*) AS __cnt FROM (${inner.query}) AS __cnt_sub`,
        inner.params,
      );
      return Number(results[0]?.__cnt ?? 0);
    }

    // A join can multiply rows, so count distinct root rows.
    clone.selectFields = [
      clone.joins.length > 0
        ? `COUNT(DISTINCT ${clone.tableAlias || clone.table}.id) AS __cnt`
        : "COUNT(*) AS __cnt",
    ];
    const built = clone.build();
    const results = await client.query<any>(built.query, built.params);
    return Number(results[0]?.__cnt ?? 0);
  }

  async existsExec(client: DBClient): Promise<boolean> {
    const clone = this.clone();
    clone.dialect = client.config.type;
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
