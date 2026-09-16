import { describe, it, expect } from "vitest";
import {
  buildMongoAggregatePipeline,
  buildMongoFilter,
  buildMongoGroupStage,
  buildMongoProjection,
  buildMongoSort,
  buildMongoSpec,
  createMongoBlockers,
  MONGO_MATCHES_NOTHING,
  normalizeMongoDoc,
  OMIT,
  recordMongoBlocker,
  sanitizeMongoValue,
  throwMongoUnsupported,
  translateField,
  translateLikePattern,
  type MongoAggregate,
  type MongoFieldContext,
  type MongoFilterNode,
  type Predicate,
  type PredicateOp,
} from "../mongo-query";
import { StabilizeError } from "../types";

/**
 * The MongoDB translation layer, with no server involved.
 *
 * This file exists because a mis-translated filter does not fail — it returns
 * the wrong rows. Every assertion here is one of two kinds: a SQL operator whose
 * NULL handling differs from its Mongo counterpart, or a place where a naive
 * implementation silently drops a condition.
 *
 * `NOTHING` is the filter that matches no documents, spelled once.
 */
const NOTHING = { _id: { $in: [] } };

/** A predicate node, for assembling filter trees by hand. */
function pred(predicate: Predicate): MongoFilterNode {
  return { kind: "pred", predicate };
}

/** An `AND` group. */
function and(...items: MongoFilterNode[]): MongoFilterNode {
  return { kind: "and", items };
}

/** The error a call throws, or null if it returned. */
function catchError(fn: () => any): StabilizeError | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error as StabilizeError;
  }
}

describe("translateField", () => {
  const ctx: MongoFieldContext = {
    table: "users",
    alias: "u",
    primaryKey: "id",
    columns: { firstName: "first_name", id: "id", userId: "user_id" },
  };

  it("maps the primary key to _id, however it was spelled", () => {
    expect(translateField("id", ctx)).toBe("_id");
    expect(translateField("id", { columns: { id: "user_id" }, primaryKey: "user_id" })).toBe("_id");
    expect(
      translateField("id", { idProperty: "id", primaryKey: "user_id" }),
    ).toBe("_id");
  });

  it("strips a table or alias qualifier", () => {
    expect(translateField("users.email", ctx)).toBe("email");
    expect(translateField("u.email", ctx)).toBe("email");
    expect(translateField("users.id", ctx)).toBe("_id");
  });

  it("resolves a property key to its column name", () => {
    expect(translateField("firstName", ctx)).toBe("first_name");
    expect(translateField("users.firstName", ctx)).toBe("first_name");
  });

  it("leaves an undeclared field and an embedded path alone", () => {
    expect(translateField("email", ctx)).toBe("email");
    // A dot here means an embedded document, not a table qualifier: relations
    // are separate collections and never appear as dotted paths.
    expect(translateField("profile.bio", ctx)).toBe("profile.bio");
    expect(translateField("  email  ", ctx)).toBe("email");
  });
});

describe("buildMongoFilter", () => {
  it("matches everything when there is nothing to match", () => {
    expect(buildMongoFilter(null)).toEqual({});
    expect(buildMongoFilter(and())).toEqual({});
  });

  it("inlines a single condition rather than wrapping it", () => {
    expect(
      buildMongoFilter(pred({ op: "cmp", column: "age", value: 30 })),
    ).toEqual({ age: 30 });
    expect(
      buildMongoFilter(and(pred({ op: "cmp", column: "age", value: 30 }))),
    ).toEqual({ age: 30 });
  });

  it("combines repeated conditions on one field with $and", () => {
    // The defect this guards: merging into a single object would keep only the
    // last assignment, so `age > 18 AND age < 65` would silently become
    // `age < 65` and return children.
    const filter = buildMongoFilter(
      and(
        pred({ op: "cmp", column: "age", compare: ">", value: 18 }),
        pred({ op: "cmp", column: "age", compare: "<", value: 65 }),
      ),
    );
    expect(filter).toEqual({
      $and: [{ age: { $gt: 18 } }, { age: { $lt: 65 } }],
    });
    expect(Object.keys(filter)).toEqual(["$and"]);
  });

  it("renders an OR node as $or", () => {
    const filter = buildMongoFilter({
      kind: "or",
      left: and(pred({ op: "cmp", column: "a", value: 1 })),
      right: and(pred({ op: "cmp", column: "b", value: 2 })),
    });
    expect(filter).toEqual({ $or: [{ a: 1 }, { b: 2 }] });
  });

  it("reproduces the builder's OR fold exactly", () => {
    // where(A).where(B).orWhere(C).where(D) renders in SQL as
    //   ((A AND B) OR (C)) AND D
    // A flat predicate list read with AND-precedence would give
    //   (A AND B) OR (C AND D)
    // which is a different set of rows. The tree has to keep the fold.
    const A = pred({ op: "cmp", column: "a", value: 1 });
    const B = pred({ op: "cmp", column: "b", value: 2 });
    const C = pred({ op: "cmp", column: "c", value: 3 });
    const D = pred({ op: "cmp", column: "d", value: 4 });

    const folded: MongoFilterNode = and({
      kind: "or",
      left: and(A, B),
      right: and(C),
    }, D);

    expect(buildMongoFilter(folded)).toEqual({
      $and: [
        { $or: [{ $and: [{ a: 1 }, { b: 2 }] }, { c: 3 }] },
        { d: 4 },
      ],
    });
  });
});

describe("comparison predicates", () => {
  const ctx: MongoFieldContext = { primaryKey: "id" };

  it("translates = to equality", () => {
    expect(buildMongoFilter(pred({ op: "cmp", column: "email", value: "a" }), ctx)).toEqual(
      { email: "a" },
    );
  });

  it("translates <> so that missing fields are excluded, as SQL does", () => {
    // `{email: {$ne: "a"}}` matches documents with no `email` field at all;
    // SQL's `email <> 'a'` does not. The null in the $nin list is the fix.
    expect(
      buildMongoFilter(pred({ op: "cmp", column: "email", compare: "!=", value: "a" }), ctx),
    ).toEqual({ email: { $nin: ["a", null] } });
  });

  it("translates the range operators", () => {
    const cases: [any, any][] = [
      [">", { $gt: 5 }],
      [">=", { $gte: 5 }],
      ["<", { $lt: 5 }],
      ["<=", { $lte: 5 }],
    ];
    for (const [op, expected] of cases) {
      expect(
        buildMongoFilter(pred({ op: "cmp", column: "n", compare: op, value: 5 }), ctx),
      ).toEqual({ n: expected });
    }
  });

  it("matches nothing for any comparison against NULL", () => {
    // SQL evaluates every one of these to UNKNOWN, which filters the row out.
    const nullish = [null, undefined];
    for (const value of nullish) {
      for (const op of ["!=", ">", ">=", "<", "<="] as const) {
        expect(
          buildMongoFilter(pred({ op: "cmp", column: "n", compare: op, value }), ctx),
        ).toEqual(NOTHING);
      }
    }
  });
});

describe("IN and NOT IN", () => {
  it("translates IN to $in", () => {
    expect(
      buildMongoFilter(pred({ op: "in", column: "id", values: [1, 2, 3] })),
    ).toEqual({ _id: { $in: [1, 2, 3] } });
  });

  it("drops NULLs from an IN list, because SQL's cannot be satisfied by one", () => {
    // `x IN (1, NULL)` is true only for x = 1: `x = NULL` is UNKNOWN either way,
    // so the NULL contributes nothing and behaves as if it were not written.
    expect(
      buildMongoFilter(pred({ op: "in", column: "id", values: [1, null, 2] })),
    ).toEqual({ _id: { $in: [1, 2] } });
  });

  it("matches nothing for an empty IN, as SQL's `1 = 0` does", () => {
    expect(buildMongoFilter(pred({ op: "in", column: "id", values: [] }))).toEqual(
      NOTHING,
    );
    expect(
      buildMongoFilter(pred({ op: "in", column: "id", values: [null] })),
    ).toEqual(NOTHING);
  });

  it("translates NOT IN to $nin plus a null exclusion", () => {
    expect(
      buildMongoFilter(pred({ op: "nin", column: "id", values: [1, 2] })),
    ).toEqual({ _id: { $nin: [1, 2], $ne: null } });
  });

  it("is a no-op for an empty NOT IN, matching the SQL builder", () => {
    // `whereNotIn(col, [])` returns early in the SQL builder and adds no clause.
    expect(buildMongoFilter(pred({ op: "nin", column: "id", values: [] }))).toEqual(
      {},
    );
  });

  it("matches nothing when a NOT IN list contains NULL", () => {
    // One NULL makes every comparison UNKNOWN, so `NOT IN (1, NULL)` is never
    // true — a different result from the empty case above, deliberately.
    expect(
      buildMongoFilter(pred({ op: "nin", column: "id", values: [1, null] })),
    ).toEqual(NOTHING);
  });
});

describe("null predicates", () => {
  it("matches missing and null for IS NULL", () => {
    // Intentional: a document written before the soft-delete field existed is
    // not soft-deleted, and Mongo reports both states as null.
    expect(buildMongoFilter(pred({ op: "null", column: "deleted_at" }))).toEqual(
      { deleted_at: null },
    );
  });

  it("excludes missing and null for IS NOT NULL", () => {
    expect(
      buildMongoFilter(pred({ op: "notNull", column: "deleted_at" })),
    ).toEqual({ deleted_at: { $ne: null } });
  });
});

describe("BETWEEN predicates", () => {
  it("translates BETWEEN inclusively", () => {
    expect(
      buildMongoFilter(pred({ op: "between", column: "n", start: 1, end: 9 })),
    ).toEqual({ n: { $gte: 1, $lte: 9 } });
  });

  it("translates NOT BETWEEN so that missing fields are excluded", () => {
    // `$not` on its own matches a document with no `n` field; SQL's
    // `n NOT BETWEEN 1 AND 9` evaluates to UNKNOWN there and excludes it.
    expect(
      buildMongoFilter(pred({ op: "notBetween", column: "n", start: 1, end: 9 })),
    ).toEqual({
      $and: [{ n: { $not: { $gte: 1, $lte: 9 } } }, { n: { $ne: null } }],
    });
  });

  it("matches nothing when a bound is NULL", () => {
    for (const op of ["between", "notBetween"] as PredicateOp[]) {
      expect(
        buildMongoFilter(pred({ op, column: "n", start: null, end: 9 })),
      ).toEqual(NOTHING);
      expect(
        buildMongoFilter(pred({ op, column: "n", start: 1, end: undefined })),
      ).toEqual(NOTHING);
    }
  });
});

describe("translateLikePattern", () => {
  it("turns SQL wildcards into regex and anchors the result", () => {
    expect(translateLikePattern("a%")).toEqual({ pattern: "^a.*$", options: "s" });
    expect(translateLikePattern("%a%")).toEqual({ pattern: "^.*a.*$", options: "s" });
    expect(translateLikePattern("a_c")).toEqual({ pattern: "^a.c$", options: "s" });
  });

  it("escapes regex metacharacters in the literal part", () => {
    expect(translateLikePattern("a.b").pattern).toBe("^a\\.b$");
    expect(translateLikePattern("50%+").pattern).toBe("^50.*\\+$");
    expect(translateLikePattern("(x)").pattern).toBe("^\\(x\\)$");
  });

  it("enables dotAll so that % matches a newline, as SQL's does", () => {
    // Without the `s` flag `.` stops at a line break and `LIKE '%a%'` would miss
    // a multi-line value SQL would have matched.
    const { options } = translateLikePattern("%a%");
    expect(options).toContain("s");
    expect(translateLikePattern("%a%", true).options).toBe("is");
  });

  it("coerces a non-string pattern", () => {
    expect(translateLikePattern(42).pattern).toBe("^42$");
  });
});

describe("LIKE predicates", () => {
  it("renders LIKE and ILIKE as regex, differing only in case sensitivity", () => {
    expect(buildMongoFilter(pred({ op: "like", column: "name", value: "A%" }))).toEqual(
      { name: { $regex: "^A.*$", $options: "s" } },
    );
    expect(buildMongoFilter(pred({ op: "ilike", column: "name", value: "A%" }))).toEqual(
      { name: { $regex: "^A.*$", $options: "is" } },
    );
  });

  it("renders NOT LIKE with $nor, excluding missing fields", () => {
    // `$nor` rather than `$not`, because `$not` over `$regex` is inconsistently
    // supported; and the `$ne: null` supplies the NULL exclusion `NOT LIKE`
    // performs, which `$nor` alone would not.
    expect(
      buildMongoFilter(pred({ op: "notLike", column: "name", value: "A%" })),
    ).toEqual({
      $and: [
        { $nor: [{ name: { $regex: "^A.*$", $options: "s" } }] },
        { name: { $ne: null } },
      ],
    });
  });

  it("passes a raw regex through with dotAll", () => {
    expect(buildMongoFilter(pred({ op: "regex", column: "name", value: "^a" }))).toEqual(
      { name: { $regex: "^a", $options: "s" } },
    );
  });
});

describe("buildMongoSort", () => {
  const ctx: MongoFieldContext = { table: "users", primaryKey: "id" };

  it("translates ordered clauses, defaulting the direction to ASC", () => {
    expect(buildMongoSort(["name ASC"], ctx)).toEqual({ name: 1 });
    expect(buildMongoSort(["name DESC"], ctx)).toEqual({ name: -1 });
    expect(buildMongoSort(["name ASC", "id DESC"], ctx)).toEqual({
      name: 1,
      _id: -1,
    });
  });

  it("strips a qualifier and maps the primary key", () => {
    expect(buildMongoSort(["users.created_at DESC"], ctx)).toEqual({
      created_at: -1,
    });
    expect(buildMongoSort(["users.id ASC"], ctx)).toEqual({ _id: 1 });
  });

  it("returns null when there is no ordering", () => {
    expect(buildMongoSort(null)).toBeNull();
    expect(buildMongoSort([])).toBeNull();
  });

  it("throws on a raw expression instead of sorting by a nonexistent field", () => {
    // Passing "LENGTH(name) DESC" through would have the driver look for a field
    // literally named `LENGTH(name)`, find nothing in every document, and return
    // the rows in arbitrary order with no error at all.
    const error = catchError(() => buildMongoSort(["LENGTH(name) DESC"], ctx));
    expect(error).toBeInstanceOf(StabilizeError);
    expect(error!.code).toBe("MONGO_UNSUPPORTED");
    expect(error!.message).toContain("LENGTH(name) DESC");
  });
});

describe("buildMongoProjection", () => {
  const ctx: MongoFieldContext = { table: "users", primaryKey: "id" };

  it("returns null for SELECT *", () => {
    expect(buildMongoProjection(["*"], ctx)).toBeNull();
    expect(buildMongoProjection([], ctx)).toBeNull();
    expect(buildMongoProjection(null, ctx)).toBeNull();
  });

  it("projects listed fields and always keeps _id", () => {
    // Mongo includes _id in an inclusion projection by default, and _id is where
    // the model's primary key lives — dropping it would strip every row's id.
    expect(buildMongoProjection(["name", "email"], ctx)).toEqual({
      name: 1,
      email: 1,
      _id: 1,
    });
    expect(buildMongoProjection(["name", "id"], ctx)).toEqual({
      name: 1,
      _id: 1,
    });
  });

  it("returns null for an expression, which a projection cannot hold", () => {
    expect(buildMongoProjection(["COUNT(*)"], ctx)).toBeNull();
  });
});

describe("buildMongoSpec", () => {
  const ctx: MongoFieldContext = { primaryKey: "id" };

  it("assembles filter, projection, sort and window", () => {
    const spec = buildMongoSpec({
      filter: and(pred({ op: "cmp", column: "active", value: true })),
      select: ["name"],
      orderBy: ["name ASC"],
      limit: 10,
      offset: 20,
      ctx,
    });
    expect(spec).toEqual({
      filter: { active: true },
      projection: { name: 1, _id: 1 },
      sort: { name: 1 },
      limit: 10,
      skip: 20,
    });
  });

  it("adds an _id tiebreaker when paging without an ordering", () => {
    // Unordered skip/limit has no stable total order in Mongo, so `eachBatch`'s
    // paging loop could revisit a document or never terminate.
    const spec = buildMongoSpec({ filter: and(), offset: 100, limit: 50, ctx });
    expect(spec.sort).toEqual({ _id: 1 });
    expect(spec.skip).toBe(100);
  });

  it("leaves an explicit ordering alone and ignores a zero offset", () => {
    expect(
      buildMongoSpec({ filter: and(), orderBy: ["name DESC"], offset: 100, ctx }).sort,
    ).toEqual({ name: -1 });
    expect(buildMongoSpec({ filter: and(), offset: 0, ctx }).skip).toBeUndefined();
    expect(buildMongoSpec({ filter: and(), ctx }).sort).toBeUndefined();
  });

  it("throws, naming every offending method at once", () => {
    const blockers = createMongoBlockers();
    recordMongoBlocker(blockers, "join", "LEFT JOIN posts ON posts.user_id = users.id");
    recordMongoBlocker(blockers, "whereRaw", "LOWER(name) = 'a'");

    const error = catchError(() => buildMongoSpec({ filter: and(), blockers, ctx }));
    expect(error).toBeInstanceOf(StabilizeError);
    expect(error!.code).toBe("MONGO_UNSUPPORTED");
    expect(error!.message).toContain("join");
    expect(error!.message).toContain("whereRaw");
    // The quoted fragment, so the caller can see which call is at fault.
    expect(error!.message).toContain("LEFT JOIN posts");
  });
});

describe("blockers", () => {
  it("records a method once but every fragment", () => {
    const blockers = createMongoBlockers();
    recordMongoBlocker(blockers, "join", "A");
    recordMongoBlocker(blockers, "join", "B");
    recordMongoBlocker(blockers, "union", "C");
    expect(blockers.methods).toEqual(["join", "union"]);
    expect(blockers.details).toEqual(["join: A", "join: B", "union: C"]);
  });

  it("reads sensibly for one method and for several", () => {
    const one = createMongoBlockers();
    recordMongoBlocker(one, "join");
    expect(catchError(() => throwMongoUnsupported(one))!.message).toContain(
      "join has no MongoDB equivalent",
    );

    const two = createMongoBlockers();
    recordMongoBlocker(two, "join");
    recordMongoBlocker(two, "union");
    expect(catchError(() => throwMongoUnsupported(two))!.message).toContain(
      "join, union have no MongoDB equivalent",
    );
  });
});

describe("aggregates", () => {
  const ctx: MongoFieldContext = { primaryKey: "id" };

  it("counts rows for COUNT(*)", () => {
    expect(buildMongoGroupStage([{ fn: "count", column: "*", alias: "count" }], ctx)).toEqual({
      $group: { _id: null, count: { $sum: 1 } },
    });
  });

  it("counts non-null values for COUNT(column), as SQL does", () => {
    const stage = buildMongoGroupStage(
      [{ fn: "count", column: "email", alias: "count" }],
      ctx,
    );
    expect(stage).toEqual({
      $group: {
        _id: null,
        count: { $sum: { $cond: [{ $ne: ["$email", null] }, 1, 0] } },
      },
    });
  });

  it("translates the remaining aggregates and the id field", () => {
    const aggregates: MongoAggregate[] = [
      { fn: "sum", column: "total", alias: "sum" },
      { fn: "avg", column: "total", alias: "avg" },
      { fn: "min", column: "total", alias: "min" },
      { fn: "max", column: "total", alias: "max" },
      { fn: "count", column: "id", alias: "ids" },
    ];
    expect(buildMongoGroupStage(aggregates, ctx)).toEqual({
      $group: {
        _id: null,
        sum: { $sum: "$total" },
        avg: { $avg: "$total" },
        min: { $min: "$total" },
        max: { $max: "$total" },
        ids: { $sum: { $cond: [{ $ne: ["$_id", null] }, 1, 0] } },
      },
    });
  });

  it("orders the pipeline match → group → project and drops the group key", () => {
    const pipeline = buildMongoAggregatePipeline({ active: true }, [
      { fn: "sum", column: "total", alias: "total" },
    ]);
    expect(pipeline).toEqual([
      { $match: { active: true } },
      { $group: { _id: null, total: { $sum: "$total" } } },
      { $project: { _id: 0, total: 1 } },
    ]);
    expect(pipeline).toHaveLength(3);
  });
});

describe("sanitizeMongoValue", () => {
  it("passes through the types SQL coercion would destroy", () => {
    const date = new Date("2024-01-01T00:00:00Z");
    // A stringified Date fails {bsonType: "date"} and defeats an indexed range
    // query; a 1/0 boolean makes whereEq("published", true) match nothing.
    expect(sanitizeMongoValue(date)).toBe(date);
    expect(sanitizeMongoValue(true)).toBe(true);
    expect(sanitizeMongoValue(false)).toBe(false);
    expect(sanitizeMongoValue({ a: 1 })).toEqual({ a: 1 });
    expect(sanitizeMongoValue([1, 2])).toEqual([1, 2]);
  });

  it("keeps falsy values that are real data", () => {
    // The reason this is not `if (!value) return OMIT`.
    expect(sanitizeMongoValue(0)).toBe(0);
    expect(sanitizeMongoValue("")).toBe("");
    expect(sanitizeMongoValue(NaN)).toBeNaN();
  });

  it("reports null, undefined and un-storable values as omitted", () => {
    expect(sanitizeMongoValue(null)).toBe(OMIT);
    expect(sanitizeMongoValue(undefined)).toBe(OMIT);
    expect(sanitizeMongoValue(() => {})).toBe(OMIT);
    expect(sanitizeMongoValue(Symbol("x"))).toBe(OMIT);
  });
});

describe("normalizeMongoDoc", () => {
  it("renames _id to the id column and keeps the rest", () => {
    expect(normalizeMongoDoc({ _id: 7, name: "a" })).toEqual({ id: 7, name: "a" });
  });

  it("lets _id win over a stale id field", () => {
    expect(normalizeMongoDoc({ _id: 7, id: 9, name: "a" })).toEqual({
      id: 7,
      name: "a",
    });
  });

  it("accepts a renamed id column", () => {
    expect(normalizeMongoDoc({ _id: 7, name: "a" }, "user_id")).toEqual({
      user_id: 7,
      name: "a",
    });
  });

  it("leaves a document without _id, and a non-document, untouched", () => {
    expect(normalizeMongoDoc({ name: "a" })).toEqual({ name: "a" });
    expect(normalizeMongoDoc(null)).toBeNull();
    expect(normalizeMongoDoc(5)).toBe(5);
  });
});

describe("MONGO_MATCHES_NOTHING", () => {
  it("is frozen and matches nothing by construction", () => {
    // Frozen so that one caller spreading it cannot poison the constant for
    // every later query.
    expect(Object.isFrozen(MONGO_MATCHES_NOTHING)).toBe(true);
    expect({ ...MONGO_MATCHES_NOTHING }).toEqual(NOTHING);
    expect({ ...MONGO_MATCHES_NOTHING }).not.toBe(MONGO_MATCHES_NOTHING);
  });
});
