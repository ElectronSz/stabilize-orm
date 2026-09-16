/**
 * @file mongo-query.ts
 * @description Translates the query builder's structured predicates into MongoDB
 *   filters, sort specs, projections and aggregation pipelines.
 * @author ElectronSz
 *
 * Everything in this file is **pure** — no server, no driver, no client — which
 * is the point. A filter that is silently wrong returns the wrong rows with no
 * error at all, so the translation is the one part of the MongoDB backend that
 * has to be verifiable without a database. `tests/mongo.dialect.test.ts` asserts
 * it directly.
 *
 * There is deliberately no `mongodb` import here. Nothing in this module needs
 * a driver type: the output is plain documents that the driver serialises.
 */

import { StabilizeError } from "./types";

// ─── PREDICATE MODEL ──────────────────────────────────────────────────
//
// A predicate is what a `QueryBuilder.where*` call records *in addition to* the
// SQL fragment it renders. The SQL arrays are untouched, so the four working
// backends keep emitting byte-identical statements; these sit alongside them.

/** The comparison operators `whereCompare` accepts. */
export type CompareOp = "=" | "!=" | ">" | ">=" | "<" | "<=";

/**
 * The shapes a predicate can take.
 *
 * Each maps to a Mongo operator that has *exactly* SQL's three-valued-logic
 * behaviour, including the NULL handling — that last part is where a naive
 * translation goes wrong, so it is spelled out per operator in
 * {@link renderPredicate}.
 */
export type PredicateOp =
  | "cmp"
  | "in"
  | "nin"
  | "null"
  | "notNull"
  | "between"
  | "notBetween"
  | "like"
  | "notLike"
  | "ilike"
  | "regex";

/**
 * One recorded condition.
 *
 * `column` is a column name as written at the call site — possibly qualified
 * (`users.email`) and possibly a *property* key rather than a column name. It is
 * not resolved until {@link translateField} runs, because resolution needs the
 * model metadata the builder does not hold.
 */
export interface Predicate {
  op: PredicateOp;
  column: string;
  /** The single operand for `cmp` and `like`/`ilike`/`regex`. */
  value?: any;
  /** The operand list for `in`/`nin`. */
  values?: any[];
  /** The bounds for `between`/`notBetween`. */
  start?: any;
  end?: any;
  /** Which comparison `cmp` means. Defaults to `=`. */
  compare?: CompareOp;
}

/**
 * The recorded conditions, as a tree rather than a list.
 *
 * This shape is not a stylistic choice — it is what makes the translation
 * faithful. SQL's `AND` binds tighter than `OR`, and `orWhere` in the builder
 * does **not** append a disjunct: it folds everything accumulated so far into a
 * single group, so
 *
 *     where(A).where(B).orWhere(C).where(D)
 *
 * renders as `((A AND B) OR C) AND D`. A flat `[A, B, C(OR), D]` list cannot
 * express that — read left-to-right with `AND` precedence it yields
 * `(A AND B) OR (C AND D)`, which is a different set of rows. The `or` node
 * therefore holds the *whole* left-hand side, exactly as the fold does.
 */
export type MongoFilterNode =
  | { kind: "pred"; predicate: Predicate }
  | { kind: "and"; items: MongoFilterNode[] }
  | { kind: "or"; left: MongoFilterNode; right: MongoFilterNode };

/**
 * Where a document field name differs from the SQL column name.
 *
 * The ORM stores documents keyed by **column name**, with the primary key mapped
 * to `_id` (see `mongo-repository.ts`). Callers legitimately hand the builder
 * either spelling — `repository.ts` passes column names, model-facing code often
 * passes property keys — so both are resolved here rather than at ~30 call sites.
 */
export interface MongoFieldContext {
  /** The collection name, so a `table.column` qualifier can be stripped. */
  table?: string;
  /** The builder's alias, likewise stripped. */
  alias?: string | null;
  /** The primary-key *column* name. Defaults to `"id"`. */
  primaryKey?: string;
  /** The primary-key *property* key, when it differs from the column name. */
  idProperty?: string;
  /** Property key → column name, for callers that hold property keys. */
  columns?: Record<string, string>;
}

/** A `count`/`sum`/`avg`/`min`/`max` shortcut recorded by the builder. */
export interface MongoAggregate {
  fn: "count" | "sum" | "avg" | "min" | "max";
  column: string;
  alias: string;
}

/**
 * The SQL-only clauses a builder was asked for.
 *
 * Collected rather than thrown at once, so the error a caller sees can name
 * *every* offending method instead of only the first — a query with a `join` and
 * a `whereRaw` should report both.
 */
export interface MongoBlockers {
  methods: string[];
  details: string[];
}

/** The filter, sort, projection and window a query resolved to. */
export interface MongoQuerySpec {
  filter: Record<string, any>;
  projection?: Record<string, 0 | 1>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
}

/** Everything {@link buildMongoSpec} needs from a builder. */
export interface MongoSpecInput {
  filter?: MongoFilterNode | null;
  orderBy?: string[] | null;
  limit?: number | null;
  offset?: number | null;
  select?: string[] | null;
  blockers?: MongoBlockers | null;
  ctx?: MongoFieldContext;
}

/**
 * A filter that matches no documents.
 *
 * `$in` with an empty array is the one Mongo idiom for "nothing" that needs no
 * field to exist and no server version to support. It stands in for the places
 * where SQL's three-valued logic would also match nothing but Mongo has no
 * direct spelling: `IN ()`, `NOT IN (1, NULL)`, and a comparison against NULL.
 */
export const MONGO_MATCHES_NOTHING: Record<string, any> = Object.freeze({
  _id: { $in: [] as any[] },
});

/**
 * Returned by {@link sanitizeMongoValue} for values a write should **omit**
 * rather than store as null.
 *
 * A symbol cannot collide with a real field value, so `if (v === OMIT)` is
 * unambiguous where `null` would be.
 */
export const OMIT: unique symbol = Symbol("stabilize.mongo.omit");

// ─── BLOCKERS ─────────────────────────────────────────────────────────

export function createMongoBlockers(): MongoBlockers {
  return { methods: [], details: [] };
}

/**
 * Records a method that has no MongoDB equivalent.
 *
 * @param blockers The list being accumulated on the builder.
 * @param method The method name, as the caller would have written it.
 * @param detail The offending fragment, quoted back in the error.
 */
export function recordMongoBlocker(
  blockers: MongoBlockers,
  method: string,
  detail?: string,
): void {
  if (!blockers.methods.includes(method)) blockers.methods.push(method);
  if (detail !== undefined) {
    blockers.details.push(`${method}: ${detail}`);
  }
}

/**
 * Throws the error a blocked query produces.
 *
 * Raised when the query is *executed*, not when the clause is added — the
 * builder is dialect-agnostic until a client appears, which is what lets one
 * builder be rendered for SQL and Mongo.
 */
export function throwMongoUnsupported(blockers: MongoBlockers): never {
  const methods = blockers.methods;
  const noun = methods.length === 1 ? "has" : "have";
  const detail = blockers.details.length
    ? `\n  ${blockers.details.join("\n  ")}`
    : "";
  throw new StabilizeError(
    `This query cannot be translated to MongoDB: ${methods.join(", ")} ${noun} ` +
      `no MongoDB equivalent. MongoDB is a document store — it has no joins, ` +
      `no set operations and no SQL text. Use withRelations() for related ` +
      `documents, or run this query against a SQL backend.${detail}`,
    "MONGO_UNSUPPORTED",
  );
}

// ─── FIELD TRANSLATION ────────────────────────────────────────────────

/**
 * Resolves a call-site field reference to a document field name.
 *
 * Three rewrites, in order, and the order matters:
 *
 *  1. A leading `table.` or `alias.` qualifier is stripped. It names the SQL
 *     table, which in Mongo is the collection — already implied by which
 *     collection is being queried.
 *  2. The primary key, by *either* its property key or its column name, becomes
 *     `_id`. Checked before the column map so that a model which renames its id
 *     column (`id` property, `user_id` column) resolves whichever spelling the
 *     caller used.
 *  3. A property key is resolved to its column name, since documents are stored
 *     under column names.
 *
 * A remaining dotted path is left alone: relations are separate collections and
 * never appear as dotted paths, so a dot here means an embedded document field,
 * which Mongo addresses by exactly that path.
 */
export function translateField(
  field: string,
  ctx: MongoFieldContext = {},
): string {
  let name = String(field).trim();

  for (const qualifier of [ctx.alias, ctx.table]) {
    if (qualifier && name.startsWith(`${qualifier}.`)) {
      name = name.slice(qualifier.length + 1);
      break;
    }
  }

  const primaryKey = ctx.primaryKey ?? "id";
  if (ctx.idProperty && name === ctx.idProperty) return "_id";
  if (name === primaryKey) return "_id";

  if (ctx.columns && Object.prototype.hasOwnProperty.call(ctx.columns, name)) {
    const column = ctx.columns[name] ?? name;
    // A renamed id column still has to reach `_id`.
    return column === primaryKey ? "_id" : column;
  }

  return name;
}

// ─── PREDICATE RENDERING ──────────────────────────────────────────────

/**
 * Translates a SQL `LIKE` pattern into a regular expression.
 *
 * SQL's wildcards are not regex metacharacters and vice versa, so a pattern has
 * to be rebuilt rather than passed through: `%` becomes `.*`, `_` becomes `.`,
 * and every regex metacharacter in the literal part is escaped.
 *
 * The `s` flag is not optional. In a regex `.` does not match a newline, but
 * SQL's `%` does, so `LIKE '%foo%'` and `/foo/` disagree about any value
 * containing a line break.
 *
 * @param pattern The SQL pattern, e.g. `"a_c%"`.
 * @param caseInsensitive Adds the `i` flag, for `ILIKE`.
 */
export function translateLikePattern(
  pattern: any,
  caseInsensitive: boolean = false,
): { pattern: string; options: string } {
  let body = "";
  for (const ch of String(pattern)) {
    if (ch === "%") body += ".*";
    else if (ch === "_") body += ".";
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return { pattern: `^${body}$`, options: caseInsensitive ? "is" : "s" };
}

/**
 * Renders one predicate to a Mongo filter document.
 *
 * The recurring difficulty is that SQL and Mongo disagree about absent fields.
 * SQL compares against `NULL` and yields `UNKNOWN`, which matches nothing; Mongo
 * has a "field is missing" state that most operators happily match. Every
 * negation below therefore carries an explicit `$ne: null` — without it,
 * `NOT IN` and `NOT LIKE` would return documents SQL would exclude, which is the
 * quiet kind of wrong that survives review.
 */
function renderPredicate(
  p: Predicate,
  ctx: MongoFieldContext,
): Record<string, any> {
  const field = translateField(p.column, ctx);

  switch (p.op) {
    case "cmp":
      return renderCompare(field, p.compare ?? "=", p.value);

    case "in": {
      // SQL's `IN (1, NULL)` can never be satisfied by the NULL — `x = NULL` is
      // UNKNOWN regardless of x — so the NULLs are dropped rather than matched.
      // That makes `IN (1, NULL)` behave exactly like `IN (1)`, as SQL does.
      const values = (p.values ?? []).filter((v) => v !== null && v !== undefined);
      return values.length > 0
        ? { [field]: { $in: values } }
        : { ...MONGO_MATCHES_NOTHING };
    }

    case "nin": {
      // One NULL anywhere in the list makes `NOT IN` unsatisfiable in SQL, since
      // every row's comparison against it is UNKNOWN.
      const values = p.values ?? [];
      if (values.length === 0) return {}; // SQL renders no clause at all here.
      if (values.some((v) => v === null || v === undefined)) {
        return { ...MONGO_MATCHES_NOTHING };
      }
      // `$ne: null` is what excludes documents where the field is missing or
      // null; `$nin` alone would match them.
      return { [field]: { $nin: values, $ne: null } };
    }

    case "null":
      // Matches missing *and* null, which is the intent: a document written
      // before the field existed is not soft-deleted.
      return { [field]: null };

    case "notNull":
      return { [field]: { $ne: null } };

    case "between":
      if (p.start === null || p.start === undefined) {
        return { ...MONGO_MATCHES_NOTHING };
      }
      if (p.end === null || p.end === undefined) {
        return { ...MONGO_MATCHES_NOTHING };
      }
      return { [field]: { $gte: p.start, $lte: p.end } };

    case "notBetween":
      if (p.start === null || p.start === undefined) {
        return { ...MONGO_MATCHES_NOTHING };
      }
      if (p.end === null || p.end === undefined) {
        return { ...MONGO_MATCHES_NOTHING };
      }
      // `$not` alone would match missing fields, which `NOT BETWEEN` does not.
      return {
        $and: [
          { [field]: { $not: { $gte: p.start, $lte: p.end } } },
          { [field]: { $ne: null } },
        ],
      };

    case "like":
    case "ilike": {
      const { pattern, options } = translateLikePattern(
        p.value,
        p.op === "ilike",
      );
      return { [field]: { $regex: pattern, $options: options } };
    }

    case "notLike": {
      // Expressed with `$nor` rather than `$not`. `$not` combined with `$regex`
      // is documented inconsistently across server versions, whereas `$nor` over
      // a regex is unambiguous — and `$ne: null` then supplies the NULL
      // exclusion SQL's `NOT LIKE` performs.
      const { pattern, options } = translateLikePattern(p.value, false);
      return {
        $and: [
          { $nor: [{ [field]: { $regex: pattern, $options: options } }] },
          { [field]: { $ne: null } },
        ],
      };
    }

    case "regex":
      return { [field]: { $regex: p.value, $options: "s" } };

    default: {
      // Exhaustiveness: a new PredicateOp without a branch is a type error here
      // rather than a predicate that silently matches everything.
      const never: never = p.op;
      throw new StabilizeError(
        `Unsupported predicate op: ${String(never)}`,
        "MONGO_UNSUPPORTED",
      );
    }
  }
}

/**
 * Renders a `cmp` predicate for a single comparison operator.
 *
 * `!=` is the interesting one. `{field: {$ne: v}}` matches documents where the
 * field is **missing**, but SQL's `<>` does not — its result there is UNKNOWN.
 * The `$ne: null` alongside it is what closes that gap.
 */
function renderCompare(
  field: string,
  op: CompareOp,
  value: any,
): Record<string, any> {
  switch (op) {
    case "=":
      // Already faithful: a missing field does not equal a value.
      return { [field]: value };
    case "!=":
      if (value === null || value === undefined) {
        // `x <> NULL` is UNKNOWN for every x, so it matches nothing.
        return { ...MONGO_MATCHES_NOTHING };
      }
      // `$nin` with an explicit `null` rather than `$ne`, because `{f: {$ne: v}}`
      // matches documents where `f` is *missing* and SQL's `<>` does not: `$in`
      // treats a missing field as null, so excluding null excludes missing too.
      return { [field]: { $nin: [value, null] } };
    case ">":
      return comparison(field, "$gt", value);
    case ">=":
      return comparison(field, "$gte", value);
    case "<":
      return comparison(field, "$lt", value);
    case "<=":
      return comparison(field, "$lte", value);
    default: {
      const never: never = op;
      throw new StabilizeError(
        `Unsupported comparison operator: ${String(never)}`,
        "MONGO_UNSUPPORTED",
      );
    }
  }
}

/** A range comparison, which matches nothing when the bound is NULL. */
function comparison(
  field: string,
  operator: string,
  value: any,
): Record<string, any> {
  if (value === null || value === undefined) {
    return { ...MONGO_MATCHES_NOTHING };
  }
  return { [field]: { [operator]: value } };
}

/**
 * Renders a predicate tree to a single filter document.
 *
 * `$and` and `$or` rather than merging into one object, and that is not
 * cosmetic. Merging `{age: {$gt: 18}}` with `{age: {$lt: 65}}` produces
 * `{age: {$lt: 65}}` — the first condition is silently dropped. `$and` keeps
 * both, which is what makes repeated conditions on one field correct.
 */
export function buildMongoFilter(
  node: MongoFilterNode | null | undefined,
  ctx: MongoFieldContext = {},
): Record<string, any> {
  if (!node) return {};

  switch (node.kind) {
    case "pred":
      return renderPredicate(node.predicate, ctx);

    case "and": {
      // `$and` must be a non-empty array, so the degenerate sizes are folded
      // away rather than emitted.
      const items = node.items.map((item) => buildMongoFilter(item, ctx));
      if (items.length === 0) return {};
      if (items.length === 1) return items[0]!;
      return { $and: items };
    }

    case "or": {
      // Both sides are always present: the builder only creates an `or` node by
      // folding a non-empty left-hand side against the new condition.
      return {
        $or: [buildMongoFilter(node.left, ctx), buildMongoFilter(node.right, ctx)],
      };
    }

    default: {
      const never: never = node;
      throw new StabilizeError(
        `Unsupported filter node: ${JSON.stringify(never)}`,
        "MONGO_UNSUPPORTED",
      );
    }
  }
}

// ─── SORT / PROJECTION / SPEC ─────────────────────────────────────────

/** A bare field path, optionally qualified: `users.created_at`. */
const FIELD_PATH = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

/**
 * Renders `ORDER BY` clauses to a Mongo sort document.
 *
 * A clause that is not `<field> <ASC|DESC>` came from `orderByRaw` and is an
 * arbitrary SQL expression. It throws rather than being passed through: a sort
 * key of `"LENGTH(name)"` would be accepted by the driver as a literal field
 * name, sort every document as missing, and return rows in no particular order.
 */
export function buildMongoSort(
  clauses: string[] | null | undefined,
  ctx: MongoFieldContext = {},
): Record<string, 1 | -1> | null {
  if (!clauses || clauses.length === 0) return null;

  const sort: Record<string, 1 | -1> = {};
  for (const raw of clauses) {
    const match = /^(.+?)\s+(ASC|DESC)$/i.exec(String(raw).trim());
    const field = match?.[1]?.trim();
    const direction = match?.[2]?.toUpperCase();
    if (!field || !direction || !FIELD_PATH.test(field)) {
      throw new StabilizeError(
        `ORDER BY "${raw}" has no MongoDB equivalent. MongoDB sorts by field ` +
          `path only; an expression such as orderByRaw() cannot be translated.`,
        "MONGO_UNSUPPORTED",
      );
    }
    sort[translateField(field, ctx)] = direction === "DESC" ? -1 : 1;
  }
  return sort;
}

/**
 * Renders a `SELECT` list to a Mongo projection.
 *
 * Returns null — "take the whole document" — when the list is `*` or contains an
 * expression, since a projection document cannot hold one. `selectRaw` is
 * recorded as a blocker by the builder, so an expression here is already
 * reported; returning null keeps this function total.
 *
 * `_id` is always included explicitly. Mongo's inclusion projections carry it by
 * default, and it is where the model's primary key lives, so a projection that
 * silently dropped it would leave every row without an `id`.
 */
export function buildMongoProjection(
  select: string[] | null | undefined,
  ctx: MongoFieldContext = {},
): Record<string, 0 | 1> | null {
  if (!select || select.length === 0) return null;
  // `String(...)` rather than `select[0].trim()`: the loop below coerces for the
  // same reason, and a `select()` handed a non-string would otherwise throw a
  // bare TypeError out of `buildMongo` instead of being reported as an
  // unbuildable projection.
  if (select.length === 1 && String(select[0]).trim() === "*") return null;

  const projection: Record<string, 0 | 1> = {};
  for (const raw of select) {
    const field = String(raw).trim();
    if (!FIELD_PATH.test(field)) return null;
    projection[translateField(field, ctx)] = 1;
  }
  projection._id = 1;
  return projection;
}

/**
 * Assembles the full spec a query resolves to, or throws if it cannot.
 *
 * @throws StabilizeError `MONGO_UNSUPPORTED` when the builder recorded a clause
 *   Mongo cannot express, naming every such method at once.
 */
export function buildMongoSpec(input: MongoSpecInput): MongoQuerySpec {
  if (input.blockers && input.blockers.methods.length > 0) {
    throwMongoUnsupported(input.blockers);
  }

  const ctx = input.ctx ?? {};
  const spec: MongoQuerySpec = {
    filter: buildMongoFilter(input.filter, ctx),
  };

  const projection = buildMongoProjection(input.select, ctx);
  if (projection) spec.projection = projection;

  const sort = buildMongoSort(input.orderBy, ctx);
  if (sort) spec.sort = sort;

  if (typeof input.limit === "number") spec.limit = input.limit;
  if (typeof input.offset === "number" && input.offset > 0) {
    spec.skip = input.offset;
  }

  // A skip with no ordering has no stable total order in Mongo — the server is
  // free to return a different subset for the same query on consecutive runs,
  // so a paging loop can revisit a document or never reach the end. `_id` is
  // unique, so ordering by it is a total order and makes the page boundaries
  // reproducible. The SQL path is left alone; SQL's unordered LIMIT is
  // unspecified too, but changing it would alter existing behaviour.
  if (spec.skip !== undefined && !spec.sort) {
    spec.sort = { _id: 1 };
  }

  return spec;
}

// ─── AGGREGATES ───────────────────────────────────────────────────────

/**
 * Renders the aggregate shortcuts (`count`/`sum`/`avg`/`min`/`max`) to a
 * `$group` stage.
 *
 * `COUNT(column)` counts non-NULL values only, so a bare `$sum: 1` would be
 * wrong for anything but `COUNT(*)`. The `$cond` reproduces the SQL definition.
 */
export function buildMongoGroupStage(
  aggregates: MongoAggregate[],
  ctx: MongoFieldContext = {},
): Record<string, any> {
  const group: Record<string, any> = { _id: null };

  for (const aggregate of aggregates) {
    if (aggregate.fn === "count") {
      group[aggregate.alias] =
        aggregate.column === "*"
          ? { $sum: 1 }
          : {
              $sum: {
                $cond: [
                  { $ne: [`$${translateField(aggregate.column, ctx)}`, null] },
                  1,
                  0,
                ],
              },
            };
      continue;
    }
    group[aggregate.alias] = {
      [`$${aggregate.fn}`]: `$${translateField(aggregate.column, ctx)}`,
    };
  }

  return { $group: group };
}

/**
 * Builds the aggregation pipeline for a query carrying aggregates.
 *
 * `limit`/`skip` are deliberately not applied. They belong to the row window,
 * and every aggregate shortcut here groups to a single `_id: null` row, so the
 * window has nothing to narrow — the same one row SQL would return.
 */
export function buildMongoAggregatePipeline(
  filter: Record<string, any>,
  aggregates: MongoAggregate[],
  ctx: MongoFieldContext = {},
): Record<string, any>[] {
  const projection: Record<string, 0 | 1> = { _id: 0 };
  for (const aggregate of aggregates) projection[aggregate.alias] = 1;

  return [
    { $match: filter },
    buildMongoGroupStage(aggregates, ctx),
    { $project: projection },
  ];
}

// ─── VALUE COERCION ───────────────────────────────────────────────────

/**
 * Prepares a value for storage in a Mongo document.
 *
 * This is **not** `sanitizeSqlValue` and must not be folded into it. Every one
 * of that function's coercions is actively wrong here:
 *
 *   - A `Date` stringified for SQLite fails a `{bsonType: "date"}` validator and
 *     turns an indexed range query into a string comparison.
 *   - `boolean` → `1|0` fails `{bsonType: "bool"}`, and makes
 *     `whereEq("published", true)` match nothing.
 *   - `undefined` → explicit `NULL` collides in a sparse unique index, which is
 *     exactly the case a unique-but-optional column creates.
 *
 * So this passes `Date`, `boolean`, plain objects, arrays and `Buffer` through
 * untouched, and reports omission with {@link OMIT} instead of writing a null.
 *
 * Not recursive: it governs whether a *field* is written, not what is inside a
 * document-valued field, where the caller's structure is preserved verbatim.
 */
export function sanitizeMongoValue(value: any): any {
  if (value === undefined || value === null) return OMIT;
  if (typeof value === "function" || typeof value === "symbol") return OMIT;
  return value;
}

/**
 * Rewrites a stored document into the shape the rest of the ORM expects.
 *
 * `_id` is the Mongo primary key; the model calls it `id`. The rename happens
 * here, before `rowTransform` and the relation loaders run, so decryption and
 * relation key collection see the id under the name they look for.
 */
export function normalizeMongoDoc<T = any>(
  doc: any,
  idColumn: string = "id",
): T {
  if (!doc || typeof doc !== "object") return doc;
  if (!Object.prototype.hasOwnProperty.call(doc, "_id")) return doc;

  const { _id, ...rest } = doc;
  return { ...rest, [idColumn]: _id } as T;
}
