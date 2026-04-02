import {
  Stabilize,
  defineModel,
  DataTypes,
  RelationType,
  DBType,
  type DBConfig,
  type CacheConfig,
  type LoggerConfig,
  LogLevel,
  generateUUID,
} from "../index";

// ─── 1. DATABASE CONFIG ─────────────────────────────────────────────

const dbConfig: DBConfig = {
  type: DBType.SQLite,
  connectionString: "./data/blog.db",
  retryAttempts: 3,
  retryDelay: 500,
};

const cacheConfig: CacheConfig = {
  enabled: false,
  ttl: 60,
};

const loggerConfig: LoggerConfig = {
  level: LogLevel.Debug,
  maxFileSize: 5 * 1024 * 1024,
  maxFiles: 3,
};

// ─── 2. MODELS ───────────────────────────────────────────────────────

const User = defineModel({
  tableName: "users",
  versioned: true,
  timestamps: {
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    email: {
      type: DataTypes.STRING,
      length: 255,
      required: true,
      unique: true,
      pattern: /^[^@]+@[^@]+\.[^@]+$/,
      customValidator: (val: string) =>
        val.includes("@") || "Must be a valid email address",
    },
    name: { type: DataTypes.STRING, length: 100, required: true },
    bio: { type: DataTypes.TEXT },
    avatarUrl: { type: DataTypes.STRING },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    deletedAt: { type: DataTypes.DATETIME, softDelete: true },
    version: { type: DataTypes.INTEGER, optimisticLock: true },
  },
  relations: [
    {
      type: RelationType.OneToMany,
      target: () => Post,
      property: "posts",
      foreignKey: "authorId",
    },
  ],
  scopes: {
    active: (qb) => qb.where("isActive = ?", true),
    admins: (qb) => qb.where("role = ?", "admin"),
  },
});

const Post = defineModel({
  tableName: "posts",
  versioned: true,
  timestamps: {
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    title: {
      type: DataTypes.STRING,
      length: 200,
      required: true,
      minLength: 5,
      maxLength: 200,
    },
    body: { type: DataTypes.TEXT, required: true },
    published: { type: DataTypes.BOOLEAN, defaultValue: false },
    authorId: { type: DataTypes.STRING, required: true },
    deletedAt: { type: DataTypes.DATETIME, softDelete: true },
    version: { type: DataTypes.INTEGER, optimisticLock: true },
  },
  relations: [
    {
      type: RelationType.ManyToOne,
      target: () => User,
      property: "author",
      foreignKey: "authorId",
    },
    {
      type: RelationType.OneToMany,
      target: () => Comment,
      property: "comments",
      foreignKey: "postId",
    },
  ],
  scopes: {
    published: (qb) => qb.where("published = ?", true),
    drafts: (qb) => qb.where("published = ?", false),
  },
});

const Comment = defineModel({
  tableName: "comments",
  timestamps: {
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
  columns: {
    id: { type: DataTypes.STRING, required: true, unique: true },
    body: { type: DataTypes.TEXT, required: true },
    authorId: { type: DataTypes.STRING, required: true },
    postId: { type: DataTypes.STRING, required: true },
  },
  relations: [
    {
      type: RelationType.ManyToOne,
      target: () => Post,
      property: "post",
      foreignKey: "postId",
    },
    {
      type: RelationType.ManyToOne,
      target: () => User,
      property: "author",
      foreignKey: "authorId",
    },
  ],
});

// ─── 3. MAIN ─────────────────────────────────────────────────────────

async function main() {
  const orm = new Stabilize(dbConfig, cacheConfig, loggerConfig);

  orm.events.on("connection:open", (type) => {
    console.log(`Connected to ${type}`);
  });

  // Create tables manually
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    bio TEXT,
    avatarUrl TEXT,
    isActive INTEGER DEFAULT 1,
    deletedAt TEXT,
    version INTEGER DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    published INTEGER DEFAULT 0,
    authorId TEXT NOT NULL,
    deletedAt TEXT,
    version INTEGER DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    authorId TEXT NOT NULL,
    postId TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS users_history (
    id TEXT NOT NULL,
    email TEXT,
    name TEXT,
    bio TEXT,
    avatarUrl TEXT,
    isActive INTEGER,
    deletedAt TEXT,
    version INTEGER,
    operation TEXT,
    valid_from TEXT,
    valid_to TEXT,
    modified_by TEXT,
    modified_at TEXT
  )`);
  await orm.client.migrationQuery(`CREATE TABLE IF NOT EXISTS posts_history (
    id TEXT NOT NULL,
    title TEXT,
    body TEXT,
    published INTEGER,
    authorId TEXT,
    deletedAt TEXT,
    version INTEGER,
    operation TEXT,
    valid_from TEXT,
    valid_to TEXT,
    modified_by TEXT,
    modified_at TEXT
  )`);
  console.log("Tables created.");

  const userRepo = orm.getRepository(User);
  const postRepo = orm.getRepository(Post);
  const commentRepo = orm.getRepository(Comment);

  // ─── CREATE ──────────────────────────────────────────────────────

  const user = await userRepo.create({
    id: generateUUID(),
    email: "lwazicd@icloud.com",
    name: "Lwazi Dlamini",
    bio: "Full-stack developer from Eswatini",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
  });
  console.log("Created user:", user);

  const post = await postRepo.create({
    id: generateUUID(),
    title: "Getting Started with Stabilize ORM",
    body: "Stabilize ORM is a lightweight, type-safe ORM for Bun...",
    published: true,
    authorId: user.id,
  });
  console.log("Created post:", post);

  const comment = await commentRepo.create({
    id: generateUUID(),
    body: "Great post! Very helpful.",
    authorId: user.id,
    postId: post.id,
  });
  console.log("Created comment:", comment);

  // ─── READ ────────────────────────────────────────────────────────

  const foundUser = await userRepo.findOne(user.id);
  console.log("Found user:", foundUser?.name);

  const foundUserByEmail = await userRepo.findOneBy({
    email: "lwazicd@icloud.com",
  });
  console.log("Found by email:", foundUserByEmail?.name);

  // Relations are loaded via separate queries for SQLite compatibility
  const foundPost = await postRepo.findOne(post.id);
  const postAuthor = foundPost
    ? await userRepo.findOne((foundPost as any).authorId)
    : null;
  console.log("Post author:", postAuthor?.name);

  // ─── UPDATE ──────────────────────────────────────────────────────

  const updatedUser = await userRepo.update(user.id, {
    bio: "Senior full-stack developer from Eswatini",
  });
  console.log("Updated bio:", (updatedUser as any).bio);

  // Increment login count
  await userRepo.increment(user.id, "version", 1);
  console.log("Incremented version");

  // ─── QUERY BUILDER ───────────────────────────────────────────────

  const publishedPosts = await postRepo
    .scope("published")
    .orderBy("createdAt", "DESC")
    .limit(10)
    .execute(orm.client);
  console.log("Published posts:", publishedPosts.length);

  // Aggregate
  const stats = await postRepo.aggregate({
    count: "*",
    min: ["title"],
    max: ["title"],
  });
  console.log("Aggregate stats:", stats);

  // Count
  const postCount = await postRepo.count();
  console.log("Total posts:", postCount);

  // Exists
  const userExists = await userRepo.exists({
    email: "lwazicd@icloud.com",
  });
  console.log("User exists:", userExists);

  // ─── PAGINATION ──────────────────────────────────────────────────

  const page = await postRepo.paginate(1, 5);
  console.log(`Page 1: ${page.data.length} of ${page.total} total`);

  // Cursor pagination
  const cursorPage = await postRepo.findMany({
    where: { published: true },
    take: 5,
    orderBy: { field: "createdAt", direction: "DESC" },
  });
  console.log("Cursor page:", cursorPage.length);

  // ─── SOFT DELETE ─────────────────────────────────────────────────

  await postRepo.delete(post.id);
  console.log("Soft-deleted post");

  const activePosts = await postRepo.find().execute(orm.client);
  console.log("Active posts after soft delete:", activePosts.length);

  const deletedPosts = await postRepo.findDeleted().execute(orm.client);
  console.log("Deleted posts:", deletedPosts.length);

  await postRepo.recover(post.id);
  console.log("Recovered post");

  // ─── TRANSACTIONS ────────────────────────────────────────────────

  const txnResult = await orm.transaction(async (txClient) => {
    const newUser = await userRepo.create(
      {
        id: generateUUID(),
        email: "ciniso@icloud.com",
        name: "Ciniso Dlamini",
      },
      {},
    );
    const newPost = await postRepo.create(
      {
        id: generateUUID(),
        title: "Transactional Post",
        body: "Created inside a transaction",
        published: false,
        authorId: newUser.id,
      },
      {},
    );
    return { user: newUser, post: newPost };
  });
  console.log("Transaction result:", txnResult);

  // ─── HEALTH CHECK ────────────────────────────────────────────────

  const health = await orm.healthCheck();
  console.log("Health:", health);

  const userHealth = await userRepo.healthCheck();
  console.log("User table health:", userHealth);

  // ─── CLEANUP ─────────────────────────────────────────────────────

  await orm.close();
  console.log("Connection closed.");
}

main().catch(console.error);
