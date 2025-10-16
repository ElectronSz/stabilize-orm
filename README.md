# Stabilize ORM

_A Modern, Type-Safe, and Expressive ORM for Bun_

---

**Stabilize** is a lightweight, feature-rich ORM designed for performance and developer experience. It provides a unified, database-agnostic API for **PostgreSQL**, **MySQL**, and **SQLite**. Powered by a robust query builder, elegant decorator-based models, automatic versioning, and a full-featured command-line interface, Stabilize is built to scale with your app.

---

## 🚀 Features

- **Unified API**: Write once, run on PostgreSQL, MySQL, or SQLite.
- **Type-Safe Decorators**: Define models and columns with the powerful `DataTypes` enum for true database-agnostic schemas.
- **Full-Featured CLI**: Generate models, manage migrations, seed data, and reset your database from the command line with [stabilize-cli](https://github.com/ElectronSz/stabilize-cli).
- **Automatic Migrations**: Generate database-specific SQL schemas directly from your model definitions.
- **Versioned Models & Time-Travel**: Add `@Versioned()` to your models for automatic history tables and snapshot queries.
- **Retry Logic**: Automatic exponential backoff for database queries to handle transient connection issues.
- **Connection Pooling**: Efficient connection management for PostgreSQL and MySQL.
- **Transactional Integrity**: Built-in support for atomic transactions with automatic rollback on failure.
- **Advanced Query Builder**: Fluent, chainable API for building complex queries, including joins, filters, ordering, and pagination.
- **Model Relationships**: Use `OneToOne`, `ManyToOne`, `OneToMany`, and `ManyToMany` decorators for relationships.
- **Soft Deletes**: Add `@SoftDelete()` to your model for transparent "deleted" flags and safe row removal.
- **Lifecycle Hooks**: Use the `@Hook()` decorator for model lifecycle events like `beforeCreate`, `afterUpdate`, etc.
- **Pluggable Logging**: Includes a robust `ConsoleLogger` with support for file-based, rotating logs.
- **Custom Errors**: `StabilizeError` provides clear, consistent error handling.
- **Caching Layer**: Optional Redis-backed caching with `cache-aside` and `write-through` strategies.

---

## 📦 Installation

Stabilize ORM requires a modern JavaScript runtime (Bun v1.0+, Node.js v18+, Deno v1.28+).

```bash
# Using Bun
bun add stabilize-orm reflect-metadata

# Using npm
npm install stabilize-orm reflect-metadata
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

First, create a database configuration file.

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

Next, create a central ORM instance that your application can use. Import `reflect-metadata` once at your application's entry point.

```typescript
// db.ts
import 'reflect-metadata';
import { Stabilize, type CacheConfig, type LoggerConfig, LogLevel } from "stabilize-orm";
import dbConfig from "./database";

const cacheConfig: CacheConfig = {
  enabled: process.env.CACHE_ENABLED === "true",
  redisUrl: process.env.REDIS_URL,
  ttl: 60,
};

const loggerConfig: LoggerConfig = {
  level: LogLevel.Info,
  filePath: 'logs/stabilize.log',
  maxFileSize: 5 * 1024 * 1024, // 5MB
  maxFiles: 3,
};

export const orm = new Stabilize(dbConfig, cacheConfig, loggerConfig);
```

---

## 🏗️ Models & Relationships

Define your tables as classes using decorators. The `@Column` decorator uses the `DataTypes` enum for a truly database-agnostic schema.

### Example: Users and Roles (Many-to-Many) with Versioning

```typescript
// models/User.ts
import 'reflect-metadata';
import { Model, Column, DataTypes, Required, Unique, OneToMany, Versioned } from 'stabilize-orm';
import { UserRole } from './UserRole';

@Model('users')
@Versioned() // Enables history table for time-travel/audit
export class User {
  @Column({ type: DataTypes.INTEGER, name: 'id' })
  id!: number;

  @Column({ type: DataTypes.STRING, length: 100 })
  @Required() @Unique()
  email!: string;

  @OneToMany(() => UserRole, 'user')
  roles?: UserRole[];
}
```

```typescript
// models/Role.ts
import 'reflect-metadata';
import { Model, Column, DataTypes, Required, Unique } from 'stabilize-orm';

@Model('roles')
export class Role {
  @Column({ type: DataTypes.INTEGER, name: 'id' })
  id!: number;

  @Column({ type: DataTypes.STRING, length: 50 })
  @Required() @Unique()
  name!: string;
}
```

```typescript
// models/UserRole.ts
import 'reflect-metadata';
import { Model, Column, DataTypes, Required, ManyToOne, Index } from 'stabilize-orm';
import { User } from './User';
import { Role } from './Role';

@Model('user_roles')
export class UserRole {
  @Column({ type: DataTypes.INTEGER, name: 'id' })
  id!: number;

  @Column({ type: DataTypes.INTEGER, name: 'user_id' })
  @Required() @Index()
  userId!: number;

  @Column({ type: DataTypes.INTEGER, name: 'role_id' })
  @Required() @Index()
  roleId!: number;

  @ManyToOne(() => User, 'userId')
  user?: User;

  @ManyToOne(() => Role, 'roleId')
  role?: Role;
}
```

---

## ⏳ Versioning & Auditing

Enable automatic history tracking and time-travel queries by adding `@Versioned()` to your model.

- Each change is recorded in a `<table>_history` table with version, operation, and audit columns.
- Supports snapshot queries, rollbacks, audits, and time-travel.

### **Versioning Example**

```typescript
@Model('users')
@Versioned()
export class User {
  @Column({ type: DataTypes.INTEGER, name: 'id' })
  id!: number;

  @Column({ type: DataTypes.STRING, length: 100 })
  name!: string;
}

// --- Using versioning features:

const userRepository = orm.getRepository(User);

// Rollback to a previous version
await userRepository.rollback(1, 3); // roll back user with id=1 to version 3

// Get a snapshot as of a specific date
const userAsOf = await userRepository.asOf(1, new Date('2025-01-01T00:00:00Z'));
console.log(userAsOf);

// View full version history
const history = await userRepository.history(1);
console.log(history);
```

---

## 🔄 Model Lifecycle Hooks

Stabilize ORM supports lifecycle hooks via the `@Hook()` decorator.  
You can run logic before/after create, update, delete, or save.

### **Hooks Example**

```typescript
import { Model, Column, DataTypes, Hook } from 'stabilize-orm';

@Model('users')
export class User {
  @Column({ type: DataTypes.INTEGER, name: 'id' })
  id!: number;

  @Column({ type: DataTypes.STRING, length: 100 })
  name!: string;

  @Column({ type: DataTypes.DATETIME, name: 'created_at' })
  createdAt!: Date;

  @Column({ type: DataTypes.DATETIME, name: 'updated_at' })
  updatedAt!: Date;

  @Hook('beforeCreate')
  setCreatedAt() {
    this.createdAt = new Date();
  }

  @Hook('beforeUpdate')
  setUpdatedAt() {
    this.updatedAt = new Date();
  }

  @Hook('afterCreate')
  logCreate() {
    console.log(`User created: ${this.name}`);
  }
}
```

You can use `@Hook` with: `'beforeCreate'`, `'afterCreate'`, `'beforeUpdate'`, `'afterUpdate'`, `'beforeDelete'`, `'afterDelete'`, `'beforeSave'`, `'afterSave'`.

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
import { orm } from './db';
import { User } from 'models/User';

const userRepository = orm.getRepository(User);

const newUser = await userRepository.create({ email: 'lwazicd@icloud.com' });
const foundUser = await userRepository.findOne(newUser.id);
const updatedUser = await userRepository.update(newUser.id, { email: 'admin@offbytesecure.com' });
await userRepository.delete(newUser.id);
```

### Advanced Queries with the Query Builder

```typescript
const activeAdmins = await orm.getRepository(UserRole)
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
  build(): { query: string; params: any[] };
  execute(client?: DBClient, cache?: Cache, cacheKey?: string): Promise<User[]>;
}
```

---

## 🗑️ Soft Deletes

Add `@SoftDelete()` to a model property to enable transparent soft deletes (e.g., `deleted_at` timestamp).
- Use `repository.softDelete(id)` to mark an entity as deleted.
- Use `find({ includeDeleted: true })` to include soft-deleted rows.

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
<em>File last updated: 2025-10-16 19:41:00 UTC</em>

</div>