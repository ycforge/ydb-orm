# @ycforge/ydb-orm

[![npm (scoped)](https://img.shields.io/npm/v/@ycforge/ydb-orm)](https://www.npmjs.com/package/@ycforge/ydb-orm)
[![NPM](https://img.shields.io/npm/l/@ycforge/ydb-orm)](./LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/ycforge/ydb-orm)](https://github.com/ycforge/ydb-orm/issues)

TypeORM-like ORM для [YDB (Yandex Database)](https://ydb.tech/) на TypeScript: Active Record, relations, шифрование полей с blind index, schema sync, транзакции и интеграция с NestJS.

Принципы: удобство, минимализм (по памяти и CPU) и функционал.

Runtime — Node.js ≥ 22.18 (нативный импорт `.ts` через type stripping), ESM (`"type": "module"`, `module: nodenext`). Драйвер — [`@ydbjs/*`](https://github.com/ydb-platform/ydb-js-sdk) (новое поколение SDK).

## Установка

```bash
yarn add @ycforge/ydb-orm
# peer-зависимости, если используете NestJS-интеграцию:
yarn add @nestjs/common @nestjs/core reflect-metadata rxjs
```

## Быстрый старт (NestJS)

```ts
import { Module } from '@nestjs/common';
import { YdbCoreModule, YdbModule, YdbBaseEntity, YdbEntity, YdbPrimaryColumn, YdbColumn } from '@ycforge/ydb-orm';

@YdbEntity('users')
export class UserEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;
}

@Module({
  imports: [
    YdbCoreModule.forRootAsync({
      useFactory: () => ({
        endpoint: 'grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/...',
        auth_type: 'auth_key', // 'meta' | 'auth_key' | 'anonymous'
        authOptions: { authorized_key_path: './authorized_key.json' },
        sync: true, // как synchronize в TypeORM — только для dev!
      }),
    }),
    YdbModule.forFeature([UserEntity]),
  ],
})
export class AppModule {}
```

`forRootAsync` поддерживает `useFactory` / `useClass` / `useExisting` (как в NestJS). `forFeature([...Entity])` обязателен: без него статические методы сущности упадут с «YDB executor not set».

## Репозиторий (DI-вариант)

Помимо Active Record (`UserEntity.find(...)`) `YdbModule.forFeature` регистрирует инжектируемый `YdbRepository<Entity>`. Это удобнее в NestJS-сервисах и не требует глобальных статиков:

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository, YdbRepository } from '@ycforge/ydb-orm';
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

## Active Record

```ts
await UserEntity.find({ uuid });                    // одна запись или null
await UserEntity.findAll({ name: 'Ivan' }, { limit: 50, offset: 0 });
await UserEntity.count({ name: 'Ivan' });
await UserEntity.save(user);                        // insert (uuid генерируется, по умолчанию v7) или update по uuid
await UserEntity.insertMany([u1, u2]);              // батчи по 100
await user.loadRelations(['roles']);
```

`QueryOptions`: `trx`, `timeout` (мс), `signal` (AbortSignal), `limit` (по умолчанию 100, макс 1000), `offset`.

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

## Декораторы

- `@YdbEntity('table')` — имя таблицы; класс попадает в глобальный реестр сущностей (используется schema sync).
- `@YdbColumn('Uuid' | 'Utf8' | 'Bytes' | 'Int32' | 'Int64' | 'Bool' | 'Double' | 'Float' | 'Date' | 'Datetime' | 'Timestamp' | 'Json' | 'JsonDocument')` — колонка.
- `@YdbPrimaryColumn(type)` — колонка первичного ключа (поддерживается составной PK: несколько таких колонок). Если PK не объявлен, используется `uuid`.
- `@YdbEncrypted({ blindIndex, lazy })` — поле шифруется перед записью и дешифруется после чтения; `blindIndex: true` (по умолчанию) добавляет synthetic колонку `{field}_bi` для поиска по хешу. Шифротекст хранится в колонке `Bytes` (raw bytes), тип из `@YdbColumn` для таких полей игнорируется. Опция `lazy: true` откладывает дешифровку: поле не дешифруется при SELECT (экономия CPU), plaintext возвращают `await entity.decryptField('field')` / `await entity.decryptLazyFields()` (результат кешируется в инстансе); `toJSON()`/`JSON.stringify()` бросают ошибку, пока lazy-поля не дешифрованы.
- `@YdbSecurityAAD()` — незашифрованное поле участвует в AAD (может применяться только к PK-колонкам).
- `@YdbJson()` — поле хранится как JSON-строка в `Utf8`; ORM автоматически сериализует/парсит значения. Нативные `Json`/`JsonDocument` доступны через `@YdbColumn('Json')` / `@YdbColumn('JsonDocument')`.
- `@OneToMany` / `@ManyToOne` / `@OneToOne` / `@ManyToMany` — relations; `@EagerLoad([...])` — batch-загрузка одним `IN (...)` запросом (без N+1). `@ManyToMany` требует `@JoinTable('join_table_name')` на владеющей стороне; join-таблица попадает в schema sync и миграции автоматически.
- `@YdbIndex({ columns, name? })` — вторичный индекс (GLOBAL SYNC); класс-декоратор, можно несколько. Имя по умолчанию `{table}__{col1}_{col2}`. Попадает в CREATE TABLE при schema sync и в `migration:generate` для новых таблиц.

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

Провайдеры передаются в опции модуля:

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

`sync: true` в опциях `forRootAsync` при старте приложения подстраивает схему БД под метаданные всех зарегистрированных сущностей:

- нет таблицы → `CREATE TABLE`;
- нет колонок → `ALTER TABLE ADD COLUMN`;
- лишние колонки → только warn в лог (данные не удаляются);
- расхождение типа колонки или PK → ошибка (в YDB не меняется, нужна миграция).

Провайдер `YDB_SCHEMA_SYNC` экспортируется из модуля: `syncer.verify(entities)` проверяет схему без изменений. Генераторы DDL (`generateCreateTableYql` и т.д.) доступны в публичном API — их можно использовать для миграций.

## Миграции

По аналогии с TypeORM: миграция — класс с `up`/`down`, получающий `YdbExecutor`. Применённые миграции хранятся в таблице `ydb_migrations` (создаётся автоматически). Файлы миграций — `<timestamp>-<Name>.ts` в директории `./migrations`, порядок выполнения — по имени файла. Node ≥ 22.18 импортирует `.ts` напрямую, отдельный ts-node не нужен. Из-за нативного стриппинга типов типы (`YdbMigration`, `YdbExecutor`) импортируйте через `import type` — обычный именованный импорт типа упадёт в рантайме.

Надёжность выполнения (#101):

- **Стабильная идентичность**: каждая миграция получает SHA-256 содержимого файла (`migration.hash`). Сопоставление с `ydb_migrations` идёт по хешу, поэтому переименование файла не приводит к повторному применению; изменение содержимого уже применённой миграции — ошибка (нужен явный reconcile). Дубликаты имён/содержимого во входном списке завершаются понятной ошибкой.
- **Частичное применение**: DDL в YDB не транзакционен, поэтому перед `up()`/`down()` пишется маркер `state='started'`, который заменяется на `'applied'` только после успеха. Падение посреди миграции оставляет маркер: повторный `run()` не начнёт её заново вслепую, пока запись не разрешат явно — `runner.markMigrationApplied(name)` (изменения дозаведены вручную) или `runner.removeMigrationRecord(name)` (изменения откачены вручную). В CLI то же самое: `ydb-orm migration:repair <name> --as-applied|--as-reverted`.
- **Параллельные запуски**: claim на применение — INSERT строки с id, детерминированным из хеша миграции. Два процесса, стартовавшие одну миграцию, сталкиваются на PRIMARY KEY: второй падает с понятной ошибкой до выполнения `up()` — двойное применение невозможно без внутрипроцессных локов.
- **`migration:show`** показывает orphan-записи (`[!]` — применена, но файла миграции больше нет) и прерванные (`[~]`).

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
ydb-orm migration:show                    # статус миграций
ydb-orm migration:repair 1755000000000-CreateUsers --as-applied   # прерванная миграция дозаведена вручную
ydb-orm entity:create UserProfile         # сущность ./src/user-profile.entity.ts
ydb-orm completion bash                   # скрипт shell-автодополнения (bash|zsh|fish)
```

Опции: `--dir <path>` (директория миграций, по умолчанию `./migrations`; для `entity:create` — `./src`), `--config <path>`, `--json` (для `migration:show`/`migration:check`).

`migration:generate` и `schema:verify` печатают цветной diff расхождений «сущности vs БД», сгруппированный по таблицам; цвета отключаются при выводе не в TTY или переменной `NO_COLOR`.

Автодополнение команд и флагов для шелла:

```bash
# bash
ydb-orm completion bash | sudo tee /etc/bash_completion.d/ydb-orm
# zsh (путь из $fpath)
ydb-orm completion zsh > ~/.zsh/completions/_ydb-orm
# fish
ydb-orm completion fish > ~/.config/fish/completions/ydb-orm.fish
```

Конфиг подключения — `./ydb-orm.config.ts` (или `.mts`/`.mjs`/`.js`; также ищется в `./src/`):

```ts
import { UserEntity } from './src/user.entity.js';

export default {
  endpoint: process.env.YDB_ENDPOINT!,
  auth_type: 'auth_key',
  authOptions: { authorized_key_path: './authorized_key.json' },
  entities: [UserEntity],        // нужно для migration:generate
  migrationsDir: './migrations', // опционально
};
```

Без конфига CLI читает env: `YDB_ENDPOINT` (или `YDB_CONNECTION_STRING`), `YDB_AUTH_TYPE` (по умолчанию `anonymous`), `YDB_AUTHORIZED_KEY_PATH`.

`migration:generate` строит diff по всем `entities` из конфига: нет таблицы → `CREATE TABLE` (+ `DROP TABLE` в `down`), нет колонок → `ADD COLUMN` (+ `DROP COLUMN` в `down`). Расхождения типа/PK и лишние колонки не меняются автоматически — попадают в миграцию как `WARNING`-комментарии.

### Программный API

`YdbMigrationRunner` (run/revert/status, восстановление после сбоев — `markMigrationApplied`/`removeMigrationRecord`), `loadMigrationsFromDir`, `planMigration`, `executeSql` экспортируются из пакета — можно встроить миграции в свой пайплайн.

## Транзакции

```ts
constructor(private readonly txManager: YdbTransactionManager) {}

await this.txManager.runInTransaction(async (trx) => {
  const from = await UserEntity.find({ uuid: fromId }, { trx });
  await UserEntity.save(from, { trx });
});
```

## Аутентификация (`auth_type`)

- `meta` — IAM из metadata-сервиса (внутри Yandex Cloud);
- `auth_key` — authorized key JSON сервисного аккаунта (`authOptions.authorized_key_path`); JWT-обмен реализован на `fetch`, без тяжёлых SDK;
- `anonymous` — локальная YDB.

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
