# Stabilize ORM

_A Modern, Type-Safe, and Expressive ORM for Bun_

<p align="left">
  <img src="./public/logo_both-transparent.png" alt="Stabilize ORM Logo" width="280" />
</p>

<p align="left">
  <a href="https://www.npmjs.com/package/stabilize-orm"><img src="https://img.shields.io/npm/v/stabilize-orm.svg?label=version&color=blue" alt="NPM Version"></a>
  <a href="https://github.com/ElectronSz/stabilize-cli/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/stabilize-orm.svg?color=green" alt="License"></a>
  <a href="https://github.com/ElectronSz/stabilize-cli"><img src="https://img.shields.io/badge/Cli-Stabilize%202.1.0-blue.svg" alt="Stabilize CLI"></a>
  <a href="#"><img src="https://img.shields.io/badge/PostgreSQL-supported-blue" alt="PostgreSQL"></a>
  <a href="#"><img src="https://img.shields.io/badge/MySQL-supported-blue" alt="MySQL"></a>
  <a href="#"><img src="https://img.shields.io/badge/SQLite-supported-blue" alt="SQLite"></a>
<a href="https://github.com/ElectronSz/stabilize-orm/actions/workflows/ci-cd.yml">
  <img src="https://github.com/ElectronSz/stabilize-orm/actions/workflows/ci-cd.yml/badge.svg" alt="Build Status">
</a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT License"></a>
</p>

**Stabilize** is a lightweight, feature-rich ORM designed for performance and developer experience. It provides a unified, database-agnostic API for **PostgreSQL**, **MySQL**, and **SQLite**. Powered by a robust query builder, programmatic model definitions, automatic versioning, and a full-featured command-line interface, Stabilize is built to scale with your app.

---

## 🚀 Features

- **Unified API**: Write once, run on PostgreSQL, MySQL, or SQLite.
- **Programmatic Model Definitions**: Define models and columns using the `defineModel` API with the `DataTypes` enum for database-agnostic schemas.
- **Full-Featured CLI**: Generate models, manage migrations, seed data, and reset your database from the command line with [stabilize-cli](https://github.com/ElectronSz/stabilize-cli).
- **Automatic Migrations**: Generate database-specific SQL schemas directly from your model definitions.
- **Versioned Models & Time-Travel**: Enable versioning in your model configuration for automatic history tables and snapshot queries.
- **Retry Logic**: Automatic exponential backoff for database queries to handle transient connection issues.
- **Connection Pooling**: Efficient connection management for PostgreSQL and MySQL.
- **Transactional Integrity**: Built-in support for atomic transactions with automatic rollback on failure.
- **Advanced Query Builder**: Fluent, chainable API for building complex queries, including joins, filters, ordering, and pagination.
- **Pagination Helper**: Easily paginate any query with `.paginate(page, pageSize)` and get `{ data, total, page, pageSize }`.
- **Advanced Model Validation**: Enforce rules like `required`, `minLength`, `maxLength`, `pattern`, and custom validators—errors are thrown on invalid input.
- **Model Relationships**: Define `OneToOne`, `ManyToOne`, `OneToMany`, and `ManyToMany` relationships in the model configuration.
- **Soft Deletes**: Enable soft deletes in the model configuration for transparent "deleted" flags and safe row removal.
- **Lifecycle Hooks**: Define hooks in the model configuration or as class methods for lifecycle events like `beforeCreate`, `afterUpdate`, etc.
- **Pluggable Logging**: Includes a robust `StabilizeLogger` with support for file-based, rotating logs.
- **Custom Errors**: `StabilizeError` provides clear, consistent error handling.
- **Caching Layer**: Optional Redis-backed caching with `cache-aside` and `write-through` strategies.
- **Custom Query Scopes**: Define reusable query conditions (scopes) in models for simplified, reusable filtering logic.
- **Timestamps**: Automatically manage `createdAt` and `updatedAt` columns for tracking record creation and update times.
- **SQL Default Expressions**: Support database-side default expressions (e.g., `gen_random_uuid()`, `NOW()`) for columns using the `sqlDefault()` helper.
- **Nested Relations (Eager Loading)**: Load deeply nested relations using dot notation like `"roles.permissions"`.
- **AutoMigrate with Index Management**: Automatically create, detect, and remove indexes and unique constraints during migration.
- **Advanced Query Builder Filters**: Chainable `.orWhere()`, `.whereIn()`, `.whereNotIn()`, `.whereNull()`, `.whereNotNull()`, `.whereBetween()`, `.groupBy()`, `.having()`, `.lock()` methods.
- **Optimistic Locking**: Add `optimisticLock: true` to a version column to automatically detect concurrent modification conflicts and throw `CONCURRENT_MODIFICATION` errors.
- **findAndCount**: Get paginated results with a total count in one call.
- **findOneBy / findBy**: TypeORM-style conditional finders without writing raw SQL.
- **Aggregate Queries**: Run `count()`, `sum()`, `avg()`, `min()`, `max()` directly from the repository or query builder.
- **Cursor-Based Pagination**: Efficient forward/backward cursor pagination for large datasets (Prisma-style `findMany`).
- **exists**: Check if a record exists without loading it.
- **recoverAll**: Bulk restore all soft-deleted records.
- **truncate**: Clear all rows from a table.
- **seed / defineSeed**: Laravel-style seeding framework with `defineSeed` and `runSeeds`.
- **resetDatabase**: Drop tables, re-migrate, and optionally re-seed for development.
- **healthCheck**: Get database and table health status with latency for monitoring endpoints.
- **rawQuery / rawExec**: Execute raw SQL directly from the `Stabilize` instance.
- **bulkUpsert**: Upsert multiple records in a single transaction.
- **findMany**: Prisma-style query with `where`, `cursor`, `take`, `skip`, `orderBy`.
- **countDistinct**: Count unique values in a column.
- **increment / decrement**: Atomically increment or decrement a numeric field.
- **pluck**: Get an array of a single column's values (Rails-style).
- **selectColumns**: Get only specific columns from a query.
- **toggle**: Toggle a boolean field (Rails-style).
- **updateBy / deleteBy**: Conditional bulk updates and deletes without writing SQL.
- **restoreBy**: Restore soft-deleted records matching conditions.
- **findDeleted / withTrashed**: Query soft-deleted or all records.
- **upsertMany**: Batch upsert in configurable batch sizes.
- **map / each / eachBatch**: Transform, iterate, and batch-process query results.
- **lockForUpdate**: Pessimistic row locking for read-modify-write.
- **firstOrCreate / updateOrCreate**: Laravel-style find-or-create patterns.
- **first / last / random**: Single-record shortcuts.
- **StabilizeEmitter**: Event system for `query`, `error`, `connection:open/close`, `transaction:start/complete/error`.
- **TransactionIsolationLevel**: Type for `READ UNCOMMITTED`, `READ COMMITTED`, `REPEATABLE READ`, `SERIALIZABLE`.
- **generateUUID**: Cross-runtime UUID generation helper.
- **poolStats**: Get connection pool statistics.
- **Database Backup & Restore**: `db:backup` and `db:restore` commands for database backup management.
- **API Generation**: `generate:api` command scaffolds full CRUD REST API routes from models.
- **Fresh Migrations**: `migrate:fresh` drops all tables and re-runs migrations without seeding.
- **Database Size Analysis**: `db:size` command shows table sizes and row count statistics.

---

## 📦 Installation

Stabilize ORM requires a modern JavaScript runtime (Bun v1.3+).

```bash
# Using Bun
bun add stabilize-orm

# Using npm
npm install stabilize-orm
```

---

## 📃 Documentation & Community

- [Changelog](./CHANGELOG.md)
- [License](./LICENSE)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Security Policy](./SECURITY.md)
- [Support](./SUPPORT.md)
- [Funding](./FUNDING.md)

### Examples

- [Blog](./examples/blog.ts) - Blog with users, posts, comments, and versioning
- [E-Commerce](./examples/ecommerce.ts) - Products, categories, orders with transactions
- [REST API](./examples/rest-api.ts) - Express.js REST API with pagination and optimistic locking
- [SaaS](./examples/saas.ts) - Multi-tenant SaaS with tenants, members, and scoped projects
- [CMS](./examples/cms.ts) - Content management with authors, categories, articles, and versioning
- [Analytics](./examples/analytics.ts) - Event tracking with aggregations and metrics

---

## ⚙️ Configuration

Create a database configuration file.

```typescript
// config/database.ts
import { DBType, type DBConfig } from "stabilize-orm";

const dbConfig: DBConfig = {
  type: DBType.Postgres,
  connectionString:
    process.env.DATABASE_URL || "postgres://user:password@localhost:5432/mydb",
  retryAttempts: 3,
  retryDelay: 1000,
};

export default dbConfig;
```

Next, create a central ORM instance for your application.

```typescript
// db.ts
import {
  Stabilize,
  type CacheConfig,
  type LoggerConfig,
  LogLevel,
} from "stabilize-orm";
import dbConfig from "./database";

const cacheConfig: CacheConfig = {
  enabled: process.env.CACHE_ENABLED === "true",
  redisUrl: process.env.REDIS_URL,
  ttl: 60,
};

const loggerConfig: LoggerConfig = {
  level: LogLevel.Info,
  filePath: "logs/stabilize.log",
  maxFileSize: 5 * 1024 * 1024, // 5MB
  maxFiles: 3,
};

export const orm = new Stabilize(dbConfig, cacheConfig, loggerConfig);
```

---

## 🏗️ Models & Relationships

Define your tables as classes using the `defineModel` function. The `DataTypes` enum ensures database-agnostic schemas.

### Example: Users and Roles (Many-to-Many) with Versioning

```typescript
// models/User.ts
import { defineModel, DataTypes, RelationType } from "stabilize-orm";
import { UserRole } from "./UserRole";

const User = defineModel({
  tableName: "users",
  versioned: true,
  columns: {
    id: { type: DataTypes.Integer, required: true },
    email: {
      type: DataTypes.String,
      length: 100,
      required: true,
      unique: true,
    },
  },
  relations: [
    {
      type: RelationType.OneToMany,
      target: () => UserRole,
      property: "roles",
      foreignKey: "userId",
    },
  ],
  hooks: {
    beforeCreate: (entity) => console.log(`Creating user: ${entity.email}`),
  },
});

export { User };
```

---

## 🔍 Pagination

The built-in pagination helper makes it easy to retrieve a page of rows using LIMIT/OFFSET semantics.

```typescript
const users = await userRepository.find().paginate(2, 10).execute(dbClient);
// users = [...] // Returns an array of rows for that page
```

Or, use the query builder:

```typescript
const page = await userRepository
  .find()
  .where("isActive = ?", true)
  .paginate(1, 20)
  .execute();
```

---

## 🛡️ Advanced Validation

Models can define advanced validation rules for columns, including:

- `required`
- `minLength` / `maxLength`
- `pattern` (RegExp)
- `customValidator` (function)

Validation errors are thrown on create/update if data is invalid.

```typescript
const User = defineModel({
  tableName: "users",
  columns: {
    id: { type: DataTypes.Integer, required: true },
    email: {
      type: DataTypes.String,
      required: true,
      unique: true,
      minLength: 6,
      pattern: /^[^@]+@[^@]+\.[^@]+$/,
      customValidator: (val) =>
        val.endsWith("@offbytesecure.com") ||
        "Must use an @offbytesecure.com email",
    },
    password: { type: DataTypes.String, minLength: 8 },
  },
});
```

---

## ⏳ Versioning & Auditing

Enable automatic history tracking and time-travel queries by setting `versioned: true` in your model configuration.

- Each change is recorded in a `<table>_history` table with version, operation, and audit columns.
- Supports snapshot queries, rollbacks, audits, and time-travel.

### **Versioning Example**

```typescript
import { defineModel, DataTypes } from "stabilize-orm";

const User = defineModel({
  tableName: "users",
  versioned: true,
  columns: {
    id: { type: DataTypes.Integer, required: true },
    name: { type: DataTypes.String, length: 100 },
  },
});

// --- Using versioning features:

const userRepository = orm.getRepository(User);

// Rollback to a previous version
await userRepository.rollback(1, 3); // roll back user with id=1 to version 3

// Get a snapshot as of a specific date
const userAsOf = await userRepository.asOf(1, new Date("2025-01-01T00:00:00Z"));
console.log(userAsOf);

// View full version history
const history = await userRepository.history(1);
console.log(history);
```

---

## 🔄 Model Lifecycle Hooks

Stabilize ORM supports lifecycle hooks defined in the model configuration or as class methods. You can run logic before/after create, update, delete, or save.

### **Hooks Example**

```typescript
import { defineModel, DataTypes } from "stabilize-orm";

const User = defineModel({
  tableName: "users",
  columns: {
    id: { type: DataTypes.Integer, required: true },
    name: { type: DataTypes.String, length: 100 },
    createdAt: { type: DataTypes.DateTime },
    updatedAt: { type: DataTypes.DateTime },
  },
  hooks: {
    beforeCreate: (entity) => {
      entity.createdAt = new Date();
    },
    beforeUpdate: (entity) => {
      entity.updatedAt = new Date();
    },
    afterCreate: (entity) => {
      console.log(`User created: ${entity.name}`);
    },
  },
});

// Add a hook as a class method
User.prototype.afterUpdate = async function () {
  console.log(`Updated user: ${this.name}`);
};

export { User };
```

Supported hooks: `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`, `beforeSave`, `afterSave`.

---

## 💻 Command-Line Interface (CLI)

Stabilize includes a powerful CLI for managing your workflow. See: [stabilize-cli on GitHub](https://github.com/ElectronSz/stabilize-cli)

### Generating Files

- **Generate a model**:

  ```bash
  stabilize-cli generate:model Product
  ```

- **Generate a migration from a model**:

  ```bash
  stabilize-cli generate:migration User
  ```

- **Generate a seed file**:

  ```bash
  stabilize-cli generate:seed InitialRoles
  ```

- **Generate a REST API scaffold**:
  ```bash
  stabilize-cli generate:api User
  ```

### Database & Migration Management

- **Run all pending migrations**:

  ```bash
  stabilize-cli migrate
  ```

- **Roll back the last migration**:

  ```bash
  stabilize-cli migrate:rollback
  ```

- **Fresh migration (drop + re-migrate)**:

  ```bash
  stabilize-cli migrate:fresh --force
  ```

- **Run all pending seeds (in dependency order)**:

  ```bash
  stabilize-cli seed
  ```

- **Check the status of migrations and seeds**:

  ```bash
  stabilize-cli status
  ```

- **Reset the database (drop, migrate, seed)**:
  ```bash
  stabilize-cli db:reset
  ```

### Backup & Restore

- **Backup the database**:

  ```bash
  stabilize-cli db:backup
  ```

- **Restore from a backup**:
  ```bash
  stabilize-cli db:restore backups/backup_20250101120000.db --force
  ```

### Diagnostics

- **Database size statistics**:

  ```bash
  stabilize-cli db:size
  ```

- **Health check**:

  ```bash
  stabilize-cli health
  ```

- **CLI info**:
  ```bash
  stabilize-cli info
  ```

---

## 🧑‍💻 Querying Data

### Basic CRUD with Repositories

```typescript
import { orm } from "./db";
import { User } from "./models/User";

const userRepository = orm.getRepository(User);

const newUser = await userRepository.create({ email: "lwazicd@icloud.com" });
const foundUser = await userRepository.findOne(newUser.id);
const updatedUser = await userRepository.update(newUser.id, {
  email: "admin@offbytesecure.com",
});
await userRepository.delete(newUser.id);
```

### Advanced Queries with the Query Builder

```typescript
const activeAdmins = await orm
  .getRepository(UserRole)
  .find()
  .join("users", "user_roles.user_id = users.id")
  .join("roles", "user_roles.role_id = roles.id")
  .select("users.id", "users.email", "roles.name as role_name")
  .where("roles.name = ?", "Admin")
  .orderBy("users.email ASC")
  .execute();

console.log(activeAdmins);
```

#### Query Builder API

```typescript
{
  select(...fields: string[]): QueryBuilder<User>;
  where(condition: string, ...params: any[]): QueryBuilder<User>;
  orWhere(condition: string, ...params: any[]): QueryBuilder<User>;
  whereIn(column: string, values: any[]): QueryBuilder<User>;
  whereNotIn(column: string, values: any[]): QueryBuilder<User>;
  whereNull(column: string): QueryBuilder<User>;
  whereNotNull(column: string): QueryBuilder<User>;
  whereBetween(column: string, start: any, end: any): QueryBuilder<User>;
  groupBy(clause: string): QueryBuilder<User>;
  having(condition: string, ...params: any[]): QueryBuilder<User>;
  join(table: string, condition: string): QueryBuilder<User>;
  orderBy(clause: string): QueryBuilder<User>;
  limit(limit: number): QueryBuilder<User>;
  offset(offset: number): QueryBuilder<User>;
  lock(mode?: "FOR UPDATE" | "FOR SHARE"): QueryBuilder<User>;
  withRelations(...relations: string[]): QueryBuilder<User>;
  scope(name: string, ...args: any[]): QueryBuilder<User>;
  paginate(page: number, pageSize: number): QueryBuilder<User>;
  build(): { query: string; params: any[] };
  execute(client?: DBClient, cache?: Cache, cacheKey?: string): Promise<User[]>;
}
```

### Custom Query Scopes

Define reusable query conditions (scopes) in your model configuration to simplify and reuse common filtering logic. Scopes are applied via the `scope` method on `Repository` or `QueryBuilder`, allowing you to chain them with other query operations.

#### **Scopes Example**

```typescript
import { defineModel, DataTypes } from "stabilize-orm";
import { orm } from "./db";

const User = defineModel({
  tableName: "users",
  columns: {
    id: { type: DataTypes.Integer, required: true },
    email: { type: DataTypes.String, length: 100, required: true },
    isActive: { type: DataTypes.Boolean, required: true },
    createdAt: { type: DataTypes.DateTime },
    updatedAt: { type: DataTypes.DateTime },
  },
  scopes: {
    active: (qb) => qb.where("isActive = ?", true),
    recent: (qb, days: number) =>
      qb.where(
        "createdAt >= ?",
        new Date(Date.now() - days * 24 * 60 * 60 * 1000),
      ),
  },
});

const userRepository = orm.getRepository(User);

// Fetch active users
const activeUsers = await userRepository.scope("active").execute();

// Fetch users created in the last 7 days
const recentUsers = await userRepository.scope("recent", 7).execute();

// Combine scopes with other query operations
const recentActiveUsers = await userRepository
  .scope("active")
  .scope("recent", 7)
  .orderBy("createdAt DESC")
  .limit(10)
  .execute();

console.log(recentActiveUsers);
```

### Timestamps

Enable automatic management of `createdAt` and `updatedAt` columns by setting `timestamps` in your model configuration. The ORM automatically sets these fields during `create`, `update`, `bulkCreate`, `bulkUpdate`, and `upsert` operations in a TypeScript-safe manner, eliminating the need for manual hooks.

#### **Timestamps Example**

```typescript
import { defineModel, DataTypes } from "stabilize-orm";
import { orm } from "./db";

const User = defineModel({
  tableName: "users",
  columns: {
    id: { type: DataTypes.Integer, required: true },
    email: { type: DataTypes.String, length: 100, required: true },
    createdAt: { type: DataTypes.DateTime },
    updatedAt: { type: DataTypes.DateTime },
  },
  timestamps: {
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
});

const userRepository = orm.getRepository(User);

// Create a user (createdAt and updatedAt set automatically)
const newUser = await userRepository.create({ email: "lwazicd@icloud.com" });
console.log(newUser.createdAt, newUser.updatedAt); // Outputs current timestamp

// Update a user (updatedAt updated automatically)
const updatedUser = await userRepository.update(newUser.id, {
  email: "admin@offbytesecure.com",
});
console.log(updatedUser.updatedAt); // Outputs new timestamp

// Bulk create users
const newUsers = await userRepository.bulkCreate([
  { email: "user1@example.com" },
  { email: "user2@example.com" },
]);
console.log(newUsers.map((u) => u.createdAt)); // Outputs timestamps for each user
```

---

## 🗑️ Soft Deletes

Enable soft deletes by setting `softDelete: true` and marking a column (e.g., `deletedAt`) with `softDelete: true` in the model configuration.

- Use `repository.delete(id)` to mark an entity as deleted.
- Use `repository.recover(id)` to restore a soft-deleted entity.
- Queries automatically exclude soft-deleted rows unless specified otherwise.

### **Soft Delete Example**

```typescript
import { defineModel, DataTypes } from "stabilize-orm";

const User = defineModel({
  tableName: "users",
  softDelete: true,
  columns: {
    id: { type: DataTypes.Integer, required: true },
    email: { type: DataTypes.String, length: 100, required: true },
    deletedAt: { type: DataTypes.DateTime, softDelete: true },
  },
});

const userRepository = orm.getRepository(User);
await userRepository.create({ email: "lwazicd@icloud.com" });
await userRepository.delete(1); // Soft delete
await userRepository.recover(1); // Recover
```

---

## 🌐 Express.js Integration

Stabilize ORM works seamlessly with web frameworks like Express.

```typescript
import express from "express";
import { orm } from "./db";
import { User } from "./models/User";

const app = express();
app.use(express.json());

const userRepository = orm.getRepository(User);

app.get("/users", async (req, res) => {
  try {
    const users = await userRepository.find().execute();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

app.post("/users", async (req, res) => {
  try {
    const user = await userRepository.create(req.body);
    res.status(201).json(user);
  } catch (err) {
    res.status(500).json({ error: "User creation failed." });
  }
});

app.listen(3000, () => {
  console.log("Server listening on port 3000");
});
```

---

## 🧑‍🔬 Testing & Time-Travel

- Use time-travel queries to inspect historical entity states.
- Assert audit trails and rollback operations in your tests.

---

## 🔒 Optimistic Locking

Enable optimistic locking to detect concurrent modifications. Add `optimisticLock: true` to a version column in your model.

```typescript
import { defineModel, DataTypes } from "stabilize-orm";

const User = defineModel({
  tableName: "users",
  columns: {
    id: { type: DataTypes.Integer, required: true },
    name: { type: DataTypes.String },
    version: { type: DataTypes.Integer, optimisticLock: true },
  },
});

const userRepository = orm.getRepository(User);

// Create with initial version
const user = await userRepository.create({ name: "Lwazi", version: 1 });

// Update - version is automatically incremented
// If another transaction modified the record, a CONCURRENT_MODIFICATION error is thrown
try {
  await userRepository.update(user.id, {
    name: "Updated",
    version: user.version,
  });
} catch (err) {
  if (err.code === "CONCURRENT_MODIFICATION") {
    console.log("Record was modified by another transaction");
  }
}
```

---

## ⏱️ SQL Default Expressions

Use `sqlDefault()` to set database-side default values for columns (e.g., `gen_random_uuid()`, `NOW()`).

```typescript
import { defineModel, DataTypes, sqlDefault } from "stabilize-orm";

const User = defineModel({
  tableName: "users",
  columns: {
    id: {
      type: DataTypes.UUID,
      required: true,
      defaultExpression: sqlDefault("gen_random_uuid()"),
    },
    name: { type: DataTypes.String },
    createdAt: {
      type: DataTypes.DateTime,
      defaultExpression: sqlDefault("NOW()"),
    },
  },
});
```

---

## 📊 Advanced Query Builder

The query builder now supports additional filter methods:

```typescript
const results = await userRepository
  .find()
  .where("status = ?", "active")
  .orWhere("role = ?", "admin")
  .whereIn("age", [25, 30, 35])
  .whereBetween("createdAt", new Date("2025-01-01"), new Date("2025-12-31"))
  .whereNull("deletedAt")
  .groupBy("department")
  .having("COUNT(*) > ?", 5)
  .orderBy("createdAt DESC")
  .limit(10)
  .execute();
```

---

## 🔗 Nested Relations

Load deeply nested relations using dot notation:

```typescript
const user = await userRepository.findOne(1, {
  relations: ["roles", "roles.permissions"],
});
```

---

## 📊 Aggregation Queries

Run aggregate queries directly on the repository or query builder.

```typescript
// Repository-level aggregates
const total = await userRepository.count();
const exists = await userRepository.exists({
  email: "admin@offbytesecure.com",
});

const stats = await userRepository.aggregate({
  count: "*",
  sum: ["salary"],
  avg: ["salary"],
  min: ["salary"],
  max: ["salary"],
});
// stats = { count_: 100, sum_salary: 5000000, avg_salary: 50000, min_salary: 20000, max_salary: 150000 }
```

---

## 🔎 findOneBy / findBy

TypeORM-style conditional finders without writing raw SQL.

```typescript
// Find one record by condition
const user = await userRepository.findOneBy({ email: "lwazicd@icloud.com" });

// Find multiple records
const admins = await userRepository.findBy(
  { role: "admin" },
  { limit: 10, orderBy: "createdAt DESC" },
);

// Combined with relations
const user = await userRepository.findOneBy(
  { email: "lwazicd@icloud.com" },
  { relations: ["roles"] },
);
```

---

## 🔢 findAndCount

Get paginated results with a total count in a single call.

```typescript
const { data, total } = await userRepository.findAndCount();
console.log(`Showing ${data.length} of ${total} total records`);
```

---

## 🖱️ Cursor-Based Pagination

Efficient cursor-based pagination for large datasets.

```typescript
// First page
const page1 = await userRepository.findMany({
  take: 10,
  orderBy: { field: "id", direction: "ASC" },
});

// Next page using cursor
const lastId = page1[page1.length - 1].id;
const page2 = await userRepository.findMany({
  cursor: { field: "id", value: lastId, direction: "forward" },
  take: 10,
  orderBy: { field: "id", direction: "ASC" },
});
```

---

## 🌱 Database Seeding

Define and run seeds for populating development/test databases.

```typescript
import { defineSeed, runSeeds, resetDatabase } from "stabilize-orm";

// Define a seed
defineSeed("create-default-roles", async (db) => {
  const roleRepo = orm.getRepository(Role);
  await roleRepo.bulkCreate([
    { name: "Admin", permissions: "all" },
    { name: "User", permissions: "read" },
  ]);
});

// Run all seeds
await runSeeds(orm.client);

// Reset database (drop, migrate, seed)
await resetDatabase(orm.client, [User, Role]);
```

---

## 🏥 Health Check

Monitor database and cache connectivity with latency.

```typescript
const health = await orm.healthCheck();
// { status: "healthy", database: "postgres", latencyMs: 12.5, cacheStatus: "connected" }

// Per-table health
const userHealth = await userRepository.healthCheck();
// { status: "healthy", table: "users", rows: 142, latencyMs: 8.3 }
```

---

## 📂 Bulk Upsert

Upsert multiple records in a single transaction.

```typescript
const users = await userRepository.bulkUpsert(
  [
    { email: "lwazicd@icloud.com", name: "Lwazi" },
    { email: "ciniso@icloud.com", name: "Ciniso" },
  ],
  ["email"], // unique key(s)
);
```

---

## 🔧 Raw SQL

Execute raw SQL queries directly from the ORM instance.

```typescript
const results = await orm.rawQuery("SELECT * FROM users WHERE age > ?", [25]);
const { affectedRows } = await orm.rawExec(
  "UPDATE users SET active = false WHERE last_login < ?",
  [oneYearAgo],
);
```

---

## 🗑️ recoverAll / truncate

```typescript
// Restore all soft-deleted records
const recovered = await userRepository.recoverAll();
console.log(`Recovered ${recovered} records`);

// Clear the table
await userRepository.truncate();
```

---

## ⬆️⬇️ Increment / Decrement

Atomically update numeric fields without loading the record.

```typescript
const updated = await userRepository.increment(user.id, "loginCount", 1);
const updated = await userRepository.decrement(user.id, "credits", 5);
```

---

## 🏷️ Pluck / SelectColumns

```typescript
// Get just the email column as an array
const emails = await userRepository.pluck("email");
// ["lwazicd@icloud.com", "ciniso@icloud.com", ...]

// Get specific columns
const users = await userRepository.selectColumns("id", "email");
// [{ id: 1, email: "lwazicd@icloud.com" }, ...]
```

---

## 🔄 Toggle

Toggle a boolean field.

```typescript
const toggled = await userRepository.toggle(user.id, "isActive");
// isActive was true, now false (or vice versa)
```

---

## ✏️ updateBy / deleteBy

```typescript
// Update all active users' role to "member"
const updated = await userRepository.updateBy(
  { isActive: true },
  { role: "member" },
);

// Delete all users with null email
const deleted = await userRepository.deleteBy({ email: null });
```

---

## 🕳️ findDeleted / withTrashed

```typescript
// Get only soft-deleted records
const deletedUsers = await userRepository.findDeleted().execute();

// Get all records including soft-deleted
const allUsers = await userRepository.withTrashed().execute();

// Restore matching soft-deleted records
const restored = await userRepository.restoreBy({ role: "admin" });
```

---

## 🔄 firstOrCreate / updateOrCreate

```typescript
// Find or create in one call
const user = await userRepository.firstOrCreate(
  { email: "lwazicd@icloud.com" },
  { name: "Lwazi" },
);

// Find and update, or create if not found
const user = await userRepository.updateOrCreate(
  { email: "lwazicd@icloud.com" },
  { name: "Updated Name" },
);
```

---

## 🥇 first / last / random

```typescript
const firstUser = await userRepository.first();
const admin = await userRepository.first({ role: "admin" });
const lastUser = await userRepository.last();
const randomUser = await userRepository.random();
```

---

## 🔒 Pessimistic Locking (lockForUpdate)

```typescript
const user = await userRepository.lockForUpdate(user.id);
// The row is now locked for the duration of the transaction
```

---

## 📡 Event Emitter

Subscribe to ORM lifecycle events.

```typescript
const orm = new Stabilize(dbConfig);

orm.events.on("query", (entry) => {
  console.log(`[${entry.durationMs}ms] ${entry.query}`);
});

orm.events.on("error", (err) => {
  console.error("ORM error:", err);
});

orm.events.on("connection:open", (dbType) => {
  console.log(`Connected to ${dbType}`);
});
```

---

## 📦 Pool Stats

```typescript
const stats = await orm.poolStats();
// { active: 5, idle: 10, total: 15 }
```

---

## 🆔 generateUUID

```typescript
import { generateUUID } from "stabilize-orm";

const id = generateUUID();
// "550e8400-e29b-41d4-a716-446655440000"
```

---

## 📑 License

Licensed under the MIT License. See [LICENSE.md](./LICENSE.md) for details.

---

<div align="center">

Created with ❤️ by **ElectronSz**
<br/>
<em>File last updated: 2026-04-02</em>

</div>
