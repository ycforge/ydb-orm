# NestJS и ydb-orm в serverless

Проверяемая сборка: `yarn test:package` из корня репозитория. Команда сначала
собирает библиотеку, затем компилирует пример через tsc с
`experimentalDecorators` и **`emitDecoratorMetadata: true`**, после чего
передаёт JavaScript в esbuild. Smoke-тест создаёт настоящий Nest application
context и проверяет constructor DI; подключения к БД не требуется.

Сборка TypeScript напрямую через esbuild не создаёт `design:paramtypes`.
Используйте tsc перед esbuild или явные `@Inject(TOKEN)` для **всех** параметров
DI. Вариант с tsc проверяется в CI на Node 22.18 и 24.

В `scripts/package-smoke.mjs` задано `packages: 'external'`. Поэтому зависимости
Nest, class-transformer и optional transports не разрешаются внутри bundle:
не нужны alias для `class-transformer/storage` и установка неиспользуемых
`@nestjs/microservices`/`@nestjs/websockets`. Вместе с bundle поставляйте
production node_modules и package.json (`type: module`). Это намеренно не
самодостаточный однофайловый bundle.

Для проекта-потребителя:

```sh
yarn tsc -p tsconfig.build.json
yarn esbuild dist/main.js --bundle --platform=node --target=node22 \
  --format=esm --packages=external --outfile=package/main.mjs
# В package/ также положите package.json и production node_modules.
```

Handler платформы и HTTP-адаптер подключаются отдельно: пример проверяет сборку
и DI ORM/Nest, а не интеграцию с конкретным коннектором облачных функций.
Используйте базовый образ Node **22.18 или новее**, например `node:22.18.0-slim`.
Node 20.19 может поддерживать require(esm), но это не означает поддержку всех
API Node, используемых библиотекой и SDK. Требование engines не понижается.
