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
  connectionString: "./data/cms.db",
};

const orm = new Stabilize(
  dbConfig,
  { enabled: false, ttl: 60 },
  { level: LogLevel.Info },
);

// ─── MODELS ──────────────────────────────────────────────────────────

const Author = defineModel({
  tableName: "authors",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    name: { type: DataTypes.STRING, length: 100, required: true },
    email: {
      type: DataTypes.STRING,
      length: 255,
      required: true,
      unique: true,
    },
    bio: { type: DataTypes.TEXT },
    avatarUrl: { type: DataTypes.STRING },
    deletedAt: { type: DataTypes.DATETIME, softDelete: true },
  },
  relations: [
    {
      type: RelationType.OneToMany,
      target: () => Article,
      property: "articles",
      foreignKey: "authorId",
    },
  ],
});

const Category = defineModel({
  tableName: "categories",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    name: { type: DataTypes.STRING, length: 100, required: true, unique: true },
    slug: { type: DataTypes.STRING, length: 100, required: true, unique: true },
    description: { type: DataTypes.TEXT },
  },
  relations: [
    {
      type: RelationType.OneToMany,
      target: () => Article,
      property: "articles",
      foreignKey: "categoryId",
    },
  ],
});

const Tag = defineModel({
  tableName: "tags",
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    name: { type: DataTypes.STRING, length: 50, required: true, unique: true },
    slug: { type: DataTypes.STRING, length: 50, required: true, unique: true },
  },
});

const Article = defineModel({
  tableName: "articles",
  versioned: true,
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    title: {
      type: DataTypes.STRING,
      length: 300,
      required: true,
      minLength: 5,
    },
    slug: { type: DataTypes.STRING, length: 300, required: true, unique: true },
    excerpt: { type: DataTypes.TEXT },
    body: { type: DataTypes.TEXT, required: true },
    authorId: { type: DataTypes.STRING, required: true },
    categoryId: { type: DataTypes.STRING, required: true },
    status: {
      type: DataTypes.STRING,
      length: 20,
      required: true,
      defaultValue: "draft",
    },
    publishedAt: { type: DataTypes.DATETIME },
    viewCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    deletedAt: { type: DataTypes.DATETIME, softDelete: true },
    version: { type: DataTypes.INTEGER, optimisticLock: true },
  },
  relations: [
    {
      type: RelationType.ManyToOne,
      target: () => Author,
      property: "author",
      foreignKey: "authorId",
    },
    {
      type: RelationType.ManyToOne,
      target: () => Category,
      property: "category",
      foreignKey: "categoryId",
    },
  ],
  scopes: {
    published: (qb) => qb.where("status = ?", "published"),
    drafts: (qb) => qb.where("status = ?", "draft"),
    popular: (qb) =>
      qb.where("viewCount > ?", 100).orderBy("viewCount", "DESC"),
  },
});

// ─── MAIN ────────────────────────────────────────────────────────────

async function main() {
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS authors (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    bio TEXT, avatarUrl TEXT, deletedAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
    description TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    excerpt TEXT, body TEXT NOT NULL, authorId TEXT NOT NULL, categoryId TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft', publishedAt TEXT, viewCount INTEGER DEFAULT 0,
    deletedAt TEXT, version INTEGER DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS articles_history (
    id TEXT NOT NULL, title TEXT, slug TEXT, excerpt TEXT, body TEXT,
    authorId TEXT, categoryId TEXT, status TEXT, publishedAt TEXT,
    viewCount INTEGER, deletedAt TEXT, version INTEGER,
    operation TEXT, valid_from TEXT, valid_to TEXT, modified_by TEXT, modified_at TEXT
  )`);
  console.log("Tables created.");

  const authorRepo = orm.getRepository(Author);
  const categoryRepo = orm.getRepository(Category);
  const tagRepo = orm.getRepository(Tag);
  const articleRepo = orm.getRepository(Article);

  // ─── SEED DATA ─────────────────────────────────────────────────

  const author = await authorRepo.create({
    id: generateUUID(),
    name: "Lwazi Dlamini",
    email: "lwazicd@icloud.com",
    bio: "Full-stack developer and technical writer",
  });

  const techCategory = await categoryRepo.create({
    id: generateUUID(),
    name: "Technology",
    slug: "technology",
    description: "Tech articles and tutorials",
  });

  const devCategory = await categoryRepo.create({
    id: generateUUID(),
    name: "Development",
    slug: "development",
    description: "Software development guides",
  });

  console.log("Created author and categories");

  // ─── CREATE ARTICLES ───────────────────────────────────────────

  const article1 = await articleRepo.create({
    id: generateUUID(),
    title: "Getting Started with Stabilize ORM",
    slug: "getting-started-stabilize-orm",
    excerpt: "Learn how to use Stabilize ORM in your projects",
    body: "Stabilize ORM is a modern, type-safe ORM for Bun, Node.js, and Deno...",
    authorId: author.id,
    categoryId: techCategory.id,
    status: "published",
    publishedAt: new Date().toISOString(),
    viewCount: 250,
  });

  const article2 = await articleRepo.create({
    id: generateUUID(),
    title: "Building REST APIs with TypeScript",
    slug: "building-rest-apis-typescript",
    excerpt: "A comprehensive guide to building REST APIs",
    body: "REST APIs are the backbone of modern web applications...",
    authorId: author.id,
    categoryId: devCategory.id,
    status: "draft",
  });

  console.log("Created articles:", article1.title, article2.title);

  // ─── CMS QUERIES ──────────────────────────────────────────────

  // Published articles
  const published = await articleRepo
    .scope("published")
    .orderBy("publishedAt", "DESC")
    .limit(10)
    .execute(orm.client);
  console.log("Published articles:", published.length);

  // Popular articles
  const popular = await articleRepo.scope("popular").execute(orm.client);
  console.log("Popular articles:", popular.length);

  // Draft articles
  const drafts = await articleRepo.scope("drafts").execute(orm.client);
  console.log("Draft articles:", drafts.length);

  // Increment view count
  await articleRepo.increment(article1.id, "viewCount", 1);
  console.log("Incremented view count");

  // ─── VERSIONING ───────────────────────────────────────────────

  await articleRepo.update(article1.id, {
    body: "Updated: Stabilize ORM is a modern, type-safe ORM...",
  });

  const history = await articleRepo.history(article1.id);
  console.log("Article versions:", history.length);

  // ─── AGGREGATE STATS ──────────────────────────────────────────

  const stats = await articleRepo.aggregate({
    count: "*",
    sum: ["viewCount"],
    avg: ["viewCount"],
  });
  console.log("Article stats:", stats);

  // ─── CLEANUP ──────────────────────────────────────────────────

  await orm.close();
  console.log("Done.");
}

main().catch(console.error);
