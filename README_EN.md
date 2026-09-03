# @ycforge/ydb-orm

[![npm (scoped)](https://img.shields.io/npm/v/@ycforge/ydb-orm)](https://www.npmjs.com/package/@ycforge/ydb-orm)
[![NPM](https://img.shields.io/npm/l/@ycforge/ydb-orm)](./LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/ycforge/ydb-orm)](https://github.com/ycforge/ydb-orm/issues)

A TypeORM-like ORM for [YDB (Yandex Database)](https://ydb.tech/) in TypeScript: Active Record, relations, field encryption with blind index, schema sync, transactions, and migrations. **The package core is framework-agnostic** — it works without NestJS; the NestJS integration is extracted into the sub-path package `@ycforge/ydb-orm/nest`.

Principles: convenience, minimalism (in memory and CPU usage), and functionality.

Runtime — Node.js ≥ 22.18 (native `.ts` import via type stripping), ESM (`"type": "module"`, `module: nodenext`). Driver — [`@ydbjs/*`](https://github.com/ydb-platform/ydb-js-sdk) (the new-generation SDK).

## Installation

```bash
# the only package to install (core + the @ycforge/ydb-orm/nest sub-path):
yarn add @ycforge/ydb-orm

# optional, for the NestJS integration — peer dependencies:
yarn add @nestjs/common @nestjs/core reflect-metadata rxjs
```

The sub-path `@ycforge/ydb-orm/nest` is an **import sub-path** of the same package (`import { ... } from '@ycforge/ydb-orm/nest'`); there is no need to install it separately. `@nestjs/*`, `rxjs`, and `reflect-metadata` are optional peerDependencies; without them the core package works at full capacity (standalone, CLI, scripts).

---

## Quick start (standalone, without frameworks)

### 1. Defining an entity

```ts
import {
  YdbBaseEntity, YdbEntity, YdbPrimaryColumn, YdbColumn,
  configureEntities,
  createDriver, createExecutor,
  YdbTransactionManager,
} from '@ycforge/ydb-orm';
import { createAuth, authKeyFromFile } from '@ycforge/auth';

@YdbEntity('users')
class UserEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name!: string;
}
```

### 2. Setting up the executor

```ts
const opts = {
  endpoint: 'grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/...',
  auth: createAuth(authKeyFromFile('./authorized_key.json')),
};

const driver = await createDriver(opts);
const executor = createExecutor(driver, opts);

configureEntities([UserEntity], { executor });
// from this point on, the entity's Active Record methods work
```

`configureEntities` binds the executor and encryption providers to entities directly, without DI.

### 3. Active Record

```ts
// a single record by PK
const user = await UserEntity.find({ uuid: '...' });

// a query with conditions and a limit
const admins = await UserEntity.findAll({ is_admin: true }, { limit: 50 });

// INSERT/UPDATE
const u = new UserEntity();
u.name = 'Ivan';
await UserEntity.save(u);  // uuid is generated automatically (v7)

// transactions
const txManager = new YdbTransactionManager(executor);
await txManager.runInTransaction(async (trx) => {
  await UserEntity.save(user, { trx });
});
```

### Repository (standalone)

In addition to Active Record (`UserEntity.find(...)`), direct access to the repository is available:

```ts
import { getOrCreateRepository } from '@ycforge/ydb-orm';

// the repository is created automatically after configureEntities
const repo = getOrCreateRepository(UserEntity);

const user = await repo.findOneBy({ uuid });
const users = await repo.findAll({ name: 'Ivan' }, { limit: 50 });
const count = await repo.count({ is_admin: true });
await repo.save(entity);
await repo.insertMany([u1, u2]);
await repo.updateBy({ status: 'old' }, { status: 'archived' });
await repo.deleteBy({ status: 'deprecated' });
```

`YdbEntityManager` is a repository factory (handy when you need to work with different entities through a single interface):

```ts
import { YdbEntityManager } from '@ycforge/ydb-orm';

const manager = new YdbEntityManager();
const userRepo = manager.getRepository(UserEntity);
const postRepo = manager.getRepository(PostEntity);

// CRUD through the repository
const user = await userRepo.findOneBy({ uuid });
const users = await userRepo.findAll({ is_admin: true }, { limit: 10 });
await userRepo.save(user);

const posts = await postRepo.findBy({ author_uuid: user.uuid });
await postRepo.insertMany([post1, post2, post3]);
await postRepo.updateBy({ status: 'draft' }, { status: 'published' });
await postRepo.deleteBy({ status: 'archived' });

// QueryBuilder
const popular = await postRepo.query()
  .where({ is_public: true })
  .orderBy('views', 'DESC')
  .limit(20)
  .getMany();

// Transactions — pass { trx } to any method
const txManager = new YdbTransactionManager(executor);
await txManager.runInTransaction(async (trx) => {
  await userRepo.save(user, { trx });
  await postRepo.save(post, { trx });
});
```

`YdbRepository` is the core of the ORM: all the CRUD logic lives in it (and in `YdbEntityPersistence`/`YdbEntityRelations` under the hood). Active Record remains fully functional: the static methods `UserEntity.find(...)` are a thin facade delegating to the same repository. Both styles (Active Record and Repository) can be mixed in a single application.

### Schema sync in standalone mode

```ts
import { YdbSchemaSyncer } from '@ycforge/ydb-orm';

const syncer = new YdbSchemaSyncer(executor);

// verification without changes
const issues = await syncer.verify([UserEntity]);
console.log(issues);

// applying (CREATE TABLE / ALTER TABLE ADD COLUMN)
await syncer.sync([UserEntity]);
```

---

## Quick start (NestJS, optional)

For NestJS applications — the sub-path package `@ycforge/ydb-orm/nest`:

```ts
import { Module } from '@nestjs/common';
import { createAuth, authKeyFromFile } from '@ycforge/auth';
import {
  YdbCoreModule,
  YdbOrmModule,
  YdbBaseEntity,
  YdbEntity,
  YdbPrimaryColumn,
  YdbColumn,
} from '@ycforge/ydb-orm/nest';

@YdbEntity('users')
export class UserEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name!: string;
}

@Module({
  imports: [
    YdbCoreModule.forRootAsync({
      useFactory: () => ({
        endpoint: 'grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/...',
        auth: createAuth(authKeyFromFile('./authorized_key.json')),
        sync: true, // like synchronize in TypeORM — dev only!
      }),
    }),
    YdbOrmModule.forFeature([UserEntity]),
  ],
})
export class AppModule {}
```

`YdbCoreModule.forRootAsync` supports `useFactory` / `useClass` / `useExisting` (as in NestJS). `YdbOrmModule.forFeature([...Entity])` is required for NestJS: without it, the entity's static methods fail with «YDB executor not set».

### Repository (NestJS DI)

In addition to Active Record (`UserEntity.find(...)`), `YdbOrmModule.forFeature` registers an injectable `YdbRepository<Entity>`:

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository, YdbRepository } from '@ycforge/ydb-orm/nest';
import { UserEntity } from './user.entity.js';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: YdbRepository<UserEntity>,
  ) {}

  async getByUuid(uuid: string) {
    return this.userRepo.findOneBy({ uuid });
  }
}
```

`YdbEntityManager`, a repository factory, is also available (`manager.getRepository(UserEntity)`). `YdbRepository` is the core of the ORM: all the CRUD logic lives in it (and in `YdbEntityPersistence`/`YdbEntityRelations` under the hood). Active Record remains fully functional: the static methods `UserEntity.find(...)` etc. are a thin facade delegating to the repository.

---

## Multiple independent configurations in one process (#199)

A single process can serve several independent YDB configurations (different endpoints/authentication/providers/transactions) — for example, the main database and an analytical data warehouse. A configuration is identified by a name (`'default'` by default).

### Entity ownership contract

- **One entity — one active configuration.** An entity class physically cannot belong to two configurations: the executor and providers are stored per class.
- An attempt to register an entity in a different active configuration is a **deterministic error** at bootstrap.
- Re-registration **in the same** configuration (re-bootstrap) is **idempotent**.
- After a configuration is closed (`app.close()` in NestJS, or recreating the scope in standalone), its entities are released and can be reused in another configuration.
- If `configureEntities()` / `forFeature` fails during initialization (validation, executor, runtime error), ownership is **rolled back** — the entity does not remain a «zombie» in a foreign configuration.

### Standalone

```ts
import { createOrmScope, configureEntities, createDriver, createExecutor } from '@ycforge/ydb-orm';
import { createAuth } from '@ycforge/auth';

// The 'default' configuration (as usual)
const defaultExecutor = createExecutor(
  createDriver({ endpoint: 'grpcs://default...', auth: createAuth({ type: 'metadata' }) }),
);
configureEntities([UserEntity], { executor: defaultExecutor });

// A named configuration 'reporting' with its own executor and settings
const reportingScope = createOrmScope('reporting', {
  transactions: { ambient: true, warnOutsideTransaction: true },
});
const reportingExecutor = createExecutor(
  createDriver({ endpoint: 'grpcs://reporting...', auth: createAuth({ type: 'metadata' }) }),
);
configureEntities([ReportEntity], { executor: reportingExecutor, scope: reportingScope });
```

Without a `scope`, entities are bound to the process-level `'default'` scope — the previous behavior.

### NestJS

```ts
import { Module, Inject } from '@nestjs/common';
import {
  YdbCoreModule,
  YdbOrmModule,
  getRepositoryToken,
  InjectRepository,
  getTransactionManagerToken,
  YdbTransactionManager,
  YdbRepository,
} from '@ycforge/ydb-orm/nest';
import { UserEntity } from './user.entity.js';
import { ReportEntity } from './report.entity.js';

@Module({
  imports: [
    // the 'default' configuration
    YdbCoreModule.forRootAsync({
      useFactory: () => ({
        endpoint: 'grpcs://default...',
        auth: createAuth({ type: 'metadata' }),
      }),
    }),

    // the 'reporting' configuration — a separate executor, separate transactions
    YdbCoreModule.forRootAsync({
      name: 'reporting',
      useFactory: () => ({
        endpoint: 'grpcs://reporting...',
        auth: createAuth({ type: 'metadata' }),
        transactions: { ambient: true, warnOutsideTransaction: true },
      }),
    }),

    // Entities are bound to their configuration:
    // forFeature without a name → 'default'; forFeature([...], 'reporting') → 'reporting'
    YdbOrmModule.forFeature([UserEntity]),
    YdbOrmModule.forFeature([ReportEntity], 'reporting'),
  ],
})
export class AppModule {}
```

Injecting the repository and the transaction manager by configuration name:

```ts
@Injectable()
export class ReportService {
  constructor(
    // the repository from the 'reporting' configuration
    @InjectRepository(ReportEntity, 'reporting')
    private readonly reportRepo: YdbRepository<ReportEntity>,
    // the transaction manager from the 'reporting' configuration (a separate instance)
    @Inject(getTransactionManagerToken('reporting'))
    private readonly txManager: YdbTransactionManager,
  ) {}
}
```

For the `'default'` configuration, tokens and names match the historical ones:

```ts
// equivalent to: InjectRepository(UserEntity) and module.get(YdbTransactionManager)
@InjectRepository(UserEntity)           // → getRepositoryToken(UserEntity)
@Inject(YdbTransactionManager)          // → getTransactionManagerToken('default')
```

### Public API for named configurations

| API | Description |
|---|---|
| `YdbModuleAsyncOptions.name` | The configuration name in `YdbCoreModule.forRootAsync()`. `'default'` (by default) is the single configuration; named ones create an isolated set of DI tokens. |
| `YdbOrmModule.forFeature(entities, connectionName?)` | Registers entities into a configuration. `connectionName` defaults to `'default'`. |
| `getRepositoryToken(Entity, connectionName?)` | The repository DI token. For `'default'` — the historical format; for named ones, the token is suffixed with `@<name>`. |
| `@InjectRepository(Entity, connectionName?)` | A decorator for injecting a repository. |
| `getTransactionManagerToken(name)` | The `YdbTransactionManager` DI token. For `'default'` — a class token; for named ones — a symbol. |
| `createOrmScope(name, { transactions })` | Standalone: creates a configuration scope. Passed to `configureEntities(..., { scope })`. |
| `releaseOrmScope(scope)` | Releases all entities of the scope (called automatically by `app.close()` in NestJS). |

### Isolation of transaction settings

The `ambient` and `warnOutsideTransaction` settings are bound to a specific configuration through its scope. Isolation is guaranteed: `ambient: true` in the `'reporting'` configuration does not affect `'default'`, and vice versa.

### Migrating from a single configuration

Existing applications **do not require changes**. If you use a single configuration (`YdbCoreModule.forRootAsync()` without `name`, `YdbOrmModule.forFeature([...])` without `connectionName`), everything works as before — that is exactly the `'default'` configuration.

To add a second configuration:

1. Add a second `YdbCoreModule.forRootAsync({ name: 'name', ... })` with its own `endpoint`/`auth`.
2. Wire up the second configuration's entities via `YdbOrmModule.forFeature([...], 'name')`.
3. For repository and transaction manager injections of the second configuration, use the name: `@InjectRepository(Entity, 'name')`, `getTransactionManagerToken('name')`.

Entities cannot be shared between configurations: if `UserEntity` is needed both in `'default'` and in `'reporting'`, declare a separate entity class for each configuration.

---

## Active Record

```ts
await UserEntity.find({ uuid });                    // a single record or null
await UserEntity.findAll({ name: 'Ivan' }, { limit: 50, offset: 0 });
await UserEntity.count({ name: 'Ivan' });
await UserEntity.save(user);                        // insert (uuid generated, v7 by default) or update by uuid
await UserEntity.insertMany([u1, u2]);              // batches of 100
await user.loadRelations(['roles']);
```

`QueryOptions`: `trx`, `timeout` (ms), `signal` (AbortSignal), `limit` (default 100, max 1000; the semantics are the same as for the builder's `limit()` — see the table below: `0` → empty result, negative/fractional — `Invalid LIMIT` error), `offset`.

## QueryBuilder

A fluent builder on top of Active Record (`src/query/`):

```ts
const photos = await PhotoEntity.query()
  .where({ is_public: true })
  .andWhere({ author_email: 'a@b.c' }) // encrypted + blind index — same as in find
  .orderBy('rating', 'DESC')
  .addOrderBy('title')
  .limit(20)
  .offset(10)
  .getMany();

await PhotoEntity.query().where({ is_public: true }).getOne();   // the first one or null
await PhotoEntity.query().where({ is_public: true }).getCount(); // COUNT(*)
const { sql, values } = await PhotoEntity.query().where({ is_public: true }).toYql(); // without executing
```

The builder is reusable: `getOne()`/`getMany()`/`toYql()` do not mutate its state; the same builder can be executed multiple times (for example, `getOne()`, then `getMany()` with the retained limit).

The explicit `limit()` semantics (no silent clamp into 1..1000):

| call | resulting `LIMIT` |
| --- | --- |
| limit not set | `100` — protective default (constant `DEFAULT_RETRIEVE_LIMIT`) |
| `limit(0)` | `0` — guaranteed empty result |
| `limit(n)`, 1 ≤ n ≤ 1000 | `n` |
| `limit(n)`, n > 1000 | `1000` — protective ceiling (`MAX_RETRIEVE_LIMIT`) |
| `limit(negative / fractional / non-finite)` | `Invalid LIMIT` error |

WHERE supports comparison operators, the logical groups `$or`/`$and`, and JSON operators. Fields in WHERE/ORDER BY are validated against the entity metadata.

### WHERE operators

```ts
await UserEntity.findAll({
  $or: [
    { balance: { $gte: 100 } },
    { is_admin: true },
  ],
  is_banned: false,
});
```

Supported operators:

- `$eq` — equality (`=`), used by default with `{ field: value }`.
- `$ne` — not equal (`!=`), supports `null` (`IS NOT NULL`).
- `$gt`, `$gte`, `$lt`, `$lte` — numeric/string comparisons.
- `$like` — `LIKE` (`Utf8` columns only).
- `$in` — `IN (...)` (the array must be non-empty).
- `$between` — `BETWEEN lo AND hi` (an array of two values).
- `$jsonExists` / `$jsonValue` — for `Json` / `JsonDocument` / `@YdbJson()` columns.

Logical groups:

- `$and: [...]` — joins nested conditions with `AND`.
- `$or: [...]` — joins nested conditions with `OR`.

Groups can be nested inside each other.

### Filtering by related entities (#17)

In WHERE, instead of a column, you can specify a relation property (`@OneToMany` / `@ManyToOne` / `@OneToOne` / `@ManyToMany`) with a conditions object over the columns of the related entity — root rows are filtered by the presence of a matching related row:

```ts
// Users who have a role 'admin' (one-to-many)
await UserEntity.findAll({ userRoles: { is_global: true } });

// Several related predicates + ordinary root conditions (AND)
await PhotoWithTagsEntity.findAll({
  title: { $like: '%sunset%' },
  tags: { name: 'nature' },          // many-to-many through a join table
  author: { status: 'active' },      // many-to-one
});

// Logical groups mix root columns and relations
await UserEntity.findAll({
  $or: [
    { uuid: someUuid },
    { userRoles: { role_uuid: adminRoleUuid } },
  ],
});
```

Supported relation forms and the generated YQL (a semi-join `IN` with a non-correlated subquery — the `EXISTS` semantics; the YQL core does not support correlated subqueries, and such an `IN` does not produce duplicate root rows, so `DISTINCT`/`JOIN` are not needed):

| relation | condition |
| --- | --- |
| one-to-many | `root.pk IN (SELECT child.fk FROM target WHERE pred)` |
| many-to-one / one-to-one | `root.fk IN (SELECT target.pk FROM target WHERE pred)` |
| many-to-many | `root.pk IN (SELECT jt.owner FROM jt WHERE jt.inverse IN (SELECT target.pk FROM target WHERE pred))` |

An empty predicate `{ tags: {} }` means «there is at least one related row». Relations can be nested (`{ linkedUser: { roles: { role: 'admin' } } }`).

Constraints and guarantees:

- **Only unencrypted columns**: `@YdbEncrypted` fields of the related entity (including their `{field}_bi`) are forbidden in related filters — an attempted use fails with a clear error.
- Path validation against metadata: an unknown relation/column, an undeclared join column, incompatible join-column types, a composite PK on the join side (for one-to-many — on the root; for many-to-one/one-to-one — on the target), or a missing `@JoinTable` for many-to-many are rejected with an error **before the SQL is executed**.
- All values are bound as query parameters; literals never end up in the SQL.
- Works in all the methods sharing the WHERE pipeline: `find`/`findOneBy`, `findAll`/`findBy`, `count`, `updateBy`, `deleteBy`, and in the QueryBuilder (`where`/`andWhere`/`orWhere`); `{ trx }`/ambient transactions and limits are preserved.

## Decorators

- `@YdbEntity('table')` — the table name; the class goes into the global entity registry (used by schema sync).
- `@YdbColumn('Uuid' | 'Utf8' | 'Bytes' | 'Int32' | 'Int64' | 'Bool' | 'Double' | 'Float' | 'Date' | 'Datetime' | 'Timestamp' | 'Json' | 'JsonDocument')` — a column. Date types accept `Date`, a number (ms since the epoch), or an ISO string; **`Timestamp` precision is limited to milliseconds**: a JS `Date` stores only ms, so sub-millisecond values (micro-/nanoseconds) are not persisted — on read, the low-order YDB microseconds are lost.
- `@YdbPrimaryColumn(type)` — a primary key column (composite PK is supported: several such columns). **A PK is required**: an entity without `@YdbPrimaryColumn` cannot be initialized — `validateEntityMetadata` (at module startup), schema sync, and runtime operations throw the error `must declare at least one primary key via @YdbPrimaryColumn`. There is no «default `uuid` PK». If a column named `uuid` of type `Uuid` is declared among the PK columns, its value is generated automatically on insert (UUID v7 by default, configurable via the `uuidVersion` option).
- `@YdbEncrypted({ blindIndex, lazy })` — the field is encrypted before write and decrypted after read; `blindIndex: true` (by default) adds a synthetic `{field}_bi` column for hash-based lookup. The ciphertext is stored in a `Bytes` column (raw bytes); for such fields, the type from `@YdbColumn` is ignored. With `lazy: true` decryption is deferred: the field is not decrypted on SELECT (CPU savings), the plaintext is returned by `await entity.decryptField('field')` / `await entity.decryptLazyFields()` (the result is cached on the instance); `toJSON()`/`JSON.stringify()` throw an error while lazy fields are not decrypted.
- `@YdbSecurityAAD()` — an unencrypted field participates in AAD (can only be applied to PK columns).
- `@YdbJson()` — the field is stored as a JSON string in `Utf8`; the ORM serializes/parses values automatically. Native `Json`/`JsonDocument` are available via `@YdbColumn('Json')` / `@YdbColumn('JsonDocument')`.
- `@OneToMany` / `@ManyToOne` / `@OneToOne` / `@ManyToMany` — relations; `@EagerLoad([...])` — batch loading with a single `IN (...)` query (without N+1). `@ManyToMany` requires `@JoinTable('join_table_name')` on the owning side; the join table gets into schema sync and migrations automatically.
- `@YdbIndex({ columns, name? })` — a secondary index (GLOBAL SYNC); a class decorator, can be used multiple times. The default name is `{table}__{col1}_{col2}`. It gets into CREATE TABLE during schema sync and into `migration:generate` for new tables.
- `@YdbEnum({ values, storage? })` — an enum column. `storage: 'Utf8'` (by default) stores the string value of the enum; `storage: 'Int32'` stores the ordinal number of the value in `values`. Attached to a property together with `@YdbColumn` of the corresponding type (`Utf8` or `Int32`).
- `@YdbCreateDateColumn()` / `@YdbUpdateDateColumn()` — a column automatically filled with `new Date()`: `@YdbCreateDateColumn` — on insert (when the value is `undefined` → if set explicitly, it is not overwritten); `@YdbUpdateDateColumn` — on insert and on update: `save()` of an existing record always overwrites the field, `updateBy` and `insertMany` fill it only if the value is not set. Declared on a property together with `@YdbColumn('Timestamp')`.
- `@YdbTtl({ interval, column, unit? })` — declarative table TTL (a class decorator, once per class). `interval` — an ISO 8601 duration (`"PT2H"`, `"P30D"`); `column` — a required column declared via `@YdbColumn` (types `Date`/`Datetime`/`Timestamp` without `unit`, or numeric `Uint32`/`Uint64`/`DyNumber` — then `unit` is required); `unit` — a unit for a numeric column (`seconds` | `milliseconds` | `microseconds` | `nanoseconds`). Generates the clause `WITH (TTL = Interval(...) ON column)` in CREATE TABLE. Format errors are thrown right at decoration time; incompatibility with the entity schema — at module initialization.
- `@BeforeInsert` / `@AfterInsert` / `@BeforeUpdate` / `@AfterFind` / `@BeforeRemove` — lifecycle hooks (method decorators without parentheses). Details and call guarantees are in the [Lifecycle hooks](#lifecycle-hooks) section.

### Metadata inheritance

Decorator inheritance rules between a parent and a child class (#92):

- **`@YdbEntity` is not inherited.** Only the class directly decorated with `@YdbEntity` is an entity. A subclass without its own `@YdbEntity` is not an entity: it does not inherit the parent's tableName, does not get into the registry or into the expected schemas of schema sync/migrations, and Active Record calls on it fail with a clear error «is not decorated with @YdbEntity». Such a class must not be passed to `forFeature`/`configureEntities`/entity lists.
- **Columns are inherited** (`@YdbColumn`, `@YdbPrimaryColumn`, `@YdbEncrypted`, `@YdbSecurityAAD`, `@YdbJson`, `@YdbEnum`, timestamp decorators, lifecycle hooks): a child class gets the union of the ancestors' metadata; overriding on the child does not change the parent (copy-on-write). Duplicates and overrides: `@YdbEnum` — last-write-wins, AAD/PK — deduplicated by field name.
- **`@YdbIndex` and `@YdbTtl` are not inherited** — they are bound to the physical table of the class. A class with its own `@YdbEntity` starts without indexes and TTL and declares its own explicitly; this guarantees that the parent's indexes/TTL (possibly over foreign or overridden columns) never get into the child table's DDL.
- **`@EagerLoad` is inherited by union**: the parent's relations are preserved, the child's list extends them without duplicates (the first declaration wins).
- **A duplicate tableName across two different entities** (for example, a parent and a child decorated with the same name) — the error `Duplicate table name "..."` when building the schema (`buildExpectedSchemas`): sync/verify/`migration:generate` always work with exactly one expected schema per table.

```ts
@YdbEntity('events')
@YdbTtl({ interval: 'P30D', column: 'created_at' })
class EventEntity extends YdbBaseEntity { /* ... */ }

// Its own table: the parent's columns are inherited, TTL/indexes — not
@YdbEntity('audit_events')
class AuditEventEntity extends EventEntity { /* ... */ }

// Error: Duplicate table name "events"
@YdbEntity('events')
class BrokenChildEntity extends EventEntity { /* ... */ }
```

```ts
@YdbEntity('photos')
@EagerLoad(['tags'])
class Photo extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid') uuid: string;
  @YdbColumn('Utf8') title: string;

  @ManyToMany(() => Tag, (tag) => tag.photos)
  @JoinTable('photo_tag')
  tags: Tag[];
}

@YdbEntity('tags')
class Tag extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid') uuid: string;
  @YdbColumn('Utf8') name: string;

  @ManyToMany(() => Photo, (photo) => photo.tags)
  photos: Photo[];
}
```

## Lifecycle hooks

The decorators `@BeforeInsert`, `@AfterInsert`, `@BeforeUpdate`, `@AfterFind`, `@BeforeRemove` attach hooks to entity methods. The call semantics are uniform across all read and write paths:

| Hook | When it is called |
| --- | --- |
| `@BeforeInsert` | `save()` of a new entity; each element of `insertMany()` — before validation, encryption, and parameter building; field mutations get into the DB |
| `@AfterInsert` | after a successful write (`insert()`, each element of `insertMany()`) |
| `@BeforeUpdate` | `save()` of an existing entity (by PK) |
| `@AfterFind` | all read paths: `find()`/`findOneBy()`, `findAll()`/`findBy()`, `query().getMany()`/`getOne()`, as well as internal fetches — eager-loading of relations and `loadRelations()` (batch `IN (...)`) and the instance loading inside `delete()` |
| `@BeforeRemove` | only `delete()`; the entity is first loaded via `find()` |

Guarantees:

- `@AfterFind` is called **exactly once** for each instance within a read operation and **is not called on an empty result**.
- Order: hooks of related entities fire before the hooks of root ones; `@AfterFind` of the root entity sees already-attached relations.
- Eager depth does not change: relations are loaded only for the entities of the query (one level). Related entities get their own `@AfterFind`, but their own eager relations are loaded only by an explicit `loadRelations()`/a separate query — this rules out infinite recursion on cyclic/self-referencing relations.
- `updateBy()` and `deleteBy()` are bulk operations: per-entity hooks for the affected rows are not called. If you need per-row business logic, use `save()`/`delete()` or run it explicitly before the bulk call.
- `count()`, `updateBy()`, `deleteBy()` do not load entities, so they have no read/delete hooks.

```ts
@YdbEntity('users')
class User extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid') uuid: string;
  @YdbColumn('Utf8') name?: string;

  @BeforeInsert
  normalize() {
    this.name = this.name?.trim();
  }

  @AfterFind
  touch() {
    // called for both root entities and eager/lazy relations
  }
}
```

## Encryption

Providers are passed in the module options / standalone config:

```ts
{
  encryptionProvider: myEncryptionProvider,   // { encrypt(value, aad, ctx) → Uint8Array, decrypt(ciphertext, aad, ctx) → string }
  blindIndexProvider: myBlindIndexProvider,   // { hash(value, ctx) → string }
}
```

`encrypt` returns the raw ciphertext (`Uint8Array`), which the ORM writes into the `Bytes` column (without base64 encoding — ~33% savings compared to `Utf8`). `decrypt` accepts a `Uint8Array` from the `Bytes` column. The blind index (`{field}_bi`) is an ordinary `Utf8` column.

The test stub `TestOnlyEncryptionProvider` (no real cryptography, with a loud WARNING when used) is extracted into a separate dev package [`@ycforge/js-dev-tools`](https://github.com/ycforge/js-dev-tools) — connect it only in tests via `devDependencies`. Ready production providers (AES-256-GCM, HMAC-SHA256, KMS) are in the `@ycforge/orm-security-providers` package.

For `updateBy()` on an encrypted field, the ORM assembles AAD from the values of the AAD fields fixed in `where` (for example, by PK). If the AAD cannot be unambiguously determined from the predicate, the ORM throws an error — for an explicit override, `aadOverride` can be used in `@YdbEncrypted({ aadOverride: '...' })`.

## JSON columns

Three variants are supported:

- `@YdbColumn('Json')` — native YDB `Json`.
- `@YdbColumn('JsonDocument')` — native YDB `JsonDocument`.
- `@YdbJson()` — a JSON object stored as a string in `Utf8` (the ORM itself does `JSON.stringify`/`JSON.parse`).

```ts
@YdbEntity('events')
class EventEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid') uuid: string;

  @YdbJson()
  @YdbColumn('Utf8')
  metadata: Record<string, any>;

  @YdbColumn('Json')
  payload: any;
}
```

For JSON columns, operators are available in `query()`/QueryBuilder:

```ts
await EventEntity.query()
  .andWhereJsonExists('metadata', '$.settings.theme')
  .andWhereJsonValue('metadata', '$.role', 'admin')
  .getMany();
```

Multiple JSON predicates on one column do not overwrite each other, but are combined with `AND` (#201):

```ts
// metadata: $.settings.theme exists AND $.role = 'admin'
await EventEntity.query()
  .andWhereJsonExists('metadata', '$.settings.theme')
  .andWhereJsonValue('metadata', '$.role', 'admin')
  .getMany();
// WHERE (JSON_EXISTS(`metadata`, $metadata_0_jsonexists)
//    AND JSON_VALUE(`metadata`, $metadata_1_jsonvalue_path) = $metadata_1_jsonvalue_val)
```

## Schema sync

### Standalone

```ts
import { YdbSchemaSyncer } from '@ycforge/ydb-orm';

const syncer = new YdbSchemaSyncer(executor);

// verify — checks the schema, changes nothing
const issues = await syncer.verify([UserEntity, PostEntity]);

// sync — aligns the schema
await syncer.sync([UserEntity, PostEntity]);
```

- no table → `CREATE TABLE`;
- missing columns → `ALTER TABLE ADD COLUMN`;
- extra columns → only a warn in the log (data is not deleted);
- column type or PK mismatch → an error (not changed in YDB, a migration is needed).

### NestJS

In a NestJS application, schema sync runs automatically in `onApplicationBootstrap`:

```ts
YdbCoreModule.forRootAsync({
  useFactory: () => ({
    endpoint: '...',
    auth: createAuth(authKeyFromFile('./authorized_key.json')),
    sync: true, // dev only! In production — migrations.
  }),
});
```

The `YDB_SCHEMA_SYNC` provider is exported from `YdbCoreModule` (the `nest` sub-path): `syncer.verify(entities)` checks the schema without changes. DDL generators (`generateCreateTableYql` etc.) are available in the public API — they can be used for migrations.

#### Module lifecycle (#93)

- **Schema sync runs in `onApplicationBootstrap`**, not in a DI factory: by that time all entities of all modules are registered, the initialization order is deterministic, and a DDL error comes from `app.init()` as the original schema error. For tests this means: sync fires after `module.init()` / `app.init()`, not after `compile()`.
- **Protection against double `forRootAsync`**: re-initializing the core in one process while the previous application has not been closed (`app.close()`) fails with a clear error `Duplicate YDB module initialization`. Sequential bootstraps (tests, hot-restart) are allowed.
- **Entity registry isolation**: each `YdbCoreModule` instance (each Nest application) has its own entity scope — it is created on the static side of `forRootAsync` and is available to providers via the DI token `YDB_CORE_SCOPE`. When creating providers, `YdbOrmModule.forFeature([...])` binds the declared entities to the scope OF ITS OWN application: the `@YdbEntity` decorator runs once per process life (module cache), so forFeature itself restores visibility on a re-bootstrap. The provider resolution order does not matter — an application that failed with `Duplicate YDB module initialization` cannot pollute entities into a live one (#142). After `app.close()`, the application's set goes away with its state; the CLI/standalone sees the whole global registry.
- **Graceful shutdown**: the driver created by the module is closed in `onApplicationShutdown` (enable `app.enableShutdownHooks()`). Drivers passed in from outside via `overrideProvider` are not closed. The `driverFactory` option allows plugging in your own driver factory — such a driver is considered owned by the module and is also closed.

## Transactions

### Standalone

```ts
import { YdbTransactionManager, createExecutor, createDriver } from '@ycforge/ydb-orm';
import { createAuth } from '@ycforge/auth';

const driver = createDriver({
  endpoint: '...',
  auth: createAuth({ type: 'anonymous' }),
});
const executor = createExecutor(driver);
const txManager = new YdbTransactionManager(executor);

await txManager.runInTransaction(async (trx) => {
  const user = await UserEntity.find({ uuid: userId }, { trx });
  await UserEntity.save(user, { trx });
});
```

### NestJS

In NestJS, `YdbTransactionManager` is injected from DI (provided automatically by `YdbCoreModule`):

```ts
@Injectable()
export class OrderService {
  constructor(private readonly txManager: YdbTransactionManager) {}

  async transfer(fromId: string, toId: string) {
    await this.txManager.runInTransaction(async (trx) => {
      const from = await UserEntity.find({ uuid: fromId }, { trx });
      await UserEntity.save(from, { trx });
    });
  }
}
```

### Execution options (#98)

`runInTransaction(fn, options)` accepts options that are forwarded to the SDK transaction call (`client.transaction(options, ...)`):

```ts
await txManager.runInTransaction(
  async (trx, signal) => {
    await OrderEntity.save(order, { trx });
  },
  {
    isolation: 'snapshotReadWrite',   // serializableReadWrite (by default) | snapshotReadOnly | snapshotReadWrite
    timeout: 5_000,                    // timeout PER ATTEMPT (see below)
    signal: controller.signal,         // GLOBAL cancellation: the whole operation, all attempts
    idempotent: true,                  // see «Retry semantics» below
  },
);
```

**Cancellation semantics with `idempotent: true`** — `signal` and `timeout` have different scopes:

- `signal` — **global**: forwarded to the SDK as is and cancels the whole operation, including all retry attempts;
- `timeout` — **per attempt**: the SDK can re-run the callback (`idempotent: true`), and each attempt gets a fresh timeout window — a retry never starts with the already-expired deadline of the first attempt. The signal the callback receives (`fn(trx, signal)`) combines the attempt signal from the SDK and `AbortSignal.timeout(timeout)` of that attempt.

A full deadline for the whole operation is set explicitly via a user signal:

```ts
await txManager.runInTransaction(fn, {
  idempotent: true,
  signal: AbortSignal.timeout(30_000), // a common limit for all attempts
});
```

Options are validated fail-fast: an unknown key (a typo), an invalid isolation level, a non-positive `timeout`, a non-`AbortSignal` — an error immediately.

### Nested transactions

A nested `runInTransaction()` is **forbidden** by default: a second call will open an independent transaction on another session, which is almost always a mistake. To join the active transaction (commit/rollback stays with the outer call), pass `{ reuse: true }`:

```ts
await txManager.runInTransaction(async () => {
  await txManager.runInTransaction(async (trx2) => {
    // Error: Nested runInTransaction() detected ...
  });
});

await txManager.runInTransaction(async () => {
  await txManager.runInTransaction(async (sameTrx) => {
    // the same transaction as the outer one
  }, { reuse: true });
});
```

Nesting is detected via the AsyncLocalStorage chain and only for the same DB executor; nested transactions on another driver/database are considered independent.

### Ambient context (opt-in)

One missed `{ trx }` — and the query silently runs outside the transaction. Ambient mode solves this: repository operations without an explicit `{ trx }` automatically execute in the active transaction.

```ts
// NestJS: globally at module initialization
YdbCoreModule.forRootAsync({
  useFactory: () => ({
    // ...
    transactions: { ambient: true },
  }),
});

// Standalone: via module options (YdbModuleOptions)
// or pointwise, for a single call:
await txManager.runInTransaction(async () => {
  await OrderEntity.save(order);          // will join the transaction automatically
  await OrderEntity.save(other, { trx }); // an explicit trx also works
}, { ambient: true });
```

Safety rules:

- if a **different** `{ trx }` is explicitly passed while an ambient transaction is active — a mixing error, not a silent data inconsistency;
- the context is cleared after commit/rollback;
- parallel transactions do not leak into each other;
- ambient is off by default: an explicit `{ trx }` works as before.

### Queries outside a transaction

For debugging, you can enable a warning about every query that runs outside any transaction:

```ts
transactions: { warnOutsideTransaction: true } // a warning for every such query
```

Off by default — warnings do not add noise.

Warnings are routed through the same logger as queries (#206): they go to the logger configured via `logQueries`, through the optional hook `QueryLogger.warn(message)`. Without a custom logger, the established fallback `ConsoleQueryLogger` is used (output to `console.warn`) — the behavior does not change. If your own logger wants to see transaction warnings, add a `warn`:

```ts
const myLogger: QueryLogger = {
  log(entry) {
    // SQL, paramNames, maskedParams, durationMs, error
  },
  warn(message) {
    // '[ydb-orm] UserEntity: query executed outside any transaction ...'
  },
};
```

The logger is scoped by configuration: each configuration (#199) passes its own logger to its executors, so a warning of one configuration does not get into the logger of another. The utilities `getExecutorLogger(executor)` / `resolveExecutorLogger(executor)` pull the logger out of a (wrapped) executor — the second one returns a console fallback if logging is not configured.

### Retry semantics (important!)

The SDK (`@ydbjs/query`) re-runs **the entire transaction callback** on retryable errors (network failure, session death) with `idempotent: true`. This means:

- the callback's side effects are executed again;
- lifecycle hooks (`@BeforeInsert`, `@AfterInsert`, ...) fire more than once;
- each attempt gets a new session/transaction (a new `trx`).

The callback must be resilient to a replay. Without `idempotent: true` there are no replays. A configurable ORM policy with an attempt limit — the `retry` option: see «Retry policy by error type (#27)» below.

### Retry policy by error type (#27)

The SDK (`@ydbjs/query`) retries single queries and the transaction body **inside itself** (unlimited budget by default, not configurable). The ORM plugs in its own policy with **wrappers** on the executor and transactions so that the retry layers do not multiply. The layer priority is deterministic:

| Configuration | Who retries | Attempts |
|---|---|---|
| Policy off (by default) | only the SDK (as in #98) | unchanged |
| `retry` on executor / `YdbModuleOptions` | the ORM policy for EXPLICITLY marked idempotent queries; the SDK inner loop is suppressed via the query's `retry` event | exactly `maxAttempts` accesses to the DB |
| `retry` in `runInTransaction()` | the ORM policy: one attempt of the body per policy attempt (the SDK inner loop is suppressed with a protective limit) | exactly `maxAttempts` executions of the callback |

#### Idempotency rule (#27, fail-safe)

The policy retries **only explicitly marked idempotent** queries:

```ts
// ❌ Not marked (INSERT/UPSERT/UPDATE/DELETE by default):
// will run EXACTLY ONCE even with retry: true.
await UserEntity.save(user);

// ❌ A transient error on an unfamiliar record → a retry is unsafe:
await OrderEntity.findBy({ status: 'new' }); // also once

// ✅ Marked idempotent: the policy may retry on
// ABORTED / UNAVAILABLE / OVERLOADED.
const users = await UserEntity.findAll({}, { idempotent: true });
await UserEntity.save(user, { idempotent: true }); // the operation is replay-safe
await executor`SELECT ...`.idempotent(true);       // direct executor
```

Why: after an ambiguous transport failure (`UNAVAILABLE` etc.) it is impossible to know whether the record was applied on the server. Retrying an unfamiliar record can duplicate side effects, so by default any unmarked query runs exactly once (its SDK inner loop is also suppressed). Mark only operations that are replay-safe with `{ idempotent: true }`. The mark is forwarded to the SDK as `.idempotent(true)`.

Transactions are a separate contract: the `retry` option in `runInTransaction()` governs the body as a whole and requires CALLBACK idempotency (#98); marks of individual queries inside the body do not affect it (the SDK ignores them there).

#### Attaching to the executor

```ts
import { createAuth } from '@ycforge/auth';
import { createExecutor, createDriver } from '@ycforge/ydb-orm';

const driver = createDriver({ endpoint: '...', auth: createAuth({ type: 'anonymous' }) });

// standalone:
const executor = createExecutor(driver, { retry: { maxAttempts: 5 } });

// Manually on top of a ready executor (wrap ONCE):
import { withRetryPolicy } from '@ycforge/ydb-orm';
const resilient = withRetryPolicy(executor, { maxAttempts: 5 });
```

NestJS:

```ts
YdbCoreModule.forRootAsync({
  useFactory: () => ({
    endpoint: '...',
    auth: createAuth({ type: 'anonymous' }),
    retry: true, // or a YdbRetryPolicyOptions object; false/undefined — off
  }),
});
```

#### Attaching to transactions

```ts
await txManager.runInTransaction(
  async (trx) => {
    await OrderEntity.save(order, { trx });
  },
  {
    idempotent: true,   // #98 semantics: the callback must be replay-safe
    retry: true,        // or a policy object; cannot be combined with reuse
    maxAttempts: 5,
  },
);
```

With a policy set, the ORM owns the body retries: bounded backoff with jitter between attempts, only transient statuses are retried, `timeout` still applies per attempt (a fresh window), the global `signal` and `idempotent` are forwarded to the SDK as before. Without the `retry` option, the behavior is the previous one (#98): only the SDK retries the body.

#### Error classification

Structural — by YDB status codes (`@ydbjs/error`), the message text is not analyzed:

- **only** `ABORTED`, `UNAVAILABLE`, `OVERLOADED` are retried (and a `CommitError` whose cause carries such a status);
- everything else is thrown immediately: deterministic application/validation/schema errors, including the statuses the SDK retries itself (`BAD_SESSION`, `SESSION_BUSY`, `SESSION_EXPIRED`, `UNDETERMINED`, `TIMEOUT`);
- on attempt exhaustion, the **last original error** surfaces as is.

**Delay** before attempt N: `min(baseDelayMs * 2^(N-1), maxDelayMs)`, then jitter compresses it into the corridor `[(1 - jitterRatio) * raw, raw]`. Defaults: `maxAttempts: 3`, `baseDelayMs: 100`, `maxDelayMs: 5000`, `jitterRatio: 0.25`. For tests, `sleep(ms, signal)` and `rng()` are injected.

**Idempotency requirements** — the same as for `idempotent` transactions (#98): on a retry the whole operation (callback/query) re-executes, side effects and lifecycle hooks may fire more than once. Cancellation (`signal.reason`) is not turned into a retry — the operation finishes with the cancellation reason. For queries through the executor, the idempotency rule above applies: without an explicit mark, a query is not retried at all.

For composite flows outside a transaction, an explicit wrapper is also available:

```ts
import { runWithRetry } from '@ycforge/ydb-orm';

const result = await runWithRetry(async () => {
  const user = await UserEntity.find({ uuid }, {});
  const orders = await OrderEntity.findBy({ userId: user.uuid }, { limit: 50 });
  return buildReport(user, orders);
}, { maxAttempts: 5 });
```

Do not nest `runWithRetry()` inside an already policy-covered executor/`runInTransaction()` — this is exactly the layer multiplication that the built-in integrations rule out. The extension point for non-standard error wrappers is `shouldRetry(error)`; the utilities `classifyYdbError()` / `isTransientYdbError()` are available separately.

## Query logging

### Standalone

```ts
import { createExecutor, createDriver, ConsoleQueryLogger } from '@ycforge/ydb-orm';
import { createAuth, authKeyFromFile } from '@ycforge/auth';

const driver = createDriver({
  endpoint: '...',
  auth: createAuth(authKeyFromFile('./authorized_key.json')),
});

const executor = createExecutor(driver, {
  logQueries: true, // ConsoleQueryLogger by default
});
```

### NestJS

```ts
YdbCoreModule.forRootAsync({
  useFactory: () => ({
    endpoint: '...',
    auth: createAuth(authKeyFromFile('./authorized_key.json')),
    logQueries: true,
    // logQueries: myLogger, // or your own QueryLogger instance
  }),
});
```

- `logQueries: true` — uses `ConsoleQueryLogger` (output `[YDB] QUERY <ms>` with SQL and masked parameters).
- `logQueries: <QueryLogger>` — a custom logger: the interface `QueryLogger { log(entry: QueryLogEntry): void; warn?(message: string): void }`. `QueryLogEntry` contains `sql`, `paramNames`, `maskedParams`, `durationMs`, and an optional `error`. The optional `warn` receives ORM warnings (see `warnOutsideTransaction`).
- The utility `wrapExecutorWithLogging(executor, logger, options?)` allows wrapping an executor with logging manually — it also logs every query inside `runInTransaction`.
- **Parameter values are hidden by default (#168)**: raw values do not get into the logs at all — only the type and a coarse size class (`<string:1-31>`, `<json:512-2047>`, `<bytes:128-511>`). The exact length is hidden (so values cannot be distinguished from logs). This is an intentional behavior change: previously only a finite denylist of names was masked (`password`, `token`, `email`, ...), and values with arbitrary names (`salary`, `medical_record`, blind-index hashes outside the denylist) leaked into the log.
- **Binary values are always masked, even with an explicit opt-in**: ciphertext of encrypted columns is logged only as `<bytes:<size class>>`.
- **Optional raw disclosure** — `logParamValues` in `YdbModuleOptions` (standalone and NestJS) or `options.values` of `wrapExecutorWithLogging`:
  - `true` — all values (except binary);
  - `string[]` — only the listed parameter names;
  - `RegExp` — only names matching the pattern;
  - `(name) => boolean` — an application predicate.
  On opt-in, long strings are truncated to 64 characters. Blind-index hashes are ordinary strings: masked by default, disclosed only with an explicit opt-in on their name.

## Authentication

Authentication is delegated to the [`@ycforge/auth`](https://github.com/ycforge/auth) package: `ydb-orm` no longer implements its own strategies and does not parse env variables like `YDB_AUTH_TYPE`. All sign-in methods are described through the `AuthManager`, which is passed to the `auth` option:

```ts
import { createAuth, authKeyFromFile } from '@ycforge/auth';

// service account authorized key
const auth = createAuth(authKeyFromFile('./authorized_key.json'));

// or other strategies:
const auth = createAuth({ type: 'metadata' });
const auth = createAuth({ type: 'anonymous' });
const auth = createAuth({ type: 'iam_token', token: process.env.IAM_TOKEN! });
const auth = createAuth({ type: 'static', username: 'user', password: 'pass' });
```

Standalone:

```ts
const driver = createDriver({
  endpoint: process.env.YDB_ENDPOINT!,
  auth,
});
```

NestJS:

```ts
YdbCoreModule.forRootAsync({
  useFactory: () => ({
    endpoint: process.env.YDB_ENDPOINT!,
    auth,
  }),
});
```

`AuthManager` is adapted into a `CredentialsProvider` via `createYdbCredentialsProvider(auth, YDB_AUTH_USAGE, options)` from `@ycforge/auth/ydb` (the ORM does this automatically). For the `static` strategy, the adapter needs the module's `endpoint`.

### Together with `@ycforge/auth/nestjs`

If your project already uses `@ycforge/auth/nestjs`, you can create an `AuthManager` in DI and pass it to the ORM (NestJS):

```ts
import { Module } from '@nestjs/common';
import { YcAuthModule, InjectAuth } from '@ycforge/auth/nestjs';
import { YdbCoreModule } from '@ycforge/ydb-orm/nest';

@Module({
  imports: [
    YcAuthModule.forRoot({
      config: authKeyFromFile('./authorized_key.json'),
      global: true,
    }),
    YdbCoreModule.forRootAsync({
      useFactory: (@InjectAuth() auth) => ({
        endpoint: process.env.YDB_ENDPOINT!,
        auth,
      }),
      inject: [YcAuthModule], // or the YCFORGE_AUTH token
    }),
  ],
})
export class AppModule {}
```

### Custom CredentialsProvider

A ready-made provider can be passed directly — the `credentialsProvider` option (type `CredentialsProvider` from `@ydbjs/auth`, re-exported from the package):

```ts
import { CredentialsProvider } from '@ycforge/ydb-orm';
import { createDriver } from '@ycforge/ydb-orm';

class OAuthTokenProvider extends CredentialsProvider {
  getToken(): Promise<string> {
    return fetchOAuthToken(); // your token-fetching implementation
  }
}

// standalone
const driver = createDriver({
  endpoint: process.env.YDB_ENDPOINT!,
  credentialsProvider: new OAuthTokenProvider(),
});
```

NestJS:

```ts
YdbCoreModule.forRootAsync({
  useFactory: () => ({
    endpoint: process.env.YDB_ENDPOINT!,
    credentialsProvider: new OAuthTokenProvider(),
  }),
});
```

The provider is also available for injection via the DI token `YDB_CREDENTIALS_PROVIDER` (exported from the `nest` sub-path). The priority of provider sources is deterministic:

1. `credentialsProvider` — an explicit module option;
2. `auth` — the `AuthManager` from `@ycforge/auth`;
3. the DI provider `YDB_CREDENTIALS_PROVIDER`;
4. `driverOptions.credentialsProvider`.

Setting both `driverOptions.credentialsProvider` and a top-level source (`credentialsProvider` or `auth`) at the same time is a configuration error (`Conflicting YDB credentials configuration`): a silent choice of one of them is not made. If neither `auth`, nor `credentialsProvider`, nor an injected provider is set — `ydb-orm` throws `YDB auth is required: pass "auth" (AuthManager) or a CredentialsProvider`.

---

## Migrations

By analogy with TypeORM: a migration is a class with `up`/`down` that receives a `YdbExecutor`. Applied migrations are stored in the `ydb_migrations` table (created automatically). Migration files are `<timestamp>-<Name>.ts` in the `./migrations` directory; the execution order is by file name. Node ≥ 22.18 imports `.ts` directly; no separate ts-node is needed. Because of native type stripping, import the types (`YdbMigration`, `YdbExecutor`) via `import type` — a regular named type import will fail at runtime.

Execution reliability (#101):

- **Stable identity**: each migration gets a SHA-256 of the file contents (`migration.hash`). Matching against `ydb_migrations` is by hash, so renaming a file does not cause a re-application; changing the contents of an already-applied migration is an error (an explicit reconcile is needed). Duplicates of names/contents in the input list end with a clear error.
- **Identity from content only (#169)**: a migration file cannot declare its own `hash` — the loader strips it and always recomputes it from the file contents. A declared hash that differs from the content one is a load error (a sign of tampering or an outdated template). This behavior is intentional; see «Upgrading from versions before content-based identity» below.
- **Partial application**: DDL in YDB is not transactional, so before `up()`/`down()` a marker `state='started'` is written, which is replaced by `'applied'` only after success. A crash in the middle of a migration leaves the marker: a repeated `run()` will not start it blindly again, and `revert()` will refuse to roll back such a record until its state is explicitly resolved — `runner.markMigrationApplied(name)` (changes manually marked/reconciled) or `runner.removeMigrationRecord(name)` (changes manually reverted). The same in the CLI: `ydb-orm migration:repair <name> --as-applied|--as-reverted`.
- **Parallel runs**: the claim to apply is an INSERT of a row with an id deterministically derived from the migration hash. Two processes that started one migration collide on the PRIMARY KEY: the second fails with a clear error before executing `up()` — double application is impossible without in-process locks.
- **`migration:show`** shows orphan records (`[!]` — applied, but the migration file no longer exists), interrupted (`[~]`), and modified after application (`[#]`) ones.

```ts
import type { YdbMigration, YdbExecutor } from '@ycforge/ydb-orm';
import { executeSql } from '@ycforge/ydb-orm';

export class CreateUsers1755000000000 implements YdbMigration {
  readonly name = '1755000000000-CreateUsers';

  async up(executor: YdbExecutor): Promise<void> {
    await executeSql(executor, 'CREATE TABLE `users` (`uuid` Uuid, PRIMARY KEY (`uuid`))');
  }

  async down(executor: YdbExecutor): Promise<void> {
    await executeSql(executor, 'DROP TABLE `users`');
  }
}
```

### Upgrading from versions before content-based identity

Before content-based identity (#101), migrations were matched by name, and in one more intermediate version the loader allowed a file to declare its own `hash` that overrode the content one (#169). When upgrading a project from such versions:

- **Check that the migration files do not declare a `hash`** (for example, `readonly hash = '...'` on a class or `hash: '...'` in an object). If there is one — delete that property.
- If a migration with a declared hash **was already applied** under the old version, its row in `ydb_migrations` has an id derived from the **declared** hash. After deleting the property, the content hash will not match the record, and the runner will **refuse** to execute such a migration again (the error «was modified after it was applied», in `migration:show` — `[#]`). This is protection against silent re-applications: silent corruption is impossible.
- To move to content identity safely: make sure the schema changes of this migration are actually in the DB, then manually bring the record to the new state — `ydb-orm migration:repair <name> --as-applied` (or programmatically `runner.markMigrationApplied(<migration object>)`). After that, the record will be matched against the new (content) hash.
- Old records **without a hash** (the very first version, matched by name) are still supported now: they are matched by name until overwritten by a reconcile. Changing the contents of such a migration after application — the same `modified` error.

### CLI

The package installs the `ydb-orm` binary:

```bash
ydb-orm migration:create CreateUsers      # an empty migration ./migrations/<ts>-CreateUsers.ts
ydb-orm migration:generate AddPhotos      # a migration by the diff of entities and the DB
ydb-orm migration:run                     # apply all new migrations
ydb-orm migration:revert                  # roll back the last one
ydb-orm migration:show                    # migration status (alias — migration:status)
ydb-orm migration:check                   # readiness check for CI (exit != 0 if not ready)
ydb-orm migration:repair 1755000000000-CreateUsers --as-applied   # an interrupted migration manually marked as applied
ydb-orm entity:create UserProfile         # an entity ./src/user-profile.entity.ts
ydb-orm metadata:dump                     # entity metadata as JSON (stdout, without DB)
ydb-orm entity:diagram                    # a Mermaid ER diagram by metadata (stdout/--output, without DB)
ydb-orm completion bash                   # a shell completion script (bash|zsh|fish)
```

Options: `--dir <path>` (the migrations directory, default `./migrations`; for `entity:create` — `./src`), `--config <path>`, `--output <file>` (for `entity:diagram`; an existing file is not overwritten), `--json` (for `migration:show`/`migration:status`/`migration:check`), `--verbose` (full error stack and the cause chain on failure). Unknown flags and empty option values are treated as an error.

#### Readiness check (#152)

`migration:check`, `migration:status`, and `migration:show` use a single **read-only** workflow: the commands only read the state (`DescribeTable` for `ydb_migrations` + a bare `SELECT` of records; for entities — `DescribeTable`) and change nothing — in particular, the bookkeeping table is **not created and not modified** (no `CREATE TABLE`/`ALTER TABLE`). Distinguishable states:

| State | Exit code | Meaning |
| --- | --- | --- |
| ready | 0 | all migrations are applied; the schema matches, if it was checked |
| `pending` | 1 | there are unapplied migrations |
| `interrupted` | 2 | there are interrupted migrations (`state='started'`, #101): a previous run was cut off in the middle of a migration, the DB may be partially changed |
| `schema-drift` | 3 | the DB schema diverges from the entity metadata (only checked if an `entities` array is set in the config) |
| `modified` | 4 | the contents of an applied migration changed after application (#101) |
| command error | 5 | failed to connect/read the state/an unexpected failure |

Interrupted and modified migrations are explicitly NOT considered successfully applied; orphan records (a file deleted after application) are shown in the report, but on their own they do not break readiness. With several states at once, the exit code is chosen by priority: `interrupted` → `modified` → `pending` → `schema-drift`.

If the `ydb_migrations` bookkeeping table does not exist yet (a fresh database), it is not created: it is considered that nothing is applied — with migration files present this is pending (exit 1), without them — ready (exit 0). In `--json` such a state is distinguished by the field `bookkeeping: {exists: false}`; legacy tables without the `hash`/`state` columns are read as is, without ALTER.

Text mode: the summary/list to stdout, problems and the schema diff to stderr, the final line starts with `Up to date:` or `Not ready:`. The diff color is determined by the real output stream and is disabled outside a TTY and with `NO_COLOR`. For machine parsing use `--json`: the whole report is on stdout with a stable schema (`ready`, `state`, `states`, `exitCode`, `pending`/`interrupted`/`modified`/`orphaned`, a detailed `migrations` array, and a `schema` block with the issues list); do not rely on the colors and wording of the text output.

#### Interactive `entity:create` (#24)

In a TTY the command launches an entity-generation wizard: table name → columns (name → YDB type → PK / `@YdbEncrypted` + blind index / `@YdbEnum` with values and storage / `@YdbCreateDateColumn`/`@YdbUpdateDateColumn`) → optional TTL (`@YdbTtl`, ISO 8601 duration, for date-like columns) → preview and confirmation of the write.

Guarantees:

- all entered definitions are validated **before** the file is written (table name, property names, PK presence, enum values, date-column types, TTL interval);
- an existing file is never overwritten — a collision ends with an error before the questions start;
- cancellation (Ctrl+C) and EOF (Ctrl+D) — a clean exit (exit code 130), the file is not created;
- no DB access and no DDL — only local file generation;
- outside a TTY (CI, scripts, closed stdin) input is not read at all: a default template (`uuid` PK + `name`) is deterministically created, the command does not hang.

Programmatic generation (for scripts and tools) — through the public API:

```ts
import { createEntityFileFromSpec } from '@ycforge/ydb-orm';

const created = createEntityFileFromSpec('./src', {
  className: 'OrderEntity',
  tableName: 'orders',
  columns: [
    { name: 'uuid', type: 'Uuid', primary: true },
    { name: 'status', type: 'Utf8', enumValues: ['active'], enumStorage: 'Utf8' },
    { name: 'created_at', type: 'Timestamp', createDate: true },
  ],
});
```

Also exported are `validateEntitySpec`, `renderEntityFile`, `buildDefaultEntitySpec`, `runEntityCreateCommand`/`runEntityCreateWizard` (an interactive wizard over arbitrary input/output streams).

`migration:generate` and `schema:verify` print a colored diff of the «entities vs DB» mismatches, grouped by table; the color is determined by the stream the output goes to (for `schema:verify` it is stderr), disabled when output is not a TTY or with the `NO_COLOR` variable.

#### Metadata export: `metadata:dump` (#37)

A read-only command dumps the entity metadata from the config (`entities`, as in `migration:generate`) into a deterministic JSON — **without connecting to the DB**: neither the driver, nor the executor, nor DDL are involved. The command is JSON-only by nature (the whole dump is on stdout); there is no separate text mode.

```bash
ydb-orm metadata:dump
```

The format is versioned (`format`/`version`); for each entity the following is dumped:

- class and table names; columns with YDB types (including the synthetic `{field}_bi` blind-index columns) and the PK with column order;
- relations of all types: type, target entity/table, join column, inverse property (`inverseProperty`), for many-to-many — a reference to the join table; physical descriptions of the join tables are in a separate `joinTables` list (columns, types from the actual PKs, owner);
- indexes (name, columns with order, unique) and TTL (column, ISO 8601 interval, unit);
- encryption without secrets: only declarative field flags (blind index + the `_bi` column name, lazy, aadOverride) and AAD PK fields; providers, keys, and runtime material are never exported;
- enum metadata (values in semantic order, storage), JSON columns, and eager relations.

Determinism: a stable order of entities (by table name), columns, indexes, relations, and JSON keys — a repeated run gives byte-identical output. Inheritance follows the rules of #92/#107: own `@YdbIndex`/`@YdbTtl` are not inherited, columns/PK/encryption/eager are inherited. Invalid metadata (a class without `@YdbEntity`, a duplicate table, a missing PK, conflicting join tables #139, an invalid join-column selector #87, an incompatible TTL) makes the command fail with a clear error before any output.

Programmatic API for external tools: `buildMetadataDump(entities)` (+ the types `MetadataDump` etc.) is exported from the package.

#### Mermaid ER diagram: `entity:diagram` (#36)

A read-only command renders the same canonical metadata (the same source as `metadata:dump` — `buildMetadataDump`) into a Mermaid ER diagram — **without connecting to the DB**. Valid metadata is required: any configuration error makes the command fail before the first byte of output.

```bash
ydb-orm entity:diagram                          # Mermaid text to stdout
ydb-orm entity:diagram --output docs/schema.mmd # to a file (overwrite is forbidden)
```

What is on the diagram:

- all entities from the config's `entities` — as blocks with columns and YDB types; PK columns come first **in declaration order** (the composite PK order is significant, #89) with the `PK` marker;
- one-to-many / many-to-one relations over a single join column give one `||--o{` line; a unidirectional one-to-many is drawn from the parent; one-to-one — `||--o|`; FK columns are marked `FK`;
- many-to-many — through the physical join table (#90/#139): a separate block with both columns (`PK, FK`) and two owner → join → inverse lines;
- determinism: the order of blocks/lines is stable and independent of the input list order — a repeated run gives byte-identical output;
- safe names: table names and relation labels are always quoted, column names that are invalid for Mermaid attributes are sanitized, and the original is preserved as a comment.

Programmatic API: `buildEntityDiagram(entities)` and `writeDiagramFile(path, diagram)` are exported from the package.

Shell completion for commands and flags:

```bash
# bash
ydb-orm completion bash | sudo tee /etc/bash_completion.d/ydb-orm
# zsh (path from $fpath)
ydb-orm completion zsh > ~/.zsh/completions/_ydb-orm
# fish
ydb-orm completion fish > ~/.config/fish/completions/ydb-orm.fish
```

The connection config is `./ydb-orm.config.ts` (or `.mts`/`.mjs`/`.js`; searched in the current directory and above, up to the filesystem root; both default and named exports are supported):

```ts
import { createAuth, authKeyFromFile } from '@ycforge/auth';
import { UserEntity } from './src/user.entity.js';

export default {
  endpoint: process.env.YDB_ENDPOINT!,
  auth: createAuth(authKeyFromFile('./authorized_key.json')),
  entities: [UserEntity],        // needed for migration:generate
  migrationsDir: './migrations', // optional
};
```

Without a config, the CLI reads `YDB_ENDPOINT` (or `YDB_CONNECTION_STRING`), but setting `auth` still requires a `ydb-orm.config.ts`.

`migration:generate` builds a diff across all `entities` from the config: no table → `CREATE TABLE` (+ `DROP TABLE` in `down`), missing columns → `ADD COLUMN` (+ `DROP COLUMN` in `down`). Type/PK mismatches and extra columns are not changed automatically — they get into the migration as `WARNING` comments.

If a mismatch looks like a rename (exactly one extra DB column and one new entity column with the same type, without PK/indexes/TTL/blind-index involvement), the generator does not silently emit ADD/DROP: a hint comment of the form `ALTER TABLE ... RENAME COLUMN ... TO ...` is added to `up()`/`down()`, and the application remains manual — YQL does not support `RENAME COLUMN` yet. On ambiguity (several candidates, key columns, encryption metadata) the previous behavior applies: `ADD COLUMN` + `WARNING`.

### Programmatic API

`YdbMigrationRunner` (run/revert/status, recovery after failures — `markMigrationApplied`/`removeMigrationRecord`), `loadMigrationsFromDir`, `planMigration`, `executeSql` are exported from the package — you can embed migrations into your own pipeline.

In `YdbMigrationStatus` the `applied` field equals `true` **only** for a healthily applied migration: a migration modified after application (`contentChanged`) and an interrupted one (`interrupted`) are not `applied` (the flag carries the true reason); orphan records are informational. Do not rely on `applied` as «there is a bookkeeping record» — check readiness via `evaluateMigrationCheck`/`migration:check`.

---

## Development

```bash
yarn install
yarn build        # tsc → dist/ (ESM + .d.ts)
yarn test         # jest (ESM), unit + NestJS integration tests
yarn lint         # eslint --fix
yarn format       # prettier --write
```

The tests do not touch the network: the NestJS integration tests (`test/nestjs/`) replace `YDB_DRIVER` / `YDB_QUERY` via `overrideProvider`.

## Notes

- The `@bufbuild/protobuf` version is pinned to `2.12.0`: on `^`, the `anyUnpack` typings break due to a branded-type mismatch with `@ydbjs/*`.
- Queries to YDB are parameterized (`query.parameter(...)`) — values are never concatenated into SQL.