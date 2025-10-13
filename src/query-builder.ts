import { DBClient } from './client';
import { Cache } from './cache';
import { type QueryHint } from './types';

export class QueryBuilder<T> {
  private table: string;
  private selectFields: string[] = ['*'];
  private joins: string[] = [];
  private whereConditions: string[] = [];
  private whereParams: any[] = [];
  private orderByClause: string | null = null;
  private limitValue: number | null = null;
  private offsetValue: number | null = null;
  private hints: QueryHint[] = [];

  constructor(table: string) {
    this.table = table;
  }

  select(...fields: string[]): QueryBuilder<T> {
    this.selectFields = fields.length > 0 ? fields : ['*'];
    return this;
  }

  where(condition: string, ...params: any[]): QueryBuilder<T> {
    this.whereConditions.push(condition);
    this.whereParams.push(...params);
    return this;
  }

  join(table: string, condition: string): QueryBuilder<T> {
    this.joins.push(`LEFT JOIN ${table} ON ${condition}`);
    return this;
  }

  orderBy(clause: string): QueryBuilder<T> {
    this.orderByClause = clause;
    return this;
  }

  limit(limit: number): QueryBuilder<T> {
    this.limitValue = limit;
    return this;
  }

  offset(offset: number): QueryBuilder<T> {
    this.offsetValue = offset;
    return this;
  }

  hint(hint: QueryHint): QueryBuilder<T> {
    this.hints.push(hint);
    return this;
  }

  build(): { query: string; params: any[] } {
    let query = `SELECT ${this.selectFields.join(', ')} FROM ${this.table}`;
    if (this.hints.length > 0) {
      const hintStr = this.hints.map(h => `${h.type}(${h.value})`).join(' ');
      query = `SELECT ${hintStr} ${this.selectFields.join(', ')} FROM ${this.table}`;
    }
    if (this.joins.length > 0) {
      query += ' ' + this.joins.join(' ');
    }
    if (this.whereConditions.length > 0) {
      query += ' WHERE ' + this.whereConditions.join(' AND ');
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

  async execute(client: DBClient, cache?: Cache, cacheKey?: string): Promise<T[]> {
    const { query, params } = this.build();
    if (cache && cacheKey) {
      const cached = await cache.get<T[]>(cacheKey);
      if (cached) return cached;
    }
    const results = await client.query<T>(query, params);
    if (cache && cacheKey && results.length > 0) {
      await cache.set(cacheKey, results);
    }
    return results;
  }
}