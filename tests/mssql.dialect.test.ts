import { describe, it, expect } from "vitest";
import sql from "mssql";
import {
  generateMigration,
  mapDataTypeToSql,
  createTableIfNotExistsSQL,
  createIndexIfNotExistsSQL,
} from "../migrations";
import { rewritePlaceholders, bindMSSQLParam } from "../client";
import { buildLimitClause, QueryBuilder } from "../query-builder";
import { buildMSSQLUpsertSQL } from "../repository";
import { DBType, DataTypes } from "../types";
import { defineModel } from "../model";

/**
 * These cover the parts of SQL Server support that are pure text: type
 * mappings, placeholder rewriting, row-limit clauses, DDL and the `MERGE`
 * upsert. Nothing here needs a server, and nothing here pretends to have run
 * one.
 */

const mssqlModel = defineModel({
  tableName: "mssql_widgets",
  columns: {
    id: { type: DataTypes.INTEGER, required: true },
    label: { type: DataTypes.STRING, required: true, unique: true },
  },
});

const mssqlUuidModel = defineModel({
  tableName: "mssql_gadgets",
  columns: {
    id: { type: DataTypes.UUID, required: true },
    label: { type: DataTypes.STRING, required: true },
  },
});

describe("mapDataTypeToSql for SQL Server", () => {
  const mssqlMappings: [DataTypes, string][] = [
    [DataTypes.STRING, "NVARCHAR(255)"],
    [DataTypes.TEXT, "NVARCHAR(MAX)"],
    [DataTypes.INTEGER, "INT"],
    [DataTypes.BIGINT, "BIGINT"],
    [DataTypes.FLOAT, "REAL"],
    [DataTypes.DOUBLE, "FLOAT"],
    [DataTypes.DECIMAL, "DECIMAL(10,2)"],
    [DataTypes.BOOLEAN, "BIT"],
    [DataTypes.DATE, "DATE"],
    [DataTypes.DATETIME, "DATETIME2"],
    [DataTypes.JSON, "NVARCHAR(MAX)"],
    [DataTypes.UUID, "UNIQUEIDENTIFIER"],
    [DataTypes.BLOB, "VARBINARY(MAX)"],
  ];

  it.each(mssqlMappings)("maps %s", (dataType, expected) => {
    expect(mapDataTypeToSql(dataType, DBType.MSSQL)).toBe(expected);
  });

  it("falls back to NVARCHAR(MAX) for an unknown type", () => {
    expect(mapDataTypeToSql("somethingelse", DBType.MSSQL)).toBe(
      "NVARCHAR(MAX)",
    );
  });

  it("accepts a raw string type name", () => {
    expect(mapDataTypeToSql("uuid", DBType.MSSQL)).toBe("UNIQUEIDENTIFIER");
  });

  it("leaves PostgreSQL mappings unchanged", () => {
    expect(mapDataTypeToSql(DataTypes.STRING, DBType.Postgres)).toBe("TEXT");
    expect(mapDataTypeToSql(DataTypes.DOUBLE, DBType.Postgres)).toBe(
      "DOUBLE PRECISION",
    );
    expect(mapDataTypeToSql(DataTypes.JSON, DBType.Postgres)).toBe("JSONB");
    expect(mapDataTypeToSql(DataTypes.BLOB, DBType.Postgres)).toBe("BYTEA");
    expect(mapDataTypeToSql("unknown", DBType.Postgres)).toBe("TEXT");
  });

  it("leaves MySQL mappings unchanged", () => {
    expect(mapDataTypeToSql(DataTypes.STRING, DBType.MySQL)).toBe(
      "VARCHAR(255)",
    );
    expect(mapDataTypeToSql(DataTypes.BOOLEAN, DBType.MySQL)).toBe("TINYINT(1)");
    expect(mapDataTypeToSql("unknown", DBType.MySQL)).toBe("TEXT");
  });

  it("leaves SQLite mappings unchanged", () => {
    expect(mapDataTypeToSql(DataTypes.STRING, DBType.SQLite)).toBe("TEXT");
    expect(mapDataTypeToSql(DataTypes.DECIMAL, DBType.SQLite)).toBe("NUMERIC");
    expect(mapDataTypeToSql("unknown", DBType.SQLite)).toBe("TEXT");
  });
});

describe("rewritePlaceholders", () => {
  it("numbers SQL Server parameters from zero, in order", () => {
    expect(
      rewritePlaceholders(
        "SELECT * FROM t WHERE a = ? AND b = ?",
        DBType.MSSQL,
      ),
    ).toBe("SELECT * FROM t WHERE a = @param0 AND b = @param1");
  });

  it("numbers a longer statement consecutively", () => {
    const rewritten = rewritePlaceholders(
      "INSERT INTO t (a, b, c, d, e) VALUES (?, ?, ?, ?, ?)",
      DBType.MSSQL,
    );
    expect(rewritten).toBe(
      "INSERT INTO t (a, b, c, d, e) VALUES (@param0, @param1, @param2, @param3, @param4)",
    );
    expect(rewritten.match(/@param\d+/g)).toEqual([
      "@param0",
      "@param1",
      "@param2",
      "@param3",
      "@param4",
    ]);
  });

  it("leaves a statement with no placeholders alone", () => {
    expect(rewritePlaceholders("SELECT 1 AS ok", DBType.MSSQL)).toBe(
      "SELECT 1 AS ok",
    );
  });

  it("leaves PostgreSQL numbering unchanged", () => {
    expect(
      rewritePlaceholders("SELECT * FROM t WHERE a = ? AND b = ?", DBType.Postgres),
    ).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
  });

  it("leaves MySQL and SQLite statements unchanged", () => {
    const query = "SELECT * FROM t WHERE a = ?";
    expect(rewritePlaceholders(query, DBType.MySQL)).toBe(query);
    expect(rewritePlaceholders(query, DBType.SQLite)).toBe(query);
  });
});

describe("bindMSSQLParam", () => {
  /** Stands in for an `sql.Request`, recording how each input was bound. */
  function recorder() {
    const calls: { name: string; args: any[] }[] = [];
    return {
      calls,
      input(name: string, ...args: any[]) {
        calls.push({ name, args });
        return this;
      },
    };
  }

  it("binds a value positionally", () => {
    const request = recorder();
    bindMSSQLParam(request, 0, 42);
    bindMSSQLParam(request, 1, "hello");

    expect(request.calls).toEqual([
      { name: "param0", args: [42] },
      { name: "param1", args: ["hello"] },
    ]);
  });

  it("binds null and undefined as an explicitly typed NULL", () => {
    const request = recorder();
    bindMSSQLParam(request, 0, null);
    bindMSSQLParam(request, 1, undefined);

    expect(request.calls).toEqual([
      { name: "param0", args: [sql.NVarChar, null] },
      { name: "param1", args: [sql.NVarChar, null] },
    ]);
  });

  it("does not add a type for falsy-but-present values", () => {
    const request = recorder();
    bindMSSQLParam(request, 0, 0);
    bindMSSQLParam(request, 1, false);
    bindMSSQLParam(request, 2, "");

    expect(request.calls).toEqual([
      { name: "param0", args: [0] },
      { name: "param1", args: [false] },
      { name: "param2", args: [""] },
    ]);
  });
});

describe("buildLimitClause for SQL Server", () => {
  it("emits nothing when neither limit nor offset was set", () => {
    expect(buildLimitClause(null, null, false, DBType.MSSQL)).toBe("");
    expect(buildLimitClause(null, null, true, DBType.MSSQL)).toBe("");
  });

  it("adds a constant ORDER BY when the statement has none", () => {
    expect(buildLimitClause(5, null, false, DBType.MSSQL)).toBe(
      "\nORDER BY (SELECT NULL)\nOFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY",
    );
  });

  it("keeps an existing ORDER BY and skips no rows for a bare limit", () => {
    expect(buildLimitClause(5, null, true, DBType.MSSQL)).toBe(
      "\nOFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY",
    );
  });

  it("emits OFFSET alone when only an offset was set", () => {
    expect(buildLimitClause(null, 10, false, DBType.MSSQL)).toBe(
      "\nORDER BY (SELECT NULL)\nOFFSET 10 ROWS",
    );
    expect(buildLimitClause(null, 10, true, DBType.MSSQL)).toBe(
      "\nOFFSET 10 ROWS",
    );
  });

  it("emits OFFSET and FETCH when both were set", () => {
    expect(buildLimitClause(5, 10, false, DBType.MSSQL)).toBe(
      "\nORDER BY (SELECT NULL)\nOFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY",
    );
    expect(buildLimitClause(5, 10, true, DBType.MSSQL)).toBe(
      "\nOFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY",
    );
  });

  it("never emits an ORDER BY fallback for the LIMIT dialects", () => {
    for (const dialect of [DBType.SQLite, DBType.MySQL, DBType.Postgres]) {
      expect(buildLimitClause(5, null, false, dialect)).toBe("\nLIMIT 5");
      expect(buildLimitClause(null, 10, false, dialect)).toBe(
        "\nLIMIT 9223372036854775807 OFFSET 10",
      );
      expect(buildLimitClause(5, 10, false, dialect)).toBe(
        "\nLIMIT 5 OFFSET 10",
      );
      expect(buildLimitClause(null, null, false, dialect)).toBe("");
    }
  });

  it("defaults to the LIMIT form when no dialect is given", () => {
    expect(buildLimitClause(5, 10, false)).toBe("\nLIMIT 5 OFFSET 10");
  });
});

describe("QueryBuilder row limiting", () => {
  it("renders OFFSET/FETCH when built for SQL Server", () => {
    const qb = new QueryBuilder("users").limit(5);
    expect(qb.build(DBType.MSSQL).query).toBe(
      "SELECT * FROM users\nORDER BY (SELECT NULL)\nOFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY",
    );
  });

  it("renders the LIMIT form when no dialect is given", () => {
    const qb = new QueryBuilder("users").limit(5);
    expect(qb.build().query).toBe("SELECT * FROM users\nLIMIT 5");
    expect(qb.toSQL().query).toBe("SELECT * FROM users\nLIMIT 5");
  });

  it("keeps an explicit ORDER BY out of the fallback", () => {
    const qb = new QueryBuilder("users").orderBy("id").limit(5).offset(2);
    expect(qb.build(DBType.MSSQL).query).toBe(
      "SELECT * FROM users\nORDER BY id ASC\nOFFSET 2 ROWS FETCH NEXT 5 ROWS ONLY",
    );
  });

  it("holds the dialect set by withDialect", () => {
    const qb = new QueryBuilder("users").limit(1).withDialect(DBType.MSSQL);
    expect(qb.build().query).toContain("OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY");
  });

  it("takes the dialect from the client it executes against", async () => {
    const sent: string[] = [];
    const stubClient = {
      config: { type: DBType.MSSQL },
      query: async (query: string) => {
        sent.push(query);
        return [];
      },
    };

    await new QueryBuilder("users").limit(1).execute(stubClient as any);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(
      "SELECT * FROM users\nORDER BY (SELECT NULL)\nOFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY",
    );
  });
});

describe("buildMSSQLUpsertSQL", () => {
  const columns = ["id", "email", "name"];

  it("binds each value exactly once, in the USING clause", () => {
    const statement = buildMSSQLUpsertSQL("users", columns, ["email"]);
    expect(statement.match(/\?/g) ?? []).toHaveLength(columns.length);
  });

  it("matches on the key columns and updates the rest", () => {
    const statement = buildMSSQLUpsertSQL("users", columns, ["email"]);
    expect(statement).toContain("MERGE INTO users AS target");
    expect(statement).toContain(
      "USING (SELECT ? AS id, ? AS email, ? AS name) AS source",
    );
    expect(statement).toContain("ON (target.email = source.email)");
    expect(statement).toContain(
      "WHEN MATCHED THEN UPDATE SET target.id = source.id, target.name = source.name",
    );
    expect(statement).toContain(
      "WHEN NOT MATCHED THEN INSERT (id, email, name) VALUES (source.id, source.email, source.name)",
    );
    expect(statement).toContain("OUTPUT INSERTED.*;");
  });

  it("matches on several keys", () => {
    const statement = buildMSSQLUpsertSQL("users", columns, ["id", "email"]);
    expect(statement).toContain(
      "ON (target.id = source.id AND target.email = source.email)",
    );
    expect(statement).toContain(
      "WHEN MATCHED THEN UPDATE SET target.name = source.name",
    );
  });

  it("terminates the statement, as T-SQL requires", () => {
    expect(buildMSSQLUpsertSQL("users", columns, ["email"]).endsWith(";")).toBe(
      true,
    );
  });

  it("inserts alone when there is no key to match on", () => {
    const statement = buildMSSQLUpsertSQL("users", ["id", "name"], []);
    expect(statement).toBe(
      "INSERT INTO users (id, name) OUTPUT INSERTED.* VALUES (?, ?)",
    );
    expect(statement.match(/\?/g) ?? []).toHaveLength(2);
  });
});

describe("createTableIfNotExistsSQL", () => {
  it("uses IF NOT EXISTS for the three original dialects", () => {
    for (const dialect of [DBType.SQLite, DBType.MySQL, DBType.Postgres]) {
      expect(createTableIfNotExistsSQL("users", "id INT", dialect)).toBe(
        "CREATE TABLE IF NOT EXISTS users (id INT)",
      );
    }
  });

  it("uses an existence check for SQL Server", () => {
    expect(createTableIfNotExistsSQL("users", "id INT", DBType.MSSQL)).toBe(
      "IF OBJECT_ID(N'users', N'U') IS NULL CREATE TABLE users (id INT)",
    );
  });

  it("unquotes the identifier for the existence check only", () => {
    expect(
      createTableIfNotExistsSQL('"users"', "id INT", DBType.MSSQL),
    ).toBe(
      "IF OBJECT_ID(N'users', N'U') IS NULL CREATE TABLE \"users\" (id INT)",
    );
  });
});

describe("createIndexIfNotExistsSQL", () => {
  it("uses IF NOT EXISTS for the three original dialects", () => {
    expect(
      createIndexIfNotExistsSQL('"i"', '"t"', ['"c"'], true, DBType.SQLite),
    ).toBe('CREATE UNIQUE INDEX IF NOT EXISTS "i" ON "t" ("c")');
    expect(
      createIndexIfNotExistsSQL('"i"', '"t"', ['"c"'], false, DBType.Postgres),
    ).toBe('CREATE INDEX IF NOT EXISTS "i" ON "t" ("c")');
  });

  it("checks sys.indexes for SQL Server", () => {
    expect(
      createIndexIfNotExistsSQL('"t_c_uniq"', '"t"', ['"c"'], true, DBType.MSSQL),
    ).toBe(
      "IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N't_c_uniq' AND object_id = OBJECT_ID(N't')) CREATE UNIQUE INDEX \"t_c_uniq\" ON \"t\" (\"c\")",
    );
  });
});

describe("generateMigration for SQL Server", () => {
  it("generates an IDENTITY primary key", async () => {
    const migration = await generateMigration(
      mssqlModel,
      "create_mssql_widgets",
      DBType.MSSQL,
    );

    expect(migration.up[0]).toBe(
      "IF OBJECT_ID(N'mssql_widgets', N'U') IS NULL CREATE TABLE mssql_widgets (id INT IDENTITY(1,1) PRIMARY KEY, label NVARCHAR(255) NOT NULL UNIQUE)",
    );
  });

  it("maps a UUID primary key to UNIQUEIDENTIFIER", async () => {
    const migration = await generateMigration(
      mssqlUuidModel,
      "create_mssql_gadgets",
      DBType.MSSQL,
    );

    expect(migration.up[0]).toContain(
      "id UNIQUEIDENTIFIER PRIMARY KEY",
    );
    expect(migration.up[0]).toContain("label NVARCHAR(255) NOT NULL");
  });

  it("keeps the three original dialects byte-identical", async () => {
    const sqlite = await generateMigration(
      mssqlModel,
      "create",
      DBType.SQLite,
    );
    expect(sqlite.up[0]).toBe(
      "CREATE TABLE IF NOT EXISTS mssql_widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL UNIQUE)",
    );

    const postgres = await generateMigration(
      mssqlModel,
      "create",
      DBType.Postgres,
    );
    expect(postgres.up[0]).toBe(
      "CREATE TABLE IF NOT EXISTS mssql_widgets (id SERIAL PRIMARY KEY, label TEXT NOT NULL UNIQUE)",
    );

    const mysql = await generateMigration(mssqlModel, "create", DBType.MySQL);
    expect(mysql.up[0]).toBe(
      "CREATE TABLE IF NOT EXISTS mssql_widgets (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(255) NOT NULL UNIQUE)",
    );
    expect(mysql.down[0]).toBe("DROP TABLE IF EXISTS mssql_widgets");
  });
});
