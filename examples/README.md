# Примеры использования @ycforge/ydb-orm

Здесь собраны готовые к запуску примеры работы с библиотекой: от простейшего
консольного сценария до миграций и интеграции с NestJS.

```
examples/
├── 01-users/          базовый пример: подключение, сохранение и чтение сущности
├── 02-crud/           полный CRUD: insertMany, updateBy, delete, deleteBy, count
├── 03-search/         поиск: find / findOneBy / findAll / findBy, пагинация
├── 04-relations/      связи: 1:N, N:1, 1:1, многие-ко-многим, eager/ленивая загрузка
├── 05-query-builder/  YdbQueryBuilder: AND/OR, сортировка, лимиты, проекция
├── 06-encryption/     шифрование полей, blind index, Security AAD, ленивая дешифровка
├── 07-transactions/   транзакции: runInTransaction, retry, ambient/reuse, таймауты
├── 08-schema-sync/    автосинхронизация схемы БД и проверка через YdbSchemaSyncer
├── 09-migrations/     миграции: runner, loader, пример конфига для CLI
├── 10-repository/     YdbRepository / YdbEntityManager без DI
├── 11-advanced/       продвинутые декораторы: enum, json, TTL, индексы, таймстампы, хуки
└── nestjs/            примеры интеграции с NestJS (подпакет @ycforge/ydb-orm/nest)
    ├── 01-crud/           модуль, Active Record и инжектируемый репозиторий
    ├── 02-transactions/   транзакции через YdbTransactionManager из DI
    ├── 03-encryption/     шифрование через DI-провайдеры
    └── 04-schema-sync/    sync: true при старте и ручная проверка схемы
```

Общие сущности и провайдеры лежат в `shared/`, каждый пример импортирует
только то, что ему нужно.

## Требования

- Node.js ≥ 22.18 и yarn.
- Собранный пакет (`yarn build`). Примеры после компиляции запускаются
  обычным Node против `dist/` — .ts-импорты внутри примеров (в т.ч. `../../src`)
  компилируются отдельным tsconfig'ом в `dist-examples/`.
- Для запуска против реальной БД нужен запущенный YDB. По умолчанию примеры
  рассчитаны на локальный Docker YDB: `grpc://localhost:2136/local` (anonymous).
  Можно переопределить через `YDB_ENDPOINT` и передать свой `auth`
  (см. `shared/options.ts`).

## Запуск

```bash
yarn install
yarn build                     # собрать dist/
yarn examples:build            # скомпилировать src + examples в dist-examples/
node dist-examples/examples/01-users/main.js
```

Каждый пример — исполняемый сценарий: подключается к БД, создаёт таблицы
(`sync: true` в DEV-режиме), прогоняет операции и печатает результат в консоль.
Примеры идемпотентны (чистят свои данные) настолько, насколько это уместно.

### Переменные окружения

- `YDB_ENDPOINT` — endpoint YDB (`grpc://localhost:2136/local` по умолчанию).
- `YDB_ORM_ENC_KEY` / `YDB_ORM_BI_KEY` — ключи шифрования (base64, по 32 байта),
  обязательны только для примеров, работающих с зашифрованными полями
  (`06-encryption`, `nestjs/03-encryption`).

## Миграции и CLI

Пример `09-migrations` показывает как программный runner, так и CLI-конфиг
(`ydb-orm.config.ts`). Команды CLI выполняются из каталога `examples/09-migrations`
(конфиг ищется в CWD и выше):

```bash
yarn build
yarn ydb-orm migration:status
yarn ydb-orm migration:run
yarn ydb-orm migration:revert
```

Для `migration:generate` добавьте массив `entities` в конфиг — сущности
должны быть доступны нативному `import()` (скомпилированный JS). Сгенерированная
миграция пишется в `migrationsDir`, заданный в конфиге.

## Структура одного примера

Каждый пример — самодостаточная папка:

- `main.ts` — точка входа: настройка подключения, `configureEntities`, сценарий.
- опционально собственные сущности/сервисы.

Для NestJS-примеров внутри папки лежит `app.module.ts` (корневой модуль),
сервисы и `main.ts`.

Комментарии в примерах — на русском, следуют соглашениям кодовой базы
(идентификаторы на английском).