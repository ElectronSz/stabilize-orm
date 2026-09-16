/**
 * @file query-builder.ts
 * @description A feature-rich SQL query builder inspired by Knex.js, TypeORM, Prisma, and Drizzle.
 * @author ElectronSz
 */

import { DBClient } from "./client";
import { Cache } from "./cache";
import { MetadataStorage } from "./model";
import { DBType, StabilizeError } from "./types";
import {
  buildMongoAggregatePipeline,
  buildMongoProjection,
  buildMongoSpec,
  createMongoBlockers,
  normalizeMongoDoc,
  recordMongoBlocker,
  type CompareOp,
  type MongoAggregate,
  type MongoBlockers,
  type MongoFieldContext,
  type MongoFilterNode,
  type MongoQuerySpec,
  type Predicate,
} from "./mongo-query";

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
  /**
   * The conditions this builder recorded for MongoDB, as a tree.
   * @see MongoFilterNode for why this is not a flat list.
   */
  private mongoAndList: MongoFilterNode[] = [];
  /** Clauses that were asked for and have no MongoDB equivalent. */
  private mongoBlockers: MongoBlockers = createMongoBlockers();
  /** The aggregate this builder selects, when it used a shortcut for one. */
  private mongoAggregates: MongoAggregate[] | null = null;

  constructor(table: string) {
    this.table = table;
  }

  // ─── SELECT ───────────────────────────────────────────────────────

  select(...fields: string[]): QueryBuilder<T> {
    this.selectFields = fields.length > 0 ? fields : ["*"];
    return this;
  }

  selectRaw(expression: string, ...params: any[]): QueryBuilder<T> {
    this.markMongoUnsupported("selectRaw", expression);
    this.selectFields.push(expression);
    // Kept separate from `whereParams`: the SELECT list is emitted before the
    // WHERE clause, so sharing one array would bind the values out of order.
    this.selectParams.push(...params);
    return this;
  }

  distinct(): QueryBuilder<T> {
    // `SELECT DISTINCT` is a statement-wide modifier, whereas Mongo distincts a
    // single field and returns a value list rather than documents. Reported
    // rather than dropped, which would return duplicates SQL would not.
    this.markMongoUnsupported("distinct");
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
    // Recorded alongside, so `buildMongo` can emit a `$group` stage instead of
    // reporting the SQL aggregate expression as untranslatable. Set rather than
    // pushed: these shortcuts replace `selectFields`, so a second call replaces
    // the first aggregate rather than accumulating one.
    this.mongoAggregates = [{ fn: "count", column, alias }];
    return this;
  }

  sum(column: string, alias: string = "sum"): QueryBuilder<T> {
    this.selectFields = [`SUM(${column}) AS ${alias}`];
    this.mongoAggregates = [{ fn: "sum", column, alias }];
    return this;
  }

  avg(column: string, alias: string = "avg"): QueryBuilder<T> {
    this.selectFields = [`AVG(${column}) AS ${alias}`];
    this.mongoAggregates = [{ fn: "avg", column, alias }];
    return this;
  }

  min(column: string, alias: string = "min"): QueryBuilder<T> {
    this.selectFields = [`MIN(${column}) AS ${alias}`];
    this.mongoAggregates = [{ fn: "min", column, alias }];
    return this;
  }

  max(column: string, alias: string = "max"): QueryBuilder<T> {
    this.selectFields = [`MAX(${column}) AS ${alias}`];
    this.mongoAggregates = [{ fn: "max", column, alias }];
    return this;
  }

  // ─── WHERE ────────────────────────────────────────────────────────

  where(condition: string, ...params: any[]): QueryBuilder<T> {
    // There is no SQL text to translate, and no parser here that could be
    // trusted with one — a `where("a = 1 OR b = 2")` misread would return the
    // wrong rows silently. Reported at execute time instead, alongside any
    // other blocked clause.
    this.markMongoUnsupported("where", condition);
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${condition}`);
    } else {
      this.whereConditions.push(condition);
    }
    this.whereParams.push(...params);
    return this;
  }

  orWhere(condition: string, ...params: any[]): QueryBuilder<T> {
    this.markMongoUnsupported("orWhere", condition);
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
    this.markMongoUnsupported("whereNot", condition);
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND NOT (${condition})`);
    } else {
      this.whereConditions.push(`NOT (${condition})`);
    }
    this.whereParams.push(...params);
    return this;
  }

  whereIn(column: string, values: any[]): QueryBuilder<T> {
    this.addMongoPredicate({ op: "in", column, values });
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
    this.addMongoPredicate({ op: "nin", column, values });
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
    this.addMongoPredicate({ op: "null", column });
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} IS NULL`);
    } else {
      this.whereConditions.push(`${column} IS NULL`);
    }
    return this;
  }

  whereNotNull(column: string): QueryBuilder<T> {
    this.addMongoPredicate({ op: "notNull", column });
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} IS NOT NULL`);
    } else {
      this.whereConditions.push(`${column} IS NOT NULL`);
    }
    return this;
  }

  whereBetween(column: string, start: any, end: any): QueryBuilder<T> {
    this.addMongoPredicate({ op: "between", column, start, end });
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} BETWEEN ? AND ?`);
    } else {
      this.whereConditions.push(`${column} BETWEEN ? AND ?`);
    }
    this.whereParams.push(start, end);
    return this;
  }

  whereNotBetween(column: string, start: any, end: any): QueryBuilder<T> {
    this.addMongoPredicate({ op: "notBetween", column, start, end });
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} NOT BETWEEN ? AND ?`);
    } else {
      this.whereConditions.push(`${column} NOT BETWEEN ? AND ?`);
    }
    this.whereParams.push(start, end);
    return this;
  }

  whereLike(column: string, pattern: string): QueryBuilder<T> {
    this.addMongoPredicate({ op: "like", column, value: pattern });
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} LIKE ?`);
    } else {
      this.whereConditions.push(`${column} LIKE ?`);
    }
    this.whereParams.push(pattern);
    return this;
  }

  whereILike(column: string, pattern: string): QueryBuilder<T> {
    this.addMongoPredicate({ op: "ilike", column, value: pattern });
    if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${column} ILIKE ?`);
    } else {
      this.whereConditions.push(`${column} ILIKE ?`);
    }
    this.whereParams.push(pattern);
    return this;
  }

  // ─── STRUCTURED COMPARISONS ───────────────────────────────────────
  //
  // The methods above take a column and operands; `where` takes SQL text. These
  // cover the one shape that has no structured form yet — a bare comparison —
  // so that a caller never has to reach for `where("a > ?")` and lose the
  // MongoDB translation. They render to SQL exactly as the equivalent `where`
  // call would.

  whereEq(column: string, value: any): QueryBuilder<T> {
    this.addMongoPredicate({ op: "cmp", column, compare: "=", value });
    return this.pushComparison(column, "=", value);
  }

  whereNotEq(column: string, value: any): QueryBuilder<T> {
    this.addMongoPredicate({ op: "cmp", column, compare: "!=", value });
    return this.pushComparison(column, "!=", value);
  }

  whereCompare(column: string, op: CompareOp, value: any): QueryBuilder<T> {
    this.addMongoPredicate({ op: "cmp", column, compare: op, value });
    return this.pushComparison(column, op, value);
  }

  orWhereEq(column: string, value: any): QueryBuilder<T> {
    this.foldMongoOr({ kind: "pred", predicate: { op: "cmp", column, compare: "=", value } });
    return this.pushComparison(column, "=", value, true);
  }

  orWhereCompare(column: string, op: CompareOp, value: any): QueryBuilder<T> {
    this.foldMongoOr({ kind: "pred", predicate: { op: "cmp", column, compare: op, value } });
    return this.pushComparison(column, op, value, true);
  }

  orWhereNull(column: string): QueryBuilder<T> {
    this.foldMongoOr({ kind: "pred", predicate: { op: "null", column } });
    return this.pushCondition(`${column} IS NULL`, [], true);
  }

  orWhereNotNull(column: string): QueryBuilder<T> {
    this.foldMongoOr({ kind: "pred", predicate: { op: "notNull", column } });
    return this.pushCondition(`${column} IS NOT NULL`, [], true);
  }

  orWhereIn(column: string, values: any[]): QueryBuilder<T> {
    this.foldMongoOr({ kind: "pred", predicate: { op: "in", column, values } });
    if (values.length === 0) {
      return this.pushCondition("1 = 0", [], true);
    }
    const placeholders = values.map(() => "?").join(", ");
    return this.pushCondition(`${column} IN (${placeholders})`, values, true);
  }

  whereExists(builderOrSql: string | QueryBuilder<any>): QueryBuilder<T> {
    this.markMongoUnsupported(
      "whereExists",
      typeof builderOrSql === "string" ? builderOrSql : "subquery",
    );
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
    this.markMongoUnsupported(
      "whereNotExists",
      typeof builderOrSql === "string" ? builderOrSql : "subquery",
    );
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
    this.markMongoUnsupported("whereRaw", rawSql);
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
    // Column-to-column comparison is what `$expr` does, but only for the four
    // arithmetic operators, and the caller may pass any SQL operator. Reported
    // rather than half-translated.
    this.markMongoUnsupported("whereRef", `${leftCol} ${op} ${rightCol}`);
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
    method: string,
  ): QueryBuilder<T> {
    this.markMongoUnsupported(method, `${type} JOIN ${table} ON ${condition}`);
    this.joins.push(`${type} JOIN ${table} ON ${condition}`);
    return this;
  }

  join(table: string, condition: string): QueryBuilder<T> {
    return this.addJoin("LEFT", table, condition, "join");
  }

  innerJoin(table: string, condition: string): QueryBuilder<T> {
    return this.addJoin("INNER", table, condition, "innerJoin");
  }

  leftJoin(table: string, condition: string): QueryBuilder<T> {
    return this.addJoin("LEFT", table, condition, "leftJoin");
  }

  rightJoin(table: string, condition: string): QueryBuilder<T> {
    return this.addJoin("RIGHT", table, condition, "rightJoin");
  }

  fullJoin(table: string, condition: string): QueryBuilder<T> {
    return this.addJoin("FULL", table, condition, "fullJoin");
  }

  crossJoin(table: string): QueryBuilder<T> {
    this.markMongoUnsupported("crossJoin", table);
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
    this.markMongoUnsupported("orderByRaw", expression);
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
    this.markMongoUnsupported("groupByRaw", expression);
    this.groupByClauses.push(expression);
    return this;
  }

  having(condition: string, ...params: any[]): QueryBuilder<T> {
    // HAVING filters groups; Mongo filters documents with `$match` and groups
    // with `$group`, and a post-group filter needs `$match` placed *after* the
    // `$group` stage. Translating the condition itself is the blocker, and the
    // condition is SQL text — so this is reported rather than guessed at.
    this.markMongoUnsupported("having", condition);
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
    this.markMongoUnsupported("union");
    this.unions.push({
      query: builder.build().query,
      params: builder.build().params,
      all: false,
    });
    return this;
  }

  unionAll(builder: QueryBuilder<any>): QueryBuilder<T> {
    this.markMongoUnsupported("unionAll");
    this.unions.push({
      query: builder.build().query,
      params: builder.build().params,
      all: true,
    });
    return this;
  }

  // ─── COMMON TABLE EXPRESSIONS ─────────────────────────────────────

  with(name: string, builder: QueryBuilder<any>): QueryBuilder<T> {
    this.markMongoUnsupported("with", name);
    this.ctas.push({
      name,
      query: builder.build().query,
      params: builder.build().params,
      recursive: false,
    });
    return this;
  }

  withRecursive(name: string, builder: QueryBuilder<any>): QueryBuilder<T> {
    this.markMongoUnsupported("withRecursive", name);
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
    // The nodes are treated as immutable once recorded — the recording methods
    // replace the tree rather than mutate a node in place — so sharing them with
    // the clone is safe. The blocker *arrays* are not shared: a clone that
    // records a new blocker must not make the original report it.
    q.mongoAndList = [...this.mongoAndList];
    q.mongoBlockers = {
      methods: [...this.mongoBlockers.methods],
      details: [...this.mongoBlockers.details],
    };
    q.mongoAggregates = this.mongoAggregates ? [...this.mongoAggregates] : null;
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

  // ─── MONGODB ──────────────────────────────────────────────────────
  //
  // The builder stays dialect-agnostic: it renders SQL fragments and records
  // structured predicates side by side, and only decides which to use once a
  // client appears. Nothing here changes what `build()` emits.

  /** Appends a comparison fragment, ANDed or ORed into the WHERE clause. */
  private pushComparison(
    column: string,
    op: CompareOp,
    value: any,
    isOr: boolean = false,
  ): QueryBuilder<T> {
    return this.pushCondition(`${column} ${op} ?`, [value], isOr);
  }

  /**
   * Appends a condition, mirroring the fold `orWhere` performs.
   *
   * Shared by the structured comparison methods so their SQL output is
   * character-for-character what the equivalent `where`/`orWhere` call
   * produced, which is what keeps the four SQL backends unaffected.
   */
  private pushCondition(
    condition: string,
    params: any[],
    isOr: boolean = false,
  ): QueryBuilder<T> {
    if (isOr) {
      if (this.whereConditions.length === 0) {
        this.whereConditions.push(condition);
      } else {
        this.whereConditions = [
          `(${this.whereConditions.join(" ")} OR (${condition}))`,
        ];
      }
    } else if (this.whereConditions.length > 0) {
      this.whereConditions.push(`AND ${condition}`);
    } else {
      this.whereConditions.push(condition);
    }
    this.whereParams.push(...params);
    return this;
  }

  /** Records a structured condition for MongoDB, ANDed with the rest. */
  private addMongoPredicate(predicate: Predicate): void {
    this.mongoAndList.push({ kind: "pred", predicate });
  }

  /**
   * Folds a condition into the MongoDB tree as a disjunct.
   *
   * Deliberately identical to what `orWhere` does to the SQL fragment array:
   * an empty list takes the condition bare, and otherwise the *whole* list so
   * far becomes the left-hand side of the `or`. A flat list with an `OR` flag
   * would not survive the round trip — see {@link MongoFilterNode}.
   */
  private foldMongoOr(node: MongoFilterNode): void {
    if (this.mongoAndList.length === 0) {
      this.mongoAndList.push(node);
      return;
    }
    this.mongoAndList = [
      {
        kind: "or",
        left: { kind: "and", items: this.mongoAndList },
        right: node,
      },
    ];
  }

  /** Records a clause that cannot be expressed against MongoDB. */
  private markMongoUnsupported(method: string, detail?: string): void {
    recordMongoBlocker(this.mongoBlockers, method, detail);
  }

  /**
   * The field-translation context, resolved from the model metadata.
   *
   * The primary key needs no flag on the column config: it is `id` by the same
   * convention the repository already relies on when it writes `id = ?` and
   * asks `getAutoIncrementField()` for the auto-increment column.
   */
  private mongoContext(): MongoFieldContext {
    const ctx: MongoFieldContext = { table: this.table, alias: this.tableAlias };
    const model = MetadataStorage.getModelByTableName(this.table);
    if (!model) return ctx;

    const columns = MetadataStorage.getColumns(model);
    const columnNames: Record<string, string> = {};
    for (const [key, config] of Object.entries(columns)) {
      columnNames[key] = config.name ?? key;
    }
    ctx.columns = columnNames;
    ctx.idProperty = "id";
    ctx.primaryKey = columnNames["id"] ?? "id";
    return ctx;
  }

  /** The aggregate this builder selects, if it used one of the shortcuts. */
  getMongoAggregates(): MongoAggregate[] | null {
    return this.mongoAggregates ? [...this.mongoAggregates] : null;
  }

  /**
   * Renders this query as a MongoDB spec.
   *
   * Collected blockers are raised here rather than when the offending clause was
   * added, because a builder is dialect-agnostic right up until a client is
   * known — that is what lets one builder render for either backend.
   *
   * A `lock()`/`forUpdate()` is **not** reported. MongoDB has no row locking to
   * map it onto and the call is a no-op, matching what the SQL Server path
   * already does with it; the repository logs that where it has a logger.
   *
   * @throws StabilizeError `MONGO_UNSUPPORTED` naming every clause that has no
   *   MongoDB equivalent.
   */
  buildMongo(): MongoQuerySpec {
    // `selectRaw` records its own blocker, but `select()` accepts an expression
    // too. A projection that cannot be built has to be reported rather than
    // quietly widened to the whole document.
    const selectsEverything =
      this.selectFields.length === 1 && this.selectFields[0] === "*";
    if (!selectsEverything && !this.mongoAggregates) {
      const ctx = this.mongoContext();
      if (!buildMongoProjection(this.selectFields, ctx)) {
        recordMongoBlocker(
          this.mongoBlockers,
          "select",
          this.selectFields.join(", "),
        );
      }
    }

    return buildMongoSpec({
      filter: { kind: "and", items: this.mongoAndList },
      orderBy: this.orderByClauses,
      limit: this.limitValue,
      offset: this.offsetValue,
      select: this.selectFields,
      blockers: this.mongoBlockers,
      ctx: this.mongoContext(),
    });
  }

  // ─── EXECUTE ──────────────────────────────────────────────────────

  /**
   * Reads through MongoDB.
   *
   * Shares its shape with the SQL path on purpose: transform, then relations,
   * then cache. Caching before the transform would cache raw column values, and
   * caching before the relation load would cache a row with no relations on it,
   * for the same reasons the SQL path orders it this way.
   *
   * @param client The client, which supplies the collection and any session.
   * @param cache Optional cache to read through.
   * @param cacheKey Key to read and write the cache under.
   */
  private async executeMongo(
    client: DBClient,
    cache?: Cache,
    cacheKey?: string,
  ): Promise<T[]> {
    const cacheable =
      cache && cacheKey && !(client as any).isTransactionClient;

    if (cacheable) {
      const cached = await cache.get<T[]>(cacheKey!);
      if (cached) return cached;
    }

    const spec = this.buildMongo();
    const idColumn = this.mongoContext().primaryKey ?? "id";

    let results: T[];
    if (this.mongoAggregates) {
      // An aggregate replaces the projection: the caller asked for one number
      // per group, not for the documents behind it.
      const rows = await client.mongoAggregate(
        this.table,
        buildMongoAggregatePipeline(
          spec.filter,
          this.mongoAggregates,
          this.mongoContext(),
        ),
      );
      results = rows as T[];
    } else {
      const options: Record<string, unknown> = {};
      if (spec.projection) options.projection = spec.projection;
      if (spec.sort) options.sort = spec.sort;
      if (spec.limit !== undefined) options.limit = spec.limit;
      if (spec.skip !== undefined) options.skip = spec.skip;

      const rows = await client.mongoFind(this.table, spec.filter, options);
      results = rows.map((row) => normalizeMongoDoc<T>(row, idColumn));
    }

    if (this.rowTransform) results = this.rowTransform(results);

    if (this.relationLoader && this.eagerRelations.length > 0) {
      results = await this.relationLoader(results, this.eagerRelations, client);
    }

    if (cacheable && results.length > 0) {
      await cache!.set(cacheKey!, results, cache!.config?.ttl ?? 60);
    }

    return results;
  }

  /**
   * Counts matching documents.
   *
   * The filter is rebuilt without the sort, limit and skip: a count answers
   * "how many match", and carrying the paging clauses over would either count a
   * page or make the `skip`-implies-`_id`-sort rule add an order the caller
   * never asked for. A grouped query is counted from the group stage instead,
   * because there the rows are the groups.
   *
   * @param client The client to count through.
   */
  private async countMongo(client: DBClient): Promise<number> {
    const filter = buildMongoSpec({
      filter: { kind: "and", items: this.mongoAndList },
      select: ["*"],
      blockers: this.mongoBlockers,
      ctx: this.mongoContext(),
    }).filter;

    if (this.mongoAggregates) {
      const rows: any[] = await client.mongoAggregate(
        this.table,
        buildMongoAggregatePipeline(filter, this.mongoAggregates, this.mongoContext()),
      );
      return Number(rows[0]?.[this.mongoAggregates[0]!.alias] ?? 0);
    }

    return client.mongoCount(this.table, filter);
  }

  /**
   * Reports whether any document matches.
   *
   * Reads one `_id` rather than counting: the answer is the same and the server
   * can stop at the first match.
   *
   * @param client The client to probe through.
   */
  private async existsMongo(client: DBClient): Promise<boolean> {
    const filter = buildMongoSpec({
      filter: { kind: "and", items: this.mongoAndList },
      select: ["*"],
      blockers: this.mongoBlockers,
      ctx: this.mongoContext(),
    }).filter;

    const rows = await client.mongoFind(this.table, filter, {
      projection: { _id: 1 },
      limit: 1,
    });
    return rows.length > 0;
  }

  async execute(
    client: DBClient,
    cache?: Cache,
    cacheKey?: string,
  ): Promise<T[]> {
    // Only the client knows which dialect this statement will be sent to, so
    // the row-limiting clause is decided here rather than at build time.
    this.dialect = client.config.type;
    if (this.dialect === DBType.MongoDB) {
      return this.executeMongo(client, cache, cacheKey);
    }
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
    if (clone.dialect === DBType.MongoDB) {
      return clone.countMongo(client);
    }
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
    if (clone.dialect === DBType.MongoDB) {
      return clone.existsMongo(client);
    }
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
