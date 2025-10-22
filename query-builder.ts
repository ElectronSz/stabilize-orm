/**
 * @file query-builder.ts
 * @description Provides a fluent API for building and executing SQL queries in a database-agnostic way.
 * @author ElectronSz
 */

import { DBClient } from "./client";
import { Cache } from "./cache";
import { MetadataStorage } from "./model";
import { StabilizeError } from "./types";

/**
 * A fluent interface for building SQL SELECT queries.
 * This class allows for the programmatic and readable construction of queries
 * that can be executed on different database systems via the DBClient.
 * @template T The type of the entity being queried.
 */
export class QueryBuilder<T> {
  private table: string;
  private selectFields: string[] = ["*"];
  private joins: string[] = [];
  private whereConditions: string[] = [];
  private whereParams: any[] = [];
  private orderByClause: string | null = null;
  private limitValue: number | null = null;
  private offsetValue: number | null = null;
  private pagination?: { page: number; pageSize: number };
  private includeTrashed = false;
  private onlyTrashed = false;


  /**
   * Creates an instance of QueryBuilder.
   * @param table The name of the main table to query from.
   */
  constructor(table: string) {
    this.table = table;
  }

  /**
   * Specifies the columns to select. If not called, all columns (`*`) are selected by default.
   * @param fields A list of column names to select.
   * @returns The `QueryBuilder` instance for chaining.
   * @example
   * ```
   * queryBuilder.select('id', 'name', 'email');
   * ```
   */
  select(...fields: string[]): QueryBuilder<T> {
    this.selectFields = fields.length > 0 ? fields : ["*"];
    return this;
  }

  /**
   * Adds a WHERE clause to the query. Multiple calls will be joined with AND.
   * @param condition The SQL condition string with `?` as placeholders.
   * @param params The values to substitute for the `?` placeholders.
   * @returns The `QueryBuilder` instance for chaining.
   * @example
   * ```
   * queryBuilder.where('status = ?', 'active').where('age > ?', 21);
   * ```
   */
  where(condition: string, ...params: any[]): QueryBuilder<T> {
    this.whereConditions.push(condition);
    this.whereParams.push(...params);
    return this;
  }

  /**
   * Adds a LEFT JOIN clause to the query.
   * @param table The name of the table to join with.
   * @param condition The ON condition for the join.
   * @returns The `QueryBuilder` instance for chaining.
   * @example
   * ```
   * queryBuilder.join('profiles', 'profiles.userId = users.id');
   * ```
   */
  join(table: string, condition: string): QueryBuilder<T> {
    this.joins.push(`LEFT JOIN ${table} ON ${condition}`);
    return this;
  }

  /**
   * Adds an ORDER BY clause to the query.
   * @param clause The column and direction for ordering (e.g., 'createdAt DESC').
   * @returns The `QueryBuilder` instance for chaining.
   * @example
   * ```
   * queryBuilder.orderBy('lastName ASC');
   * ```
   */
  orderBy(clause: string): QueryBuilder<T> {
    this.orderByClause = clause;
    return this;
  }

  /**
   * Adds a LIMIT clause to the query to restrict the number of rows returned.
   * @param limit The maximum number of rows to return.
   * @returns The `QueryBuilder` instance for chaining.
   * @example
   * ```
   * queryBuilder.limit(10);
   * ```
   */
  limit(limit: number): QueryBuilder<T> {
    this.limitValue = limit;
    return this;
  }

  /**
   * Adds an OFFSET clause to the query for pagination.
   * @param offset The number of rows to skip.
   * @returns The `QueryBuilder` instance for chaining.
   * @example
   * ```
   * queryBuilder.offset(20);
   * ```
   */
  offset(offset: number): QueryBuilder<T> {
    this.offsetValue = offset;
    return this;
  }

  /**
   * Constructs the final SQL query string and its corresponding parameters.
   * This is an internal method, typically called by `execute`.
   * @returns An object containing the final `query` string and `params` array.
   */
  build(): { query: string; params: any[] } {
    let query = `SELECT ${this.selectFields.join(", ")} FROM ${this.table}`;

    if (this.joins.length > 0) {
      query += " " + this.joins.join(" ");
    }
    if (this.whereConditions.length > 0) {
      query += " WHERE " + this.whereConditions.join(" AND ");
    }
    if (this.orderByClause) {
      query += ` ORDER BY ${this.orderByClause}`;
    }
    if (this.limitValue !== null) {
      query += ` LIMIT ${this.limitValue}`;
    }
    if (this.offsetValue !== null) {
      query += ` OFFSET ${this.offsetValue}`;
    }
    return { query, params: this.whereParams };
  }

  /**
   * Executes the constructed query against the database using the provided client.
   * Handles cache-aside logic if a cache and cacheKey are provided.
   * @param client The `DBClient` instance to use for executing the query.
   * @param cache Optional: The `Cache` instance to use for caching.
   * @param cacheKey Optional: The key to use for getting/setting the result in the cache.
   * @returns A promise that resolves to an array of results of type `T`.
   * @example
   * ```
   * const users = await stabilize.getRepository(User)
   *   .find()
   *   .where('status = ?', 'active')
   *   .limit(10)
   *   .execute(dbClient, cache, 'active_users_page_1');
   * ```
   */
  async execute(
    client: DBClient,
    cache?: Cache,
    cacheKey?: string,
  ): Promise<T[]> {
    const { query, params } = this.build();

    // Attempt to retrieve from cache first (cache-aside read)
    if (cache && cacheKey) {
      const cached = await cache.get<T[]>(cacheKey);
      if (cached) return cached;
    }

    // If not in cache, execute query against the database
    const results = await client.query<T>(query, params);

    // Store the database results in the cache for future requests
    if (cache && cacheKey && results.length > 0) {
      await cache.set(cacheKey, results, 60);
    }

    return results;
  }

  /**
   * Applies a named scope to the current query builder.
   *
   * This method looks up a scope function by name for the current model (based on the table name),
   * then invokes the scope function with the query builder and any additional arguments.
   *
   * @param {string} name - The name of the scope to apply.
   * @param {...any} args - Additional arguments to pass to the scope function.
   * @throws {StabilizeError} If no model is found for the current table, or if the specified scope does not exist.
   * @returns {QueryBuilder<T>} The query builder instance after applying the scope.
   */
  scope(name: string, ...args: any[]): QueryBuilder<T> {
    const model = Object.values(MetadataStorage['models']).find(m => m.tableName === this.table)?.constructor;
    if (!model) throw new StabilizeError(`Model for table ${this.table} not found`, "SCOPE_ERROR");
    const scopes = MetadataStorage.getScopes(model);
    const scopeFn = scopes[name];
    if (!scopeFn) throw new StabilizeError(`Scope ${name} not found`, "SCOPE_ERROR");
    return scopeFn(this, ...args);
  }

  /**
   * Applies pagination to the query by setting LIMIT and OFFSET values.
   *
   * @param {number} page - The current page number (starting from 1).
   * @param {number} pageSize - The number of records per page.
   * @returns {QueryBuilder<T>} The current QueryBuilder instance for chaining.
   *
   * @example
   * const results = await query
   *   .where({ status: 'active' })
   *   .paginate(3, 25)
   *   .execute(client);
   */
  paginate(page: number, pageSize: number): QueryBuilder<T> {
    this.pagination = { page, pageSize };
    this.limitValue = pageSize;
    this.offsetValue = (page - 1) * pageSize;
    return this;
  }


}