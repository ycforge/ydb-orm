# TODO — @ycforge/ydb-orm

Роадмап ведётся в **GitHub Issues**: https://github.com/ycforge/ydb-orm/issues

- Приоритеты и размеры — лейблы `priority:p0|p1|p2`, `size:S|M|L`, `backlog`, области — `area:*`.
- Майлстоуны: **v0.2** (ядро P0), **v0.3** (P1), **backlog** (P2 и «держим в голове»).
- Зависимости между задачами указаны в теле issue (номера соответствуют историческим номерам из брейншторма).

## Сделано

- ✅ **24. Поиск по зашифрованным полям** — `buildWhere` хеширует значение через `blindIndexProvider` и ищет по `{field}_bi`.
- ✅ **27. Скрытые BI-колонки в результатах** — `instantiate` исключает `{field}_bi` из инстанса.
- ✅ **86. `down` в миграциях** — `migration:create` генерирует заготовки up/down, `migration:generate` строит `down` зеркально.
- ✅ **7. Upsert по составному PK** — `save()` использует `UPSERT INTO`, атомарный по полному PK.
- ✅ **Relations: `@OneToOne`, `@ManyToMany` + `@JoinTable`** — декораторы, eager-loading, schema sync и `migration:generate` для join-таблиц.

## Удалено

- ❌ **20. Relations через JOIN** — отменено: JOIN ломает модель per-entity дешифровки, batch `IN (...)` остаётся основным механизмом.

Перед работой: прочитай `AGENTS.md` (конвенции: ESM-импорты с `.js`, тесты рядом с кодом, `import type` для типов, параметризация запросов, комментарии на русском).
