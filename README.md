# @ycforge/ydb-orm

[![npm (scoped)](https://img.shields.io/npm/v/@ycforge/ydb-orm)](https://www.npmjs.com/package/@ycforge/ydb-orm)
[![NPM](https://img.shields.io/npm/l/@ycforge/ydb-orm)](./LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/ycforge/ydb-orm)](https://github.com/ycforge/ydb-orm/issues)

TypeORM-like ORM для [YDB (Yandex Database)](https://ydb.tech/) на TypeScript: Active Record, relations, шифрование полей с blind index, schema sync, транзакции и миграции. **Ядро пакета каркасно-нейтральное** — работает без NestJS; интеграция с NestJS вынесена в подпакет `@ycforge/ydb-orm/nest`.

Принципы: удобство, минимализм (по памяти и CPU) и функционал.

Runtime — Node.js ≥ 22.18 (нативный импорт `.ts` через type stripping), ESM (`"type": "module"`, `module: nodenext`). Драйвер — [`@ydbjs/*`](https://github.com/ydb-platform/ydb-js-sdk) (новое поколение SDK).

## Установка

```bash
# ядро:
yarn add @ycforge/ydb-orm

# опционально, NestJS-интеграция:
yarn add @ycforge/ydb-orm/nest @nestjs/common @nestjs/core reflect-metadata rxjs
```

`@nestjs/*`, `rxjs` и `reflect-metadata` — optional peerDependencies; без них основной пакет работает в полном объёме (standalone, CLI, скрипты).

---

## Быстрый старт (standalone, без фреймворков)

### 1. Определение сущности

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

### 2. Настройка executor'а

```ts
const driver = createDriver({
  endpoint: 'grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/...',
  auth: createAuth(authKeyFromFile('./authorized_key.json')),
});

const executor = createExecutor(driver);

configureEntities(executor, [UserEntity]);
// с этого момента Active Record-методы сущности работают
```

`configureEntities` связывает executor и провайдеры шифрования с сущностями напрямую, без DI.

### 3. Active Record

```ts
// одна запись по PK
const user = await UserEntity.find({ uuid: '...' });

// выборка с условиями и лимитом
const admins = await UserEntity.findAll({ is_admin: true }, { limit: 50 });

// INSERT/UPDATE
const u = new UserEntity();
u.name = 'Ivan';
await UserEntity.save(u);  // uuid генерируется автоматически (v7)

// транзакции
const txManager = new YdbTransactionManager(executor);
await txManager.runInTransaction(async (trx) => {
  await UserEntity.save(user, { trx });
});
```

### Репозиторий (standalone)

Помимо Active Record (`UserEntity.find(...)`) доступен прямой доступ к репозиторию:

```ts
import { getOrCreateRepository } from '@ycforge/ydb-orm';

// репозиторий создаётся автоматически после configureEntities
const repo = getOrCreateRepository(UserEntity);

const user = await repo.findOneBy({ uuid });
const users = await repo.findAll({ name: 'Ivan' }, { limit: 50 });
const count = await repo.count({ is_admin: true });
await repo.save(entity);
await repo.insertMany([u1, u2]);
await repo.updateBy({ status: 'old' }, { status: 'archived' });
await repo.deleteBy({ status: 'deprecated' });
```

`YdbEntityManager` — фабрика репозиториев (удобно, если нужно работать с разными сущностями через единый интерфейс):

```ts
import { YdbEntityManager } from '@ycforge/ydb-orm';

const manager = new YdbEntityManager();
const userRepo = manager.getRepository(UserEntity);
const postRepo = manager.getRepository(PostEntity);

// CRUD через репозиторий
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

// Транзакции — передаём { trx } в любой метод
const txManager = new YdbTransactionManager(executor);
await txManager.runInTransaction(async (trx) => {
  await userRepo.save(user, { trx });
  await postRepo.save(post, { trx });
});
```

`YdbRepository` — ядро ORM: вся CRUD-логика живёт в нём (и в `YdbEntityPersistence`/`YdbEntityRelations` под капотом). Active Record остаётся полностью работоспособным: статические методы `UserEntity.find(...)` — тонкий фасад, делегирующий в тот же репозиторий. Оба стиля (Active Record и Repository) можно смешивать в одном приложении.

### Схема.sync в standalone-режиме

```ts
import { YdbSchemaSyncer } from '@ycforge/ydb-orm';

const syncer = new YdbSchemaSyncer(executor);

// проверка без изменений
const issues = await syncer.verify([UserEntity]);
console.log(issues);

// применение (CREATE TABLE / ALTER TABLE ADD COLUMN)
await syncer.sync([UserEntity]);
```

---

## Быстрый старт (NestJS, опционально)

Для NestJS-приложений — подпакет `@ycforge/ydb-orm/nest`:

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
        sync: true, // как synchronize в TypeORM — только для dev!
      }),
    }),
    YdbOrmModule.forFeature([UserEntity]),
  ],
})
export class AppModule {}
```

`YdbCoreModule.forRootAsync` поддерживает `useFactory` / `useClass` / `useExisting` (как в NestJS). `YdbOrmModule.forFeature([...Entity])` обязателен для NestJS: без него статические методы сущности упадут с «YDB executor not set».

### Репозиторий (NestJS DI)

Помимо Active Record (`UserEntity.find(...)`) `YdbOrmModule.forFeature` регистрирует инжектируемый `YdbRepository<Entity>`:

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

Также доступен `YdbEntityManager` — фабрика репозиториев (`manager.getRepository(UserEntity)`). `YdbRepository` — ядро ORM: вся CRUD-логика живёт в нём (и в `YdbEntityPersistence`/`YdbEntityRelations` под капотом). Active Record остаётся полностью работоспособным: статические методы `UserEntity.find(...)` и т.д. — тонкий фасад, делегирующий в репозиторий.

---

## Active Record

```ts
await UserEntity.find({ uuid });                    // одна запись или null
await UserEntity.findAll({ name: 'Ivan' }, { limit: 50, offset: 0 });
await UserEntity.count({ name: 'Ivan' });
await UserEntity.save(user);                        // insert (uuid генерируется, по умолчанию v7) или update по uuid
await UserEntity.insertMany([u1, u2]);              // батчи по 100
await user.loadRelations(['roles']);
```

`QueryOptions`: `trx`, `timeout` (мс), `signal` (AbortSignal), `limit` (по умолчанию 100, макс 1000; семантика та же, что у `limit()` билдера — см. таблицу ниже: `0` → пустой результат, отрицательное/дробное — ошибка `Invalid LIMIT`), `offset`.

## QueryBuilder

Цепочный builder поверх Active Record (`src/query/`):

```ts
const photos = await PhotoEntity.query()
  .where({ is_public: true })
  .andWhere({ author_email: 'a@b.c' }) // encrypted + blind index — как в find
  .orderBy('rating', 'DESC')
  .addOrderBy('title')
  .limit(20)
  .offset(10)
  .getMany();

await PhotoEntity.query().where({ is_public: true }).getOne();   // первая или null
await PhotoEntity.query().where({ is_public: true }).getCount(); // COUNT(*)
const { sql, values } = await PhotoEntity.query().where({ is_public: true }).toYql(); // без выполнения
```

Билдер переиспользуем: `getOne()`/`getMany()`/`toYql()` не меняют его состояние,
один и тот же builder можно выполнять несколько раз (например, `getOne()`, затем
`getMany()` с сохранённым лимитом).

Явная семантика `limit()` (без молчаливого clamp в 1..1000):

| вызов | итоговый `LIMIT` |
| --- | --- |
| лимит не задан | `100` — защитный дефолт (константа `DEFAULT_RETRIEVE_LIMIT`) |
| `limit(0)` | `0` — гарантированно пустой результат |
| `limit(n)`, 1 ≤ n ≤ 1000 | `n` |
| `limit(n)`, n > 1000 | `1000` — защитный потолок (`MAX_RETRIEVE_LIMIT`) |
| `limit(отрицательное / дробное / неконечное)` | ошибка `Invalid LIMIT` |

WHERE поддерживает операторы сравнения, логические группы `$or`/`$and` и JSON-операторы. Поля в WHERE/ORDER BY валидируются по метаданным сущности.

### WHERE-операторы

```ts
await UserEntity.findAll({
  $or: [
    { balance: { $gte: 100 } },
    { is_admin: true },
  ],
  is_banned: false,
});
```

Поддерживаемые операторы:

- `$eq` — равенство (`=`), используется по умолчанию при `{ field: value }`.
- `$ne` — не равно (`!=`), поддерживает `null` (`IS NOT NULL`).
- `$gt`, `$gte`, `$lt`, `$lte` — числовые/строковые сравнения.
- `$like` — `LIKE` (только `Utf8`-колонки).
- `$in` — `IN (...)` (массив непустой).
- `$between` — `BETWEEN lo AND hi` (массив из двух значений).
- `$jsonExists` / `$jsonValue` — для `Json` / `JsonDocument` / `@YdbJson()` колонок.

Логические группы:

- `$and: [...]` — объединяет вложенные условия через `AND`.
- `$or: [...]` — объединяет вложенные условия через `OR`.

Группы можно вкладывать друг в друга.

### Фильтрация по связанным сущностям (#17)

В WHERE вместо колонки можно указать свойство-связь (`@OneToMany` / `@ManyToOne` / `@OneToOne` / `@ManyToMany`) с объектом условий по колонкам связанной сущности — корневые строки фильтруются по наличию подходящей связанной строки:

```ts
// Пользователи, у которых есть роль 'admin' (one-to-many)
await UserEntity.findAll({ userRoles: { is_global: true } });

// Несколько related-предикатов + обычные условия корня (AND)
await PhotoWithTagsEntity.findAll({
  title: { $like: '%sunset%' },
  tags: { name: 'nature' },          // many-to-many через join-таблицу
  author: { status: 'active' },      // many-to-one
});

// Логические группы смешивают колонки корня и связи
await UserEntity.findAll({
  $or: [
    { uuid: someUuid },
    { userRoles: { role_uuid: adminRoleUuid } },
  ],
});
```

Поддержанные формы связи и генерируемый YQL (полуслияние `IN` с некоррелированным подзапросом — семантика `EXISTS`; коррелированные подзапросы ядром YQL не поддерживаются, а такой `IN` не порождает дубликатов корневых строк, поэтому `DISTINCT`/`JOIN` не нужны):

| связь | условие |
| --- | --- |
| one-to-many | `root.pk IN (SELECT child.fk FROM target WHERE pred)` |
| many-to-one / one-to-one | `root.fk IN (SELECT target.pk FROM target WHERE pred)` |
| many-to-many | `root.pk IN (SELECT jt.owner FROM jt WHERE jt.inverse IN (SELECT target.pk FROM target WHERE pred))` |

Пустой предикат `{ tags: {} }` означает «есть хотя бы одна связанная строка». Связи можно вкладывать (`{ linkedUser: { roles: { role: 'admin' } } }`).

Ограничения и гарантии:

- **Только нешифрованные колонки**: `@YdbEncrypted`-поля связанной сущности (включая их `{field}_bi`) в related-фильтрах запрещены — попытка ищется понятной ошибкой.
- Валидация путей по метаданным: неизвестная связь/колонка, необъявленная join-колонка, несовместимые типы join-колонок, составной PK на стороне соединения (для one-to-many — у корня, для many-to-one/one-to-one — у цели) или отсутствие `@JoinTable` у many-to-many отвергаются ошибкой **до выполнения SQL**.
- Все значения биндятся параметрами запроса; литералы в SQL не попадают.
- Работает во всех методах с общим конвейером WHERE: `find`/`findOneBy`, `findAll`/`findBy`, `count`, `updateBy`, `deleteBy` и в QueryBuilder (`where`/`andWhere`/`orWhere`); `{ trx }`/ambient-транзакции и лимиты сохраняются.

## Декораторы

- `@YdbEntity('table')` — имя таблицы; класс попадает в глобальный реестр сущностей (используется schema sync).
- `@YdbColumn('Uuid' | 'Utf8' | 'Bytes' | 'Int32' | 'Int64' | 'Bool' | 'Double' | 'Float' | 'Date' | 'Datetime' | 'Timestamp' | 'Json' | 'JsonDocument')` — колонка. Дата-типы принимают `Date`, число (мс от эпохи) или ISO-строку; **точность `Timestamp` ограничена миллисекундами**: JS `Date` хранит только мс, поэтому субмиллисекундные значения (микро-/наносекунды) не сохраняются — при чтении младшие разряды YDB-микросекунд теряются.
- `@YdbPrimaryColumn(type)` — колонка первичного ключа (поддерживается составной PK: несколько таких колонок). **PK обязателен**: без `@YdbPrimaryColumn` сущность нельзя инициализировать — `validateEntityMetadata` (при старте модуля), schema sync и runtime-операции бросают ошибку `must declare at least one primary key via @YdbPrimaryColumn`. «Дефолтного `uuid`-PK» не существует. Если среди PK-колонок объявлена колонка `uuid` типа `Uuid`, её значение генерируется автоматически при вставке (по умолчанию UUID v7, настраивается опцией `uuidVersion`).
- `@YdbEncrypted({ blindIndex, lazy })` — поле шифруется перед записью и дешифруется после чтения; `blindIndex: true` (по умолчанию) добавляет synthetic колонку `{field}_bi` для поиска по хешу. Шифротекст хранится в колонке `Bytes` (raw bytes), тип из `@YdbColumn` для таких полей игнорируется. Опция `lazy: true` откладывает дешифровку: поле не дешифруется при SELECT (экономия CPU), plaintext возвращают `await entity.decryptField('field')` / `await entity.decryptLazyFields()` (результат кешируется в инстансе); `toJSON()`/`JSON.stringify()` бросают ошибку, пока lazy-поля не дешифрованы.
- `@YdbSecurityAAD()` — незашифрованное поле участвует в AAD (может применяться только к PK-колонкам).
- `@YdbJson()` — поле хранится как JSON-строка в `Utf8`; ORM автоматически сериализует/парсит значения. Нативные `Json`/`JsonDocument` доступны через `@YdbColumn('Json')` / `@YdbColumn('JsonDocument')`.
- `@OneToMany` / `@ManyToOne` / `@OneToOne` / `@ManyToMany` — relations; `@EagerLoad([...])` — batch-загрузка одним `IN (...)` запросом (без N+1). `@ManyToMany` требует `@JoinTable('join_table_name')` на владеющей стороне; join-таблица попадает в schema sync и миграции автоматически.
- `@YdbIndex({ columns, name? })` — вторичный индекс (GLOBAL SYNC); класс-декоратор, можно несколько. Имя по умолчанию `{table}__{col1}_{col2}`. Попадает в CREATE TABLE при schema sync и в `migration:generate` для новых таблиц.
- `@YdbEnum({ values, storage? })` — enum-колонка. `storage: 'Utf8'` (по умолчанию) хранит строковое значение enum; `storage: 'Int32'` — порядковый номер значения в `values`. Навешивается на свойство вместе с `@YdbColumn` соответствующего типа (`Utf8` или `Int32`).
- `@YdbCreateDateColumn()` / `@YdbUpdateDateColumn()` — колонка автоматически заполняется `new Date()`: `@YdbCreateDateColumn` — на вставке (при значении `undefined` → если задано явно, не перезаписывается); `@YdbUpdateDateColumn` — на вставке и на обновлении: `save()` существующей записи перезаписывает поле всегда, `updateBy` и `insertMany` заполняют только если значение не задано. Объявляется на свойстве вместе с `@YdbColumn('Timestamp')`.
- `@YdbTtl({ interval, column, unit? })` — декларативный TTL таблицы (класс-декоратор, один раз на класс). `interval` — ISO 8601 duration (`"PT2H"`, `"P30D"`); `column` — обязательная колонка, объявленная через `@YdbColumn` (типы `Date`/`Datetime`/`Timestamp` без `unit`, либо числовые `Uint32`/`Uint64`/`DyNumber` — тогда обязателен `unit`); `unit` — единица для числовой колонки (`seconds` | `milliseconds` | `microseconds` | `nanoseconds`). Генерирует секцию `WITH (TTL = Interval(...) ON column)` в CREATE TABLE. Ошибки формата бросаются сразу при декорировании, несовместимость со схемой сущности — при инициализации модуля.
- `@BeforeInsert` / `@AfterInsert` / `@BeforeUpdate` / `@AfterFind` / `@BeforeRemove` — lifecycle-хуки (метод-декораторы без скобок). Подробности и гарантии вызовов — в разделе [Lifecycle hooks](#lifecycle-hooks).

### Наследование метаданных

Правила наследования декораторов между родительским и дочерним классами (#92):

- **`@YdbEntity` не наследуется.** Сущностью является только класс, непосредственно декорированный `@YdbEntity`. Подкласс без собственного `@YdbEntity` — не сущность: он не наследует tableName родителя, не попадает в реестр и в expected-схемы schema sync/миграций, а Active Record-вызовы на нём падают с понятной ошибкой «is not decorated with @YdbEntity». Передавать такой класс в `forFeature`/`configureEntities`/список entities нельзя.
- **Колонки наследуются** (`@YdbColumn`, `@YdbPrimaryColumn`, `@YdbEncrypted`, `@YdbSecurityAAD`, `@YdbJson`, `@YdbEnum`, timestamp-декораторы, lifecycle-хуки): дочерний класс получает объединение метаданных предков, переопределение на наследнике не меняет родителя (copy-on-write). Повторы и переопределения: `@YdbEnum` — last-write-wins, AAD/PK — дедупликация по имени поля.
- **`@YdbIndex` и `@YdbTtl` не наследуются** — они привязаны к физической таблице класса. Класс со своим `@YdbEntity` начинает без индексов и TTL и объявляет свои явно; это гарантирует, что индексы/TTL родителя (возможно, по чужим или переопределённым колонкам) никогда не попадут в DDL дочерней таблицы.
- **`@EagerLoad` наследуется объединением**: связи родителя сохраняются, список ребёнка дополняет их без повторов (первое объявление выигрывает).
- **Дубликат tableName у двух разных сущностей** (например, родитель и наследник, декорированные одним именем) — ошибка `Duplicate table name "..."` при построении схемы (`buildExpectedSchemas`): sync/verify/`migration:generate` всегда работают с ровно одной ожидаемой схемой на таблицу.

```ts
@YdbEntity('events')
@YdbTtl({ interval: 'P30D', column: 'created_at' })
class EventEntity extends YdbBaseEntity { /* ... */ }

// Своя таблица: колонки родителя наследуются, TTL/индексы — нет
@YdbEntity('audit_events')
class AuditEventEntity extends EventEntity { /* ... */ }

// Ошибка: Duplicate table name "events"
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

Декораторы `@BeforeInsert`, `@AfterInsert`, `@BeforeUpdate`, `@AfterFind`, `@BeforeRemove` навешивают хуки на методы сущности. Семантика вызовов единая для всех путей чтения и записи:

| Хук | Когда вызывается |
| --- | --- |
| `@BeforeInsert` | `save()` новой сущности; каждый элемент `insertMany()` — до валидации, шифрования и формирования параметров, мутации полей попадают в БД |
| `@AfterInsert` | после успешной записи (`insert()`, каждый элемент `insertMany()`) |
| `@BeforeUpdate` | `save()` существующей сущности (по PK) |
| `@AfterFind` | все пути чтения: `find()`/`findOneBy()`, `findAll()`/`findBy()`, `query().getMany()`/`getOne()`, а также внутренние выборки — eager-загрузка связей и `loadRelations()` (batch `IN (...)`) и загрузка инстанса внутри `delete()` |
| `@BeforeRemove` | только `delete()`; сущность предварительно загружается через `find()` |

Гарантии:

- `@AfterFind` вызывается **ровно один раз** для каждого инстанса в рамках операции чтения и **не вызывается при пустом результате**.
- Порядок: хуки связанных сущностей срабатывают раньше хуков корневых; `@AfterFind` корневой сущности видит уже присоединённые связи.
- Глубина eager не меняется: связи загружаются только для сущностей выборки (один уровень). Связанные сущности получают свой `@AfterFind`, но их собственные eager-связи догружаются только явным `loadRelations()`/отдельным запросом — это исключает бесконечную рекурсию на циклических/self-referencing связях.
- `updateBy()` и `deleteBy()` — массовые операции: per-entity хуки для затронутых строк не вызываются. Если нужна бизнес-логика на каждую строку — используйте `save()`/`delete()` или выполняйте её явно до bulk-вызова.
- `count()`, `updateBy()`, `deleteBy()` не загружают сущности, поэтому хуков чтения/удаления у них нет.

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
    // вызывается и для корневых сущностей, и для eager/lazy relations
  }
}
```

## Шифрование

Провайдеры передаются в опции модуля/standalone-конфиг:

```ts
{
  encryptionProvider: myEncryptionProvider,   // { encrypt(value, aad, ctx) → Uint8Array, decrypt(ciphertext, aad, ctx) → string }
  blindIndexProvider: myBlindIndexProvider,   // { hash(value, ctx) → string }
}
```

`encrypt` возвращает raw ciphertext (`Uint8Array`), который ORM пишет в колонку `Bytes`
(без base64-кодирования — экономия ~33% по сравнению с `Utf8`). `decrypt` принимает
`Uint8Array` из колонки `Bytes`. Blind index (`{field}_bi`) — обычная `Utf8`-колонка.

Тестовая заглушка `TestOnlyEncryptionProvider` (без реальной криптографии, с громким
WARNING при использовании) вынесена в отдельный dev-пакет
[`@ycforge/js-dev-tools`](https://github.com/ycforge/js-dev-tools) — подключайте её
только в тестах через `devDependencies`. Готовые боевые провайдеры (AES-256-GCM,
HMAC-SHA256, KMS) — в пакете `@ycforge/orm-security-providers`.

При `updateBy()` для зашифрованного поля ORM собирает AAD из значений AAD-полей, зафиксированных в `where` (например, по PK). Если AAD не может быть однозначно определён из предиката, ORM бросает ошибку — для явного переопределения можно использовать `aadOverride` в `@YdbEncrypted({ aadOverride: '...' })`.

## JSON-колонки

Поддерживаются три варианта:

- `@YdbColumn('Json')` — нативный YDB `Json`.
- `@YdbColumn('JsonDocument')` — нативный YDB `JsonDocument`.
- `@YdbJson()` — JSON-объект хранится как строка в `Utf8` (ORM сам делает `JSON.stringify`/`JSON.parse`).

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

Для JSON-колонок в `query()`/QueryBuilder доступны операторы:

```ts
await EventEntity.query()
  .andWhereJsonExists('metadata', '$.settings.theme')
  .andWhereJsonValue('metadata', '$.role', 'admin')
  .getMany();
```

## Schema sync

### Standalone

```ts
import { YdbSchemaSyncer } from '@ycforge/ydb-orm';

const syncer = new YdbSchemaSyncer(executor);

// verify — проверяет схему, ничего не меняет
const issues = await syncer.verify([UserEntity, PostEntity]);

// sync — подстраивает схему
await syncer.sync([UserEntity, PostEntity]);
```

- нет таблицы → `CREATE TABLE`;
- нет колонок → `ALTER TABLE ADD COLUMN`;
- лишние колонки → только warn в лог (данные не удаляются);
- расхождение типа колонки или PK → ошибка (в YDB не меняется, нужна миграция).

### NestJS

В NestJS-приложении schema sync выполняется автоматически в `onApplicationBootstrap`:

```ts
YdbCoreModule.forRootAsync({
  useFactory: () => ({
    endpoint: '...',
    auth: createAuth(authKeyFromFile('./authorized_key.json')),
    sync: true, // только для dev! В проде — миграции.
  }),
});
```

Провайдер `YDB_SCHEMA_SYNC` экспортируется из `YdbCoreModule` (подпакет `nest`): `syncer.verify(entities)` проверяет схему без изменений. Генераторы DDL (`generateCreateTableYql` и т.д.) доступны в публичном API — их можно использовать для миграций.

#### Жизненный цикл модуля (#93)

- **Schema sync выполняется в `onApplicationBootstrap`**, а не в DI-фабрике: к этому моменту зарегистрированы все сущности всех модулей, порядок инициализации детерминирован, а ошибка DDL приходит из `app.init()` как исходная ошибка схемы. Для тестов это значит: sync срабатывает после `module.init()` / `app.init()`, а не после `compile()`.
- **Защита от двойного `forRootAsync`**: повторная инициализация ядра в одном процессе, пока предыдущее приложение не закрыто (`app.close()`), падает с понятной ошибкой `Duplicate YDB module initialization`. Последовательные бутстрапы (тесты, hot-restart) разрешены.
- **Изоляция реестра сущностей**: у каждого экземпляра `YdbCoreModule` (каждого Nest-приложения) есть собственный скоуп сущностей — он создаётся на статической стороне `forRootAsync` и доступен провайдерам через DI-токен `YDB_CORE_SCOPE`. `YdbOrmModule.forFeature([...])` при создании провайдеров привязывает объявленные сущности к скоупу СВОЕГО приложения: декоратор `@YdbEntity` выполняется один раз за жизнь процесса (кеш модулей), поэтому восстановление видимости при повторном бутстрапе делает сама forFeature. Порядок резолва провайдеров роли не играет — приложение, упавшее с `Duplicate YDB module initialization`, не может загрязнить сущностями живое (#142). После `app.close()` набор приложения уходит вместе с его состоянием; CLI/standalone видят весь глобальный реестр.
- **Graceful shutdown**: драйвер, созданный модулем, закрывается в `onApplicationShutdown` (включите `app.enableShutdownHooks()`). Драйверы, переданные извне через `overrideProvider`, не закрываются. Опция `driverFactory` позволяет подставить собственную фабрику драйвера — такой драйвер считается принадлежащим модулю и тоже закрывается.

## Транзакции

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

В NestJS `YdbTransactionManager` инжектируется из DI (предоставляется автоматически `YdbCoreModule`):

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

### Опции исполнения (#98)

`runInTransaction(fn, options)` принимает опции, которые пробрасываются в вызов транзакции SDK (`client.transaction(options, ...)`):

```ts
await txManager.runInTransaction(
  async (trx, signal) => {
    await OrderEntity.save(order, { trx });
  },
  {
    isolation: 'snapshotReadWrite',   // serializableReadWrite (по умолчанию) | snapshotReadOnly | snapshotReadWrite
    timeout: 5_000,                    // таймаут НА КАЖДУЮ ПОПЫТКУ (см. ниже)
    signal: controller.signal,         // ГЛОБАЛЬНАЯ отмена: вся операция, все попытки
    idempotent: true,                  // см. «Retry-семантика» ниже
  },
);
```

**Семантика отмены при `idempotent: true`** — у `signal` и `timeout` разный охват:

- `signal` — **глобальный**: пробрасывается в SDK как есть и отменяет операцию целиком, включая все retry-попытки;
- `timeout` — **на каждую попытку**: SDK может повторить колбэк заново (`idempotent: true`), и каждая попытка получает свежее окно таймаута — retry никогда не стартует с уже истёкшим дедлайном первой попытки. Сигнал, который получает колбэк (`fn(trx, signal)`), объединяет сигнал попытки от SDK и `AbortSignal.timeout(timeout)` этой попытки.

Полный дедлайн на всю операцию задаётся явно через пользовательский сигнал:

```ts
await txManager.runInTransaction(fn, {
  idempotent: true,
  signal: AbortSignal.timeout(30_000), // общий лимит на все попытки
});
```

Опции валидируются fail-fast: неизвестный ключ (опечатка), невалидный уровень изоляции, неположительный `timeout`, не-`AbortSignal` — ошибка сразу.

### Вложенные транзакции

Вложенный `runInTransaction()` по умолчанию **запрещён**: второй вызов откроет независимую транзакцию на другой сессии, что почти всегда ошибка. Чтобы присоединиться к активной транзакции (коммит/откат остаются у внешнего вызова), передайте `{ reuse: true }`:

```ts
await txManager.runInTransaction(async () => {
  await txManager.runInTransaction(async (trx2) => {
    // Error: Nested runInTransaction() detected ...
  });
});

await txManager.runInTransaction(async () => {
  await txManager.runInTransaction(async (sameTrx) => {
    // та же транзакция, что и снаружи
  }, { reuse: true });
});
```

Вложенность определяется по AsyncLocalStorage-цепочке и только для того же executor'а БД; вложенные транзакции на другом драйвере/базе считаются независимыми.

### Ambient-контекст (opt-in)

Один пропущенный `{ trx }` — и запрос молча уйдёт вне транзакции. Ambient-режим решает это: операции репозиториев без явного `{ trx }` автоматически выполняются в активной транзакции.

```ts
// NestJS: глобально при инициализации модуля
YdbCoreModule.forRootAsync({
  useFactory: () => ({
    // ...
    transactions: { ambient: true },
  }),
});

// Standalone: через опции модуля (YdbModuleOptions)
// или точечно, на один вызов:
await txManager.runInTransaction(async () => {
  await OrderEntity.save(order);          // уйдёт в транзакцию автоматически
  await OrderEntity.save(other, { trx }); // явный trx тоже работает
}, { ambient: true });
```

Правила безопасности:

- если при активной ambient-транзакции явно передан **другой** `{ trx }` — ошибка смешивания, а не молчаливое расхождение данных;
- после commit/rollback контекст очищается;
- параллельные транзакции не перетекают друг в друга;
- ambient выключен по умолчанию: явный `{ trx }` работает как раньше.

### Запросы вне транзакции

Для отладки можно включить предупреждение о каждом запросе вне какой бы то ни было транзакции:

```ts
transactions: { warnOutsideTransaction: true } // console.warn на каждый такой запрос
```

По умолчанию выключено — предупреждения не шумят.

### Retry-семантика (важно!)

SDK (`@ydbjs/query`) при `idempotent: true` повторяет **весь колбэк** транзакции при retryable-ошибках (сбой сети, смерть сессии). Это значит:

- побочные эффекты колбэка выполняются повторно;
- lifecycle hooks (`@BeforeInsert`, `@AfterInsert`, ...) срабатывают больше одного раза;
- каждая попытка получает новую сессию/транзакцию (новый `trx`).

Колбэк должен быть устойчив к повтору. Без `idempotent: true` повторов нет. Настраиваемая политика ORM с ограничением попыток — опцией `retry`: см. «Retry-политика по типу ошибки (#27)» ниже.

### Retry-политика по типу ошибки (#27)

SDK (`@ydbjs/query`) ретраит одиночные запросы и тело транзакции **внутри себя** (неограниченный бюджет по умолчанию, настройкам не поддаётся). ORM подключает свою политику **плагинами** в executor и транзакции так, чтобы слои повтора не перемножались. Приоритет слоёв детерминирован:

| Конфигурация | Кто ретраит | Попытки |
|---|---|---|
| Политика выключена (по умолчанию) | только SDK (как в #98) | без изменений |
| `retry` на executor'е / `YdbModuleOptions` | политика ORM для ЯВНО помеченных идемпотентных запросов; внутренний цикл SDK гасится через событие `retry` запроса | ровно `maxAttempts` обращений к БД |
| `retry` в `runInTransaction()` | политика ORM: одна попытка тела на попытку политики (внутренний цикл SDK гасится защитным лимитом) | ровно `maxAttempts` исполнений колбэка |

#### Правило идемпотентности (#27, fail-safe)

Политика повторяет **только явно помеченные идемпотентными** запросы:

```ts
// ❌ Не помечен (INSERT/UPSERT/UPDATE/DELETE по умолчанию):
// выполнится РОВНО ОДИН раз даже при retry: true.
await UserEntity.save(user);

// ❌ Транзитная ошибка у незнакомой записи → повтор небезопасен:
await OrderEntity.findBy({ status: 'new' }); // тоже один раз

// ✅ Помечен идемпотентным: политика может повторить при
// ABORTED / UNAVAILABLE / OVERLOADED.
const users = await UserEntity.findAll({}, { idempotent: true });
await UserEntity.save(user, { idempotent: true }); // операция устойчива к повтору
await executor`SELECT ...`.idempotent(true);       // прямой executor
```

Почему так: после двусмысленного сбоя транспорта (`UNAVAILABLE` и т.п.) невозможно знать, применилась ли запись на сервере. Повтор незнакомой записи может продублировать побочные эффекты, поэтому по умолчанию любой непомеченный запрос выполняется ровно один раз (внутренний цикл SDK для него тоже гасится). Помечайте `{ idempotent: true }` только операции, устойчивые к повтору. Пометка пробрасывается в SDK как `.idempotent(true)`.

Транзакции — отдельный контракт: опция `retry` в `runInTransaction()` управляет телом целиком и требует идемпотентности КОЛБЭКА (#98); пометки отдельных запросов внутри тела на это не влияют (SDK их там игнорирует).

#### Подключение к executor

```ts
import { createAuth } from '@ycforge/auth';
import { createExecutor, createDriver } from '@ycforge/ydb-orm';

const driver = createDriver({ endpoint: '...', auth: createAuth({ type: 'anonymous' }) });

// standalone:
const executor = createExecutor(driver, { retry: { maxAttempts: 5 } });

// Вручную поверх готового executor'а (оборачивать ОДИН раз):
import { withRetryPolicy } from '@ycforge/ydb-orm';
const resilient = withRetryPolicy(executor, { maxAttempts: 5 });
```

NestJS:

```ts
YdbCoreModule.forRootAsync({
  useFactory: () => ({
    endpoint: '...',
    auth: createAuth({ type: 'anonymous' }),
    retry: true, // или объект YdbRetryPolicyOptions; false/undefined — выключено
  }),
});
```

#### Подключение к транзакциям

```ts
await txManager.runInTransaction(
  async (trx) => {
    await OrderEntity.save(order, { trx });
  },
  {
    idempotent: true,   // семантика #98: колбэк обязан быть устойчивым к повтору
    retry: true,        // или объект политики; нельзя совмещать с reuse
    maxAttempts: 5,
  },
);
```

При заданной политике повторами тела владеет ORM: между попытками — bounded backoff с jitter, повторяются только транзитные статусы, `timeout` по-прежнему действует на каждую попытку (свежее окно), глобальный `signal` и `idempotent` пробрасываются в SDK как раньше. Без опции `retry` поведение прежнее (#98): тело ретраит только SDK.

#### Классификация ошибок

Структурная — по статус-кодам YDB (`@ydbjs/error`), текст сообщений не анализируется:

- **повторяются только** `ABORTED`, `UNAVAILABLE`, `OVERLOADED` (и `CommitError`, в причине которого такой статус);
- всё остальное пробрасывается немедленно: детерминированные ошибки приложения/валидации/схемы, включая статусы, которые SDK ретраит сам (`BAD_SESSION`, `SESSION_BUSY`, `SESSION_EXPIRED`, `UNDETERMINED`, `TIMEOUT`);
- при исчерпании попыток наружу выходит **последняя исходная ошибка** как есть.

**Задержка** перед попыткой N: `min(baseDelayMs * 2^(N-1), maxDelayMs)`, затем jitter сжимает её в коридор `[(1 - jitterRatio) * raw, raw]`. Дефолты: `maxAttempts: 3`, `baseDelayMs: 100`, `maxDelayMs: 5000`, `jitterRatio: 0.25`. Для тестов инъецируются `sleep(ms, signal)` и `rng()`.

**Требования идемпотентности** — те же, что у `idempotent`-транзакций (#98): при повторе заново выполняется вся операция (колбэк/запрос), побочные эффекты и lifecycle hooks могут сработать больше одного раза. Отмена (`signal.reason`) не превращается в повтор — операция завершается причиной отмены. Для запросов через executor действует правило идемпотентности выше: без явной пометки запрос не ретрается вовсе.

Для составных потоков вне транзакции доступна и явная обёртка:

```ts
import { runWithRetry } from '@ycforge/ydb-orm';

const result = await runWithRetry(async () => {
  const user = await UserEntity.find({ uuid }, {});
  const orders = await OrderEntity.findBy({ userId: user.uuid }, { limit: 50 });
  return buildReport(user, orders);
}, { maxAttempts: 5 });
```

Не вкладывайте `runWithRetry()` внутрь уже покрытых политикой executor'а/`runInTransaction()` — это то самое перемножение, которое встроенные интеграции исключают. Точка расширения для нестандартных обёрток ошибок — `shouldRetry(error)`; утилиты `classifyYdbError()` / `isTransientYdbError()` доступны отдельно.


## Логирование запросов

### Standalone

```ts
import { createExecutor, createDriver, ConsoleQueryLogger } from '@ycforge/ydb-orm';
import { createAuth, authKeyFromFile } from '@ycforge/auth';

const driver = createDriver({
  endpoint: '...',
  auth: createAuth(authKeyFromFile('./authorized_key.json')),
});

const executor = createExecutor(driver, {
  logQueries: true, // ConsoleQueryLogger по умолчанию
});
```

### NestJS

```ts
YdbCoreModule.forRootAsync({
  useFactory: () => ({
    endpoint: '...',
    auth: createAuth(authKeyFromFile('./authorized_key.json')),
    logQueries: true,
    // logQueries: myLogger, // или свой экземпляр QueryLogger
  }),
});
```

- `logQueries: true` — используется `ConsoleQueryLogger` (вывод `[YDB] QUERY <ms>` с SQL и замаскированными параметрами).
- `logQueries: <QueryLogger>` — собственный логгер: интерфейс `QueryLogger { log(entry: QueryLogEntry): void }`. `QueryLogEntry` содержит `sql`, `paramNames`, `maskedParams` (все значения маскируются), `durationMs` и опциональную `error`.
- Утилита `wrapExecutorWithLogging(executor, logger)` позволяет обернуть executor логированием вручную — она же логирует каждый запрос внутри `runInTransaction`.
- Маскирование параметров: секреты/PII по имени параметра (`password`, `token`, `secret`, `authorization`, `email`, credential, phone, card, blind index `{field}_bi` и т.п.) заменяются на `<redacted>` для значений любой длины; бинарные/зашифрованные данные логируются только длиной (`<bytes:N>`); остальные длинные строки обрезаются до 64 символов.

## Аутентификация

Аутентификация делегируется пакету [`@ycforge/auth`](https://github.com/ycforge/auth):
`ydb-orm` больше не реализует собственные стратегии и не парсит env-переменные
типа `YDB_AUTH_TYPE`. Все способы входа описываются через `AuthManager`, который
передаётся в опцию `auth`:

```ts
import { createAuth, authKeyFromFile } from '@ycforge/auth';

// authorized key сервисного аккаунта
const auth = createAuth(authKeyFromFile('./authorized_key.json'));

// или другие стратегии:
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

`AuthManager` адаптируется в `CredentialsProvider` через
`createYdbCredentialsProvider(auth, YDB_AUTH_USAGE, options)` из
`@ycforge/auth/ydb` (ORM делает это автоматически). Для стратегии `static`
адаптеру нужен `endpoint` модуля.

### Вместе с `@ycforge/auth/nestjs`

Если в проекте уже используется `@ycforge/auth/nestjs`, можно создать
`AuthManager` в DI и передать его в ORM (NestJS):

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
      inject: [YcAuthModule], // или токен YCFORGE_AUTH
    }),
  ],
})
export class AppModule {}
```

### Кастомный CredentialsProvider

Готовый провайдер можно передать напрямую — опция `credentialsProvider`
(тип `CredentialsProvider` из `@ydbjs/auth`, реэкспортирован из пакета):

```ts
import { CredentialsProvider } from '@ycforge/ydb-orm';
import { createDriver } from '@ycforge/ydb-orm';

class OAuthTokenProvider extends CredentialsProvider {
  getToken(): Promise<string> {
    return fetchOAuthToken(); // ваша реализация получения токена
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

Провайдер также доступен для инжекции через DI-токен `YDB_CREDENTIALS_PROVIDER`
(экспортируется из подпакета `nest`). Приоритет источников провайдера детерминирован:

1. `credentialsProvider` — явная опция модуля;
2. `auth` — `AuthManager` из `@ycforge/auth`;
3. DI-провайдер `YDB_CREDENTIALS_PROVIDER`;
4. `driverOptions.credentialsProvider`.

Задание одновременно `driverOptions.credentialsProvider` и верхнеуровневого
источника (`credentialsProvider` или `auth`) — ошибка конфигурации
(`Conflicting YDB credentials configuration`): молчаливый выбор одного из них
не выполняется. Если ни `auth`, ни `credentialsProvider`, ни инжектированный
провайдер не заданы — `ydb-orm` бросает `YDB auth is required: pass "auth"`
(AuthManager) or a CredentialsProvider`.

---

## Миграции

По аналогии с TypeORM: миграция — класс с `up`/`down`, получающий `YdbExecutor`. Применённые миграции хранятся в таблице `ydb_migrations` (создаётся автоматически). Файлы миграций — `<timestamp>-<Name>.ts` в директории `./migrations`, порядок выполнения — по имени файла. Node ≥ 22.18 импортирует `.ts` напрямую, отдельный ts-node не нужен. Из-за нативного стриппинга типы (`YdbMigration`, `YdbExecutor`) импортируйте через `import type` — обычный именованный импорт типа упадёт в рантайме.

Надёжность выполнения (#101):

- **Стабильная идентичность**: каждая миграция получает SHA-256 содержимого файла (`migration.hash`). Сопоставление с `ydb_migrations` идёт по хешу, поэтому переименование файла не приводит к повторному применению; изменение содержимого уже применённой миграции — ошибка (нужен явный reconcile). Дубликаты имён/содержимого во входном списке завершаются понятной ошибкой.
- **Частичное применение**: DDL в YDB не транзакционен, поэтому перед `up()`/`down()` пишется маркер `state='started'`, который заменяется на `'applied'` только после успеха. Падение посреди миграции оставляет маркер: повторный `run()` не начнёт её заново вслепую, а `revert()` откажется откатывать такую запись, пока её состояние не разрешат явно — `runner.markMigrationApplied(name)` (изменения дозаведены вручную) или `runner.removeMigrationRecord(name)` (изменения откачены вручную). В CLI то же самое: `ydb-orm migration:repair <name> --as-applied|--as-reverted`.
- **Параллельные запуски**: claim на применение — INSERT строки с id, детерминированным из хеша миграции. Два процесса, стартовавшие одну миграцию, сталкиваются на PRIMARY KEY: второй падает с понятной ошибкой до выполнения `up()` — двойное применение невозможно без внутрипроцессных локов.
- **`migration:show`** показывает orphan-записи (`[!]` — применена, но файла миграции больше нет), прерванные (`[~]`) и изменённые после применения (`[#]`).

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

### CLI

Пакет ставит бинарь `ydb-orm`:

```bash
ydb-orm migration:create CreateUsers      # пустая миграция ./migrations/<ts>-CreateUsers.ts
ydb-orm migration:generate AddPhotos      # миграция по diff сущностей и БД
ydb-orm migration:run                     # применить все новые миграции
ydb-orm migration:revert                  # откатить последнюю
ydb-orm migration:show                    # статус миграций (алиас — migration:status)
ydb-orm migration:check                   # проверка готовности для CI (exit != 0, если не готово)
ydb-orm migration:repair 1755000000000-CreateUsers --as-applied   # прерванная миграция дозаведена вручную
ydb-orm entity:create UserProfile         # сущность ./src/user-profile.entity.ts
ydb-orm metadata:dump                     # метаданные сущностей в JSON (stdout, без БД)
ydb-orm entity:diagram                    # Mermaid ER-диаграмма по метаданным (stdout/--output, без БД)
ydb-orm completion bash                   # скрипт shell-автодополнения (bash|zsh|fish)
```

Опции: `--dir <path>` (директория миграций, по умолчанию `./migrations`; для `entity:create` — `./src`), `--config <path>`, `--output <file>` (для `entity:diagram`; существующий файл не перезаписывается), `--json` (для `migration:show`/`migration:status`/`migration:check`), `--verbose` (полный стек ошибки и цепочка cause при сбое). Неизвестные флаги и пустые значения опций считаются ошибкой.

#### Проверка готовности (#152)

`migration:check`, `migration:status` и `migration:show` используют единый **read-only** workflow: команды только читают состояние (`DescribeTable` для `ydb_migrations` + голый `SELECT` записей; для сущностей — `DescribeTable`) и ничего не меняют — в частности, таблица учёта **не создаётся и не изменяется** (никакого `CREATE TABLE`/`ALTER TABLE`). Различимые состояния:

| Состояние      | Exit-код | Значение |
| -------------- | -------- | -------- |
| готово         | 0        | все миграции применены; схема совпадает, если проверялась |
| `pending`      | 1        | есть неприменённые миграции |
| `interrupted`  | 2        | есть прерванные миграции (`state='started'`, #101): прошлый запуск оборвался посреди миграции, БД может быть частично изменена |
| `schema-drift` | 3        | схема БД расходится с метаданными сущностей (проверяется только если в конфиге задан массив `entities`) |
| `modified`     | 4        | содержимое применённой миграции изменилось после применения (#101) |
| ошибка команды | 5        | не удалось подключиться/прочитать состояние/неожиданный сбой |

Прерванные и изменённые миграции явно НЕ считаются успешно применёнными; orphan-записи (файл удалён после применения) выводятся в отчёте, но сами по себе готовность не ломают. При нескольких состояниях exit-код выбирается по приоритету: `interrupted` → `modified` → `pending` → `schema-drift`.

Если таблица учёта `ydb_migrations` ещё не существует (свежая база), она не создаётся: считается, что не применено ничего — при наличии файлов миграций это pending (exit 1), без них — готово (exit 0). В `--json` такое состояние различается полем `bookkeeping: {exists: false}`; легаси-таблицы без колонок `hash`/`state` читаются как есть, без ALTER.

Текстовый режим: сводка/список — в stdout, проблемы и diff схемы — в stderr, итоговая строка начинается с `Up to date:` или `Not ready:`. Цвет diff определяется по реальному потоку вывода и отключается вне TTY и по `NO_COLOR`. Для машинного разбора используйте `--json`: весь отчёт — в stdout со стабильной схемой (`ready`, `state`, `states`, `exitCode`, `pending`/`interrupted`/`modified`/`orphaned`, детальный массив `migrations` и блок `schema` со списком issues); не полагайтесь на цвет и формулировки текстового вывода.

#### Интерактивный `entity:create` (#24)

В TTY команда запускает мастер генерации сущности: имя таблицы → колонки
(имя → тип YDB → PK / `@YdbEncrypted` + blind index / `@YdbEnum` со значениями и хранилищем /
`@YdbCreateDateColumn`/`@YdbUpdateDateColumn`) → опциональный TTL (`@YdbTtl`, ISO 8601 duration,
для date-like колонок) → предпросмотр и подтверждение записи.

Гарантии:

- все введённые определения валидируются **до** записи файла (имя таблицы, имена свойств,
  наличие PK, значения enum, типы date-колонок, интервал TTL);
- существующий файл никогда не перезаписывается — коллизия завершается ошибкой до старта вопросов;
- отмена (Ctrl+C) и EOF (Ctrl+D) — чистый выход (exit-код 130), файл не создаётся;
- никаких обращений к БД и DDL — только локальная генерация файла;
- вне TTY (CI, скрипты, закрытый stdin) ввод не читается вовсе: детерминированно создаётся
  шаблон по умолчанию (`uuid` PK + `name`), команда не зависает.

Программная генерация (для скриптов и инструментов) — через публичный API:

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

Также экспортируются `validateEntitySpec`, `renderEntityFile`, `buildDefaultEntitySpec`,
`runEntityCreateCommand`/`runEntityCreateWizard` (интерактивный мастер над произвольными
потоками ввода/вывода).

`migration:generate` и `schema:verify` печатают цветной diff расхождений «сущности vs БД», сгруппированный по таблицам; цвет определяется по потоку, куда попадает вывод (для `schema:verify` это stderr), отключается при выводе не в TTY или переменной `NO_COLOR`.

#### Экспорт метаданных: `metadata:dump` (#37)

Read-only команда выгружает метаданные сущностей из конфига (`entities`, как у `migration:generate`) в детерминированный JSON — **без подключения к БД**: ни драйвер, ни executor, ни DDL не задействуются. Команда по природе JSON-only (весь дамп — в stdout), отдельного текстового режима нет.

```bash
ydb-orm metadata:dump
```

Формат версионируется (`format`/`version`); для каждой сущности выгружаются:

- имя класса и таблицы; колонки с YDB-типами (включая synthetic `{field}_bi` blind-index-колонки) и PK с порядком колонок;
- связи всех типов: тип, целевая сущность/таблица, join-колонка, обратное свойство (`inverseProperty`), для many-to-many — ссылка на join-таблицу; физические описания join-таблиц — отдельным списком `joinTables` (колонки, типы из фактических PK, владелец);
- индексы (имя, колонки с учётом порядка, unique) и TTL (колонка, ISO 8601 interval, unit);
- шифрование без секретов: только декларативные флаги полей (blind index + имя `_bi`-колонки, lazy, aadOverride) и AAD-поля PK; провайдеры, ключи и runtime-материал не экспортируются никогда;
- enum-метаданные (значения в семантическом порядке, storage), JSON-колонки и eager-связи.

Детерминированность: стабильный порядок сущностей (по имени таблицы), колонок, индексов, связей и ключей JSON — повторный запуск даёт побайтово одинаковый вывод. Наследование следует правилам #92/#107: собственные `@YdbIndex`/`@YdbTtl` не наследуются, колонки/PK/шифрование/eager наследуются. Невалидные метаданные (класс без `@YdbEntity`, дубликат таблицы, отсутствие PK, конфликтующие join-таблицы #139, невалидный селектор join-колонки #87, несовместимый TTL) роняют команду с понятной ошибкой до какого-либо вывода.

Программный API для внешних инструментов: `buildMetadataDump(entities)` (+ типы `MetadataDump` и др.) экспортируется из пакета.

#### Mermaid ER-диаграмма: `entity:diagram` (#36)

Read-only команда рендерит те же канонические метаданные (тот же источник, что у `metadata:dump`, — `buildMetadataDump`) в Mermaid ER-диаграмму — **без подключения к БД**. Валидные метаданные обязательны: любая ошибка конфигурации роняет команду до первого байта вывода.

```bash
ydb-orm entity:diagram                    # Mermaid-текст в stdout
ydb-orm entity:diagram --output docs/schema.mmd   # в файл (перезапись запрещена)
```

Что на диаграмме:

- все сущности из `entities` конфига — блоками с колонками и YDB-типами; PK-колонки идут первыми **в порядке объявления** (порядок составного PK значим, #89) с маркером `PK`;
- связи one-to-many / many-to-one по одной join-колонке дают одну линию `||--o{`; однонаправленный one-to-many рисуется от родителя; one-to-one — `||--o|`; FK-колонки помечены `FK`;
- many-to-many — через физическую join-таблицу (#90/#139): отдельный блок с обеими колонками (`PK, FK`) и двумя линиями владелец → join → обратная сторона;
- детерминизм: порядок блоков/линий стабилен и не зависит от порядка входного списка — повторный запуск даёт побайтово одинаковый вывод;
- безопасные имена: имена таблиц и метки связей всегда в кавычках, недопустимые для атрибутов Mermaid имена колонок санитизируются, а оригинал сохраняется комментарием.

Программный API: `buildEntityDiagram(entities)` и `writeDiagramFile(path, diagram)` экспортируются из пакета.

Автодополнение команд и флагов для шелла:

```bash
# bash
ydb-orm completion bash | sudo tee /etc/bash_completion.d/ydb-orm
# zsh (путь из $fpath)
ydb-orm completion zsh > ~/.zsh/completions/_ydb-orm
# fish
ydb-orm completion fish > ~/.config/fish/completions/ydb-orm.fish
```

Конфиг подключения — `./ydb-orm.config.ts` (или `.mts`/`.mjs`/`.js`; ищется в текущей директории и выше, до корня ФС; поддерживается как default, так и именованный экспорт):

```ts
import { createAuth, authKeyFromFile } from '@ycforge/auth';
import { UserEntity } from './src/user.entity.js';

export default {
  endpoint: process.env.YDB_ENDPOINT!,
  auth: createAuth(authKeyFromFile('./authorized_key.json')),
  entities: [UserEntity],        // нужно для migration:generate
  migrationsDir: './migrations', // опционально
};
```

Без конфига CLI читает `YDB_ENDPOINT` (или `YDB_CONNECTION_STRING`), но для задания `auth` всё равно потребуется `ydb-orm.config.ts`.

`migration:generate` строит diff по всем `entities` из конфига: нет таблицы → `CREATE TABLE` (+ `DROP TABLE` в `down`), нет колонок → `ADD COLUMN` (+ `DROP COLUMN` в `down`). Расхождения типа/PK и лишние колонки не меняются автоматически — попадают в миграцию как `WARNING`-комментарии.

Если расхождение выглядит как переименование (ровно одна лишняя колонка БД и одна новая колонка сущности с тем же типом, без участия PK/индексов/TTL/blind-index), генератор не делает ADD/DROP молча: в `up()`/`down()` добавляется комментарий-подсказка вида `ALTER TABLE ... RENAME COLUMN ... TO ...`, а применение остаётся ручным — YQL пока не поддерживает `RENAME COLUMN`. При неоднозначности (несколько кандидатов, ключевые колонки, метаданные шифрования) поведение прежнее: `ADD COLUMN` + `WARNING`.

### Программный API

`YdbMigrationRunner` (run/revert/status, восстановление после сбоев — `markMigrationApplied`/`removeMigrationRecord`), `loadMigrationsFromDir`, `planMigration`, `executeSql` экспортируются из пакета — можно встроить миграции в свой пайплайн.

---

## Разработка

```bash
yarn install
yarn build        # tsc → dist/ (ESM + .d.ts)
yarn test         # jest (ESM), unit + NestJS-интеграционные тесты
yarn lint         # eslint --fix
yarn format       # prettier --write
```

Тесты не ходят в сеть: NestJS-интеграционные тесты (`test/nestjs/`) подменяют `YDB_DRIVER` / `YDB_QUERY` через `overrideProvider`.

## Замечания

- Версия `@bufbuild/protobuf` запинена на `2.12.0`: на `^` ломается типизация `anyUnpack` из-за расхождения branded-типов с `@ydbjs/*`.
- Запросы к YDB параметризованы (`query.parameter(...)`) — значения никогда не конкатенируются в SQL.
