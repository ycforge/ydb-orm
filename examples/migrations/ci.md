# CI: running migrations in GitHub Actions

Ниже пример workflow, который запускает миграции в CI. Цель — синхронизировать схему (или сгенерировать/применить миграции) как часть pipeline.

Пример (вставьте в .github/workflows/migrations.yml):

```yaml
name: Run DB migrations

on:
  push:
    branches: [ main ]

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '18'
      - name: Install deps
        run: npm ci
      - name: Configure secrets
        env:
          YDB_ENDPOINT: ${{ secrets.YDB_ENDPOINT }}
          YDB_TOKEN: ${{ secrets.YDB_TOKEN }}
      - name: Run migrations
        run: |
          # Пример: если у вас есть CLI команда для миграций
          npx ydb-orm migration:generate --out migrations/auto || true
          npx ydb-orm migration:migrate --yes

    # Рекомендации:
    # - Храните credentials в Secrets, используйте short-lived токены.
    # - Тестируйте миграции на staging перед prod.
```

Советы
- Не храните симметричные ключи/пароли в репозитории — используйте Secrets или KMS.
- В workflow можно добавлять шаги для предварительной проверки схемы и отката при ошибке.
