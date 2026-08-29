/**
 * Конфиг CLI ydb-orm (пример 09).
 *
 * Используется интерактивным CLI: `yarn ydb-orm migration:run --config ...`
 * или автоматически находит ydb-orm.config.ts в CWD и выше. Примеры ниже
 * показывают и программный, и конфиг-подход.
 *
 * ВАЖНО: конфиг загружается нативным `import()` (Node ≥ 22.18 импортирует
 * .ts), поэтому здесь нельзя импортировать модули проекта, компилируемые
 * отдельно (src/). Только npm-пакеты (@ycforge/auth и т.п.).
 */
import { createAuth } from '@ycforge/auth';

export default {
  endpoint: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136/local',
  auth: createAuth({ type: 'anonymous' }),
  // Директория с миграциями для CLI-команд.
  migrationsDir: './examples/09-migrations/migrations',
};
