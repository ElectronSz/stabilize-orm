import {
  Stabilize,
  defineModel,
  DataTypes,
  RelationType,
  DBType,
  LogLevel,
  type DBConfig,
  generateUUID,
} from "../index";

// ─── CONFIG ──────────────────────────────────────────────────────────

const dbConfig: DBConfig = {
  type: DBType.SQLite,
  connectionString: "./data/saas.db",
};

const orm = new Stabilize(
  dbConfig,
  { enabled: false, ttl: 60 },
  { level: LogLevel.Info },
);

// ─── MODELS ──────────────────────────────────────────────────────────

const Tenant = defineModel({
  tableName: "tenants",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    name: { type: DataTypes.STRING, length: 100, required: true },
    slug: { type: DataTypes.STRING, length: 50, required: true, unique: true },
    plan: {
      type: DataTypes.STRING,
      length: 20,
      required: true,
      defaultValue: "free",
    },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    maxUsers: { type: DataTypes.INTEGER, defaultValue: 5 },
    deletedAt: { type: DataTypes.DATETIME, softDelete: true },
  },
  relations: [
    {
      type: RelationType.OneToMany,
      target: () => Member,
      property: "members",
      foreignKey: "tenantId",
    },
    {
      type: RelationType.OneToMany,
      target: () => Project,
      property: "projects",
      foreignKey: "tenantId",
    },
  ],
  scopes: {
    active: (qb) => qb.where("isActive = ?", true),
    byPlan: (qb, plan: string) => qb.where("plan = ?", plan),
  },
});

const User = defineModel({
  tableName: "users",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    email: {
      type: DataTypes.STRING,
      length: 255,
      required: true,
      unique: true,
    },
    name: { type: DataTypes.STRING, length: 100, required: true },
    deletedAt: { type: DataTypes.DATETIME, softDelete: true },
  },
  relations: [
    {
      type: RelationType.OneToMany,
      target: () => Member,
      property: "memberships",
      foreignKey: "userId",
    },
  ],
});

const Member = defineModel({
  tableName: "members",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    tenantId: { type: DataTypes.STRING, required: true },
    userId: { type: DataTypes.STRING, required: true },
    role: {
      type: DataTypes.STRING,
      length: 20,
      defaultValue: "member",
    },
  },
  relations: [
    {
      type: RelationType.ManyToOne,
      target: () => Tenant,
      property: "tenant",
      foreignKey: "tenantId",
    },
    {
      type: RelationType.ManyToOne,
      target: () => User,
      property: "user",
      foreignKey: "userId",
    },
  ],
});

const Project = defineModel({
  tableName: "projects",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    tenantId: { type: DataTypes.STRING, required: true },
    name: { type: DataTypes.STRING, length: 200, required: true },
    description: { type: DataTypes.TEXT },
    status: {
      type: DataTypes.STRING,
      length: 20,
      defaultValue: "active",
    },
    deletedAt: { type: DataTypes.DATETIME, softDelete: true },
  },
  relations: [
    {
      type: RelationType.ManyToOne,
      target: () => Tenant,
      property: "tenant",
      foreignKey: "tenantId",
    },
  ],
  scopes: {
    active: (qb) => qb.where("status = ?", "active"),
    byTenant: (qb, tenantId: string) => qb.where("tenantId = ?", tenantId),
  },
});

// ─── MAIN ────────────────────────────────────────────────────────────

async function main() {
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'free', isActive INTEGER DEFAULT 1, maxUsers INTEGER DEFAULT 5,
    deletedAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    deletedAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY, tenantId TEXT NOT NULL, userId TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, tenantId TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'active', deletedAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  console.log("Tables created.");

  const tenantRepo = orm.getRepository(Tenant);
  const userRepo = orm.getRepository(User);
  const memberRepo = orm.getRepository(Member);
  const projectRepo = orm.getRepository(Project);

  // ─── CREATE TENANTS ─────────────────────────────────────────────

  const acme = await tenantRepo.create({
    id: generateUUID(),
    name: "Acme Corp",
    slug: "acme",
    plan: "pro",
    maxUsers: 50,
  });

  const globex = await tenantRepo.create({
    id: generateUUID(),
    name: "Globex Inc",
    slug: "globex",
    plan: "free",
    maxUsers: 5,
  });

  console.log("Created tenants:", acme.name, globex.name);

  // ─── CREATE USERS & MEMBERS ─────────────────────────────────────

  const user1 = await userRepo.create({
    id: generateUUID(),
    email: "alice@acme.com",
    name: "Alice Johnson",
  });

  const user2 = await userRepo.create({
    id: generateUUID(),
    email: "bob@globex.com",
    name: "Bob Smith",
  });

  await memberRepo.create({
    id: generateUUID(),
    tenantId: acme.id,
    userId: user1.id,
    role: "admin",
  });

  await memberRepo.create({
    id: generateUUID(),
    tenantId: globex.id,
    userId: user2.id,
    role: "member",
  });

  console.log("Created users and memberships");

  // ─── CREATE PROJECTS (tenant-scoped) ────────────────────────────

  const project1 = await projectRepo.create({
    id: generateUUID(),
    tenantId: acme.id,
    name: "Website Redesign",
    description: "Redesign company website",
  });

  const project2 = await projectRepo.create({
    id: generateUUID(),
    tenantId: acme.id,
    name: "Mobile App",
    description: "Build mobile application",
  });

  console.log("Created projects:", project1.name, project2.name);

  // ─── MULTI-TENANT QUERIES ──────────────────────────────────────

  // Get all projects for a tenant
  const acmeProjects = await projectRepo
    .scope("byTenant", acme.id)
    .scope("active")
    .orderBy("createdAt", "DESC")
    .execute(orm.client);
  console.log("Acme projects:", acmeProjects.length);

  // Get tenant with members
  const acmeMembers = await memberRepo
    .find()
    .where("tenantId = ?", acme.id)
    .execute(orm.client);
  console.log("Acme members:", acmeMembers.length);

  // ─── PLAN-BASED QUERIES ────────────────────────────────────────

  const proTenants = await tenantRepo
    .scope("active")
    .scope("byPlan", "pro")
    .execute(orm.client);
  console.log("Pro tenants:", proTenants.length);

  // ─── AGGREGATE ─────────────────────────────────────────────────

  const tenantStats = await tenantRepo.aggregate({
    count: "*",
  });
  console.log("Total tenants:", tenantStats.count_all);

  // ─── CLEANUP ───────────────────────────────────────────────────

  await orm.close();
  console.log("Done.");
}

main().catch(console.error);
