# AGENTS.md

## Обзор проекта

**@ycforge/ydb-orm** — TypeScript-библиотека (ESM): TypeORM-like ORM для **YDB (Yandex Database)** с интеграцией с NestJS. 

Ключевые возможности: Active Record (`YdbBaseEntity`), декораторы (`@YdbEntity`, `@YdbColumn`, `@YdbPrimaryColumn`, `@YdbEncrypted`, relations, `@EagerLoad`), шифрование полей с blind index, транзакции, schema sync (аналог `synchronize` в TypeORM).

Цель проекта — удобный, минималистичный (по памяти и CPU) и функциональный ORM для YDB. В разработке учитывай best-practices по TS, ORM и YDB (в т.ч. YQL), конфиги (в т.ч. eslint).

## Технологический стек

- **Runtime**: Node.js ≥ 22, ESM (`"type": "module"`, `module: nodenext` в tsconfig). Пакетный менеджер — **yarn**.
- **YDB**: драйвер `@ydbjs/core` + `@ydbjs/query` (новое поколение SDK, не `ydb-sdk`), аутентификация через `@ydbjs/auth` (`meta` | `auth_key` | `anonymous`).
- **NestJS**: `@nestjs/common` / `@nestjs/core` — **peerDependencies** (интеграция через `YdbCoreModule` / `YdbModule`); для тестов — `@nestjs/testing` (devDependency).
- **Протобуф**: `@ydbjs/api` + `@bufbuild/protobuf` (schema sync ходит в Table service `DescribeTable`). Версия `@bufbuild/protobuf` запинена ровно на `2.12.0` — на `^` ломается типизация `anyUnpack` из-за расхождения branded-типов с `@ydbjs/*`.
- **Тесты**: Jest 30 + ts-jest (ESM-режим, `NODE_OPTIONS=--experimental-vm-modules`); конфиг jest — в `package.json`.
- **Линт/форматирование**: ESLint 9 (flat config) + Prettier.

- `examples/` — примеры использования пакета (`01-basic-crud`, `02-relations`, `03-encryption`, `04-schema-sync`). В пакет не попадают, служат документацией и локальными smoke-тестами.

## Структура `src/` (публичный API — `src/index.ts`)

- `core/` — типы (`YdbPrimitive`), интерфейсы опций модуля (`YdbModuleOptions`, `YdbModuleAsyncOptions`, `YdbExecutor`), DI-токены (`constants.ts`), маппер TS→YDB, `quoteIdentifier`, `QueryOptions` (`trx`, `timeout`, `signal`, `limit`, `offset`).
- `decorators/` — `@YdbEntity('table')`, `@YdbColumn` / `@YdbPrimaryColumn` (составной PK поддерживается), `@YdbEncrypted({ blindIndex })`, `@YdbSecurityAAD()`, `@OneToMany` / `@ManyToOne` / `@OneToOne`, `@EagerLoad([...])` (batch одним `IN (...)`, без N+1). Метаданные декораторов — copy-on-write (наследники не портят метаданные родителя).
- `entity/base-entity.ts` — `YdbBaseEntity` (Active Record): статические `find`, `findAll` (limit по умолчанию 100, макс 1000), `count`, `save` (upsert/update по `uuid`), `insertMany` (батчи по 100), `loadRelations`. PK по умолчанию — `uuid`, автогенерация через `uuid` v4. Рантайм-зависимости (executor, провайдеры шифрования) — в `entity/entity-runtime.ts` (WeakMap по классу, наследники не разделяют состояние).
- `encryption/` — интерфейсы `YdbEncryptionProvider` / `YdbBlindIndexProvider` (encrypt/decrypt с AAD, hash для blind index). **Внимание:** `Base64TestEncryptionProvider` — заглушка для тестов, реальной криптографии нет.
- `metadata/` — `entity-metadata.ts` (сбор метаданных из Reflect, кеш на класс) и `entity-registry.ts` (глобальный реестр сущностей: `@YdbEntity` регистрирует класс при загрузке файла; используется schema sync).
- `module/` — интеграция с NestJS:
  - `ydb-core.module.ts` — глобальный `YdbCoreModule.forRootAsync(...)` (`useFactory` / `useClass` / `useExisting`): `Driver`, `YdbExecutor` (через `query(driver)`), credentials provider по `auth_type` (невалидное значение — ошибка `Invalid YDB auth type`), опциональные encryption/blind-index провайдеры, schema sync.
  - `ydb.module.ts` — `YdbModule.forFeature([...Entity])`: через `repository-factory.ts` сущностям инжектируется executor и провайдеры шифрования (без `forFeature` статические методы упадут с «YDB executor not set»).
- `schema/schema-sync.ts` — генерация и проверка схемы БД (`YdbSchemaSyncer`): `sync: true` в опциях `forRootAsync` при старте создаёт недостающие таблицы (`CREATE TABLE`) и колонки (`ALTER TABLE ADD COLUMN`) по метаданным всех зарегистрированных сущностей (включая synthetic `{field}_bi` колонки blind index). Описание таблицы — через Table service `DescribeTable` (query service метаданные колонок не отдаёт). Расхождение типа колонки или PK — ошибка (в YDB не меняется); лишние колонки не удаляются (только warn). Провайдер `YDB_SCHEMA_SYNC` экспортируется — `syncer.verify(entities)` проверяет схему без изменений. Каждая сущность обязана иметь PK-колонку (`@YdbPrimaryColumn` или `uuid`), иначе sync упадёт с понятной ошибкой.
- `transaction/transaction.manager.ts` — `YdbTransactionManager.runInTransaction(fn)`; внутри транзакции методам сущностей передаётся `{ trx }` в `QueryOptions`.
- `credentials/auth-key-credentials-provider.ts` — обмен JWT на IAM-токен через `fetch` (без `@yandex-cloud/nodejs-sdk`), кеш с leeway 60с, защита от race condition.

## Тесты (`test/`)

- `test/fixtures/` — тестовые сущности (`UserEntity` + relations/encryption/eager, `UserRoleEntity` с составным PK, `PhotoEntity` со всеми примитивами YDB и blind index), импортируют библиотеку через публичный API (`../../../src/index.js`).
- `test/helpers/mock-executor.ts` — мок `YdbExecutor` (записывает SQL и параметры, резолвится заданными строками; result set = массив result sets, каждый — массив строк).
- `test/nestjs/` — **критичные интеграционные тесты использования через NestJS** (`Test.createTestingModule`): wiring модуля + Active Record, транзакции, шифрование через DI, schema sync при bootstrap. Сети нет: `YDB_DRIVER` / `YDB_QUERY` подменяются через `overrideProvider`.
- Unit-тесты лежат рядом с кодом (`src/**/*.spec.ts`, напр. `src/schema/schema-sync.spec.ts`).

Особенность: в ESM-режиме jest `jest` импортируется из `@jest/globals`.

## Команды

```bash
yarn install
yarn build        # tsc -p tsconfig.build.json → dist/ (ESM + .d.ts)
yarn test         # все тесты (unit + NestJS-интеграционные)
yarn test:cov     # с покрытием
yarn lint         # eslint --fix (src, test и examples)
yarn format       # prettier --write
```

CI/CD пока нет. Публикация: `prepublishOnly` запускает `yarn build`; в пакет попадает только `dist/` + `README.md` + `LICENSE`. Имя пакета — `@ycforge/ydb-orm`, `publishConfig.access` = `public`.

## Стиль кода и соглашения

- **Язык комментариев и документации — русский**; идентификаторы, сообщения ошибок и логи — на английском.
- Prettier: одинарные кавычки, `trailingComma: "all"` (см. `.prettierrc`).
- ESLint: `recommendedTypeChecked`; `no-explicit-any` выключен (any допустим), `no-floating-promises` — warn; неиспользуемые переменные с префиксом `_` разрешены.
- Относительные импорты внутри проекта всегда с расширением **`.js`** (`import { X } from './module.js'`) — требование ESM/`nodenext`; в jest это маппится через `moduleNameMapper`.
- Сущности наследуют `YdbBaseEntity`, декорируются `@YdbEntity`/`@YdbColumn`; колонки типизируются примитивами YDB (`Uuid`, `Utf8`, `Bool` и т.д.). Новую сущность-потребителя не забудьте добавить в `YdbModule.forFeature([...])`.
- Запросы к YDB параметризованы (`query.parameter(...)`) — сохраняйте этот паттерн, не конкатенируйте значения в SQL.
- `authorized_key.json` (ключ сервисного аккаунта YC) — секретный файл, в `.gitignore`; не коммитить, не выводить содержимое в код/логи/ответы. Это касается и `.env`.
