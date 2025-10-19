# Stabilize ORM

_A Modern, Type-Safe, and Expressive ORM for Bun_

<p align="left">
  <a href="https://www.npmjs.com/package/stabilize-orm"><img src="https://img.shields.io/npm/v/stabilize-orm.svg?label=version&color=blue" alt="NPM Version"></a>
  <a href="https://github.com/ElectronSz/stabilize-cli/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/stabilize-orm.svg?color=green" alt="License"></a>
  <a href="https://github.com/ElectronSz/stabilize-cli"><img src="https://img.shields.io/badge/Cli-Stabilize%201.2.0-blue.svg" alt="Stabilize CLI"></a>
  <a href="#"><img src="https://img.shields.io/badge/PostgreSQL-supported-blue" alt="PostgreSQL"></a>
  <a href="#"><img src="https://img.shields.io/badge/MySQL-supported-blue" alt="MySQL"></a>
  <a href="#"><img src="https://img.shields.io/badge/SQLite-supported-blue" alt="SQLite"></a>
  <a href="https://github.com/ElectronSz/stabilize-orm/actions"><img src="https://github.com/ElectronSz/stabilize-orm/workflows/CI/badge.svg" alt="Build Status"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT License"></a>
</p>
---

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
- **Model Relationships**: Define `OneToOne`, `ManyToOne`, `OneToMany`, and `ManyToMany` relationships in the model configuration.
- **Soft Deletes**: Enable soft deletes in the model configuration for transparent "deleted" flags and safe row removal.
- **Lifecycle Hooks**: Define hooks in the model configuration or as class methods for lifecycle events like `beforeCreate`, `afterUpdate`, etc.
- **Pluggable Logging**: Includes a robust `StabilizeLogger` with support for file-based, rotating logs.
- **Custom Errors**: `StabilizeError` provides clear, consistent error handling.
- **Caching Layer**: Optional Redis-backed caching with `cache-aside` and `write-through` strategies.
- **Custom Query Scopes**: Define reusable query conditions (scopes) in models for simplified, reusable filtering logic.
- **Timestamps**: Automatically manage `createdAt` and `updatedAt` columns for tracking record creation and update times.

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
- [License](./LICENSE.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Security Policy](./SECURITY.md)
- [Support](./SUPPORT.md)
- [Funding](./FUNDING.md)

---

## ⚙️ Configuration

Create a database configuration file.

```typescript
// config/database.ts
import { DBType, type DBConfig } from "stabilize-orm";

const dbConfig: DBConfig = {
  type: DBType.Postgres,
  connectionString: process.env.DATABASE_URL || "postgres://user:password@localhost:5432/mydb",
  retryAttempts: 3,
  retryDelay: 1000,
};

export default dbConfig;
```

Next, create a central ORM instance for your application.

```typescript
// db.ts
import { Stabilize, type CacheConfig, type LoggerConfig, LogLevel } from "stabilize-orm";
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
    email: { type: DataTypes.String, length: 100, required: true, unique: true },
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

// Add a hook as a class method
User.prototype.afterCreate = async function () {
  console.log(`Created user with ID: ${this.id}`);
};

export { User };
```

```typescript
// models/Role.ts
import { defineModel, DataTypes } from "stabilize-orm";

const Role = defineModel({
  tableName: "roles",
  columns: {
    id: { type: DataTypes.Integer, required: true },
    name: { type: DataTypes.String, length: 50, required: true, unique: true },
  },
});

export { Role };
```

```typescript
// models/UserRole.ts
import { defineModel, DataTypes, RelationType } from "stabilize-orm";
import { User } from "./User";
import { Role } from "./Role";

const UserRole = defineModel({
  tableName: "user_roles",
  columns: {
    id: { type: DataTypes.Integer, required: true },
    userId: { type: DataTypes.Integer, required: true, index: "idx_user_id" },
    roleId: { type: DataTypes.Integer, required: true, index: "idx_role_id" },
  },
  relations: [
    {
      type: RelationType.ManyToOne,
      target: () => User,
      property: "user",
      foreignKey: "userId",
    },
    {
      type: RelationType.ManyToOne,
      target: () => Role,
      property: "role",
      foreignKey: "roleId",
    },
  ],
});

export { UserRole };
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
    stabilize-cli generate model Product
    ```

- **Generate a migration from a model**:
    ```bash
    stabilize-cli generate migration User
    ```

- **Generate a seed file**:
    ```bash
    stabilize-cli generate seed InitialRoles
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

---

## 🧑‍💻 Querying Data

### Basic CRUD with Repositories

```typescript
import { orm } from "./db";
import { User } from "./models/User";

const userRepository = orm.getRepository(User);

const newUser = await userRepository.create({ email: "lwazicd@icloud.com" });
const foundUser = await userRepository.findOne(newUser.id);
const updatedUser = await userRepository.update(newUser.id, { email: "admin@offbytesecure.com" });
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
  join(table: string, condition: string): QueryBuilder<User>;
  orderBy(clause: string): QueryBuilder<User>;
  limit(limit: number): QueryBuilder<User>;
  offset(offset: number): QueryBuilder<User>;
  scope(name: string, ...args: any[]): QueryBuilder<User>;
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
    recent: (qb, days: number) => qb.where("createdAt >= ?", new Date(Date.now() - days * 24 * 60 * 60 * 1000)),
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
const updatedUser = await userRepository.update(newUser.id, { email: "admin@offbytesecure.com" });
console.log(updatedUser.updatedAt); // Outputs new timestamp

// Bulk create users
const newUsers = await userRepository.bulkCreate([
  { email: "user1@example.com" },
  { email: "user2@example.com" },
]);
console.log(newUsers.map(u => u.createdAt)); // Outputs timestamps for each user
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

## 📑 License

Licensed under the MIT License. See [LICENSE.md](./LICENSE.md) for details.

---

<div align="center">

Created with ❤️ by **ElectronSz**
<br/>
<em>File last updated: 2025-10-19 11:12:00 SAST</em>

</div>