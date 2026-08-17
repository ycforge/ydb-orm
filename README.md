# @ycforge/ydb-orm

[![npm (scoped)](https://img.shields.io/npm/v/@ycforge/ydb-orm)](https://www.npmjs.com/package/@ycforge/ydb-orm)
[![NPM](https://img.shields.io/npm/l/@ycforge/ydb-orm)](./LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/ycforge/ydb-orm)](https://github.com/ycforge/ydb-orm/issues)

TypeORM-like ORM для [YDB (Yandex Database)](https://ydb.tech/) на TypeScript: Active Record, relations, шифрование полей с blind index, schema sync, транзакции и интеграция с NestJS.

Принципы: удобство, минимализм (по памяти и CPU) и функционал.

Runtime — Node.js ≥ 22, ESM (`"type": "module"`, `module: nodenext`). Драйвер — [`@ydbjs/*`](https://github.com/ydb-platform/ydb-js-sdk) (новое поколение SDK).

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

## Active Record

```ts
await UserEntity.find({ uuid });                    // одна запись или null
await UserEntity.findAll({ name: 'Ivan' }, { limit: 50, offset: 0 });
await UserEntity.count({ name: 'Ivan' });
await UserEntity.save(user);                        // insert (uuid генерируется) или update по uuid
await UserEntity.insertMany([u1, u2]);              // батчи по 100
await user.loadRelations(['roles']);
```

`QueryOptions`: `trx`, `timeout` (мс), `signal` (AbortSignal), `limit` (по умолчанию 100, макс 1000), `offset`.

## Декораторы

- `@YdbEntity('table')` — имя таблицы; класс попадает в глобальный реестр сущностей (используется schema sync).
- `@YdbColumn('Uuid' | 'Utf8' | 'Int32' | 'Int64' | 'Bool' | 'Double')` — колонка.
- `@YdbPrimaryColumn(type)` — колонка первичного ключа (поддерживается составной PK: несколько таких колонок). Если PK не объявлен, используется `uuid`.
- `@YdbEncrypted({ blindIndex })` — поле шифруется перед записью и дешифруется после чтения; `blindIndex: true` (по умолчанию) добавляет synthetic колонку `{field}_bi` для поиска по хешу.
- `@YdbSecurityAAD()` — незашифрованное поле участвует в AAD.
- `@OneToMany` / `@ManyToOne` / `@OneToOne` — relations; `@EagerLoad([...])` — batch-загрузка одним `IN (...)` запросом (без N+1).

## Шифрование

Провайдеры передаются в опции модуля:

```ts
{
  encryptionProvider: myEncryptionProvider,   // { encrypt(value, aad, ctx), decrypt(...) }
  blindIndexProvider: myBlindIndexProvider,   // { hash(value, ctx) }
}
```

`Base64TestEncryptionProvider` из пакета — заглушка для тестов, реальной криптографии в ней нет.

## Schema sync

`sync: true` в опциях `forRootAsync` при старте приложения подстраивает схему БД под метаданные всех зарегистрированных сущностей:

- нет таблицы → `CREATE TABLE`;
- нет колонок → `ALTER TABLE ADD COLUMN`;
- лишние колонки → только warn в лог (данные не удаляются);
- расхождение типа колонки или PK → ошибка (в YDB не меняется, нужна миграция).

Провайдер `YDB_SCHEMA_SYNC` экспортируется из модуля: `syncer.verify(entities)` проверяет схему без изменений. Генераторы DDL (`generateCreateTableYql` и т.д.) доступны в публичном API — их можно использовать для миграций.

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
