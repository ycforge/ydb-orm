import { Type_PrimitiveTypeId } from '@ydbjs/api/value';
import {
  ExpectedTableSchema,
  YdbTableDescription,
} from '../schema/schema-sync.js';
import { planMigration, renderMigrationFile } from './migration-generator.js';

const expected: ExpectedTableSchema = {
  tableName: 'photos',
  columns: { uuid: 'Uuid', title: 'Utf8', width: 'Int32' },
  primaryKey: ['uuid'],
  indexes: [],
};

const withIndexes: ExpectedTableSchema = {
  ...expected,
  indexes: [
    { name: 'photos__title', columns: ['title'], unique: false },
    {
      name: 'photos__title_width',
      columns: ['title', 'width'],
      unique: false,
    },
  ],
};

const description = (
  columns: [string, Type_PrimitiveTypeId][],
  primaryKey: string[] = ['uuid'],
  extra: Partial<YdbTableDescription> = {},
): YdbTableDescription => ({ columns: new Map(columns), primaryKey, ...extra });

describe('planMigration', () => {
  it('plans CREATE TABLE when the table is missing', () => {
    const plan = planMigration([expected], [null]);

    expect(plan.up).toHaveLength(1);
    expect(plan.up[0]).toContain('CREATE TABLE `photos`');
    expect(plan.up[0]).toContain('PRIMARY KEY (`uuid`)');
    expect(plan.down).toEqual(['DROP TABLE `photos`']);
    expect(plan.warnings).toEqual([]);
  });

  it('plans ADD COLUMN / DROP COLUMN for missing columns', () => {
    const plan = planMigration(
      [expected],
      [description([['uuid', Type_PrimitiveTypeId.UUID]])],
    );

    expect(plan.up).toEqual([
      'ALTER TABLE `photos` ADD COLUMN `title` Utf8, ADD COLUMN `width` Int32',
    ]);
    expect(plan.down).toEqual([
      'ALTER TABLE `photos` DROP COLUMN `width`',
      'ALTER TABLE `photos` DROP COLUMN `title`',
    ]);
  });

  it('warns on type mismatch and extra columns instead of changing them', () => {
    const plan = planMigration(
      [expected],
      [
        description([
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['title', Type_PrimitiveTypeId.INT32],
          ['width', Type_PrimitiveTypeId.INT32],
          ['legacy', Type_PrimitiveTypeId.UTF8],
        ]),
      ],
    );

    expect(plan.up).toEqual([]);
    expect(plan.down).toEqual([]);
    expect(plan.warnings.some((w) => w.includes('type mismatch'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('extra column "legacy"'))).toBe(
      true,
    );
  });

  it('warns on primary key mismatch', () => {
    const plan = planMigration(
      [expected],
      [
        description(
          [
            ['uuid', Type_PrimitiveTypeId.UUID],
            ['title', Type_PrimitiveTypeId.UTF8],
            ['width', Type_PrimitiveTypeId.INT32],
          ],
          ['uuid', 'title'],
        ),
      ],
    );

    expect(plan.up).toEqual([]);
    expect(plan.warnings.some((w) => w.includes('primary key mismatch'))).toBe(
      true,
    );
  });

  it('plans nothing when schema matches', () => {
    const plan = planMigration(
      [expected],
      [
        description([
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['title', Type_PrimitiveTypeId.UTF8],
          ['width', Type_PrimitiveTypeId.INT32],
        ]),
      ],
    );

    expect(plan.up).toEqual([]);
    expect(plan.down).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it('plans CREATE INDEX in up and DROP INDEX in down for missing indexes (#88)', () => {
    const plan = planMigration(
      [withIndexes],
      [
        description([
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['title', Type_PrimitiveTypeId.UTF8],
          ['width', Type_PrimitiveTypeId.INT32],
        ]),
      ],
    );

    expect(plan.up).toEqual([
      'ALTER TABLE `photos` ADD INDEX `photos__title` GLOBAL SYNC ON (`title`)',
      'ALTER TABLE `photos` ADD INDEX `photos__title_width` GLOBAL SYNC ON (`title`, `width`)',
    ]);
    // down в обратном порядке: индексы удаляются до прочих откатов
    expect(plan.down).toEqual([
      'ALTER TABLE `photos` DROP INDEX `photos__title_width`',
      'ALTER TABLE `photos` DROP INDEX `photos__title`',
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it('plans UNIQUE index DDL for missing unique indexes (#88)', () => {
    const plan = planMigration(
      [
        {
          ...expected,
          indexes: [
            { name: 'photos__title_uq', columns: ['title'], unique: true },
          ],
        },
      ],
      [
        description([
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['title', Type_PrimitiveTypeId.UTF8],
          ['width', Type_PrimitiveTypeId.INT32],
        ]),
      ],
    );

    expect(plan.up).toEqual([
      'ALTER TABLE `photos` ADD UNIQUE INDEX `photos__title_uq` GLOBAL SYNC ON (`title`)',
    ]);
    expect(plan.down).toEqual([
      'ALTER TABLE `photos` DROP INDEX `photos__title_uq`',
    ]);
  });

  it('never drops extra indexes and warns instead (#88)', () => {
    const plan = planMigration(
      [withIndexes],
      [
        description(
          [
            ['uuid', Type_PrimitiveTypeId.UUID],
            ['title', Type_PrimitiveTypeId.UTF8],
            ['width', Type_PrimitiveTypeId.INT32],
          ],
          ['uuid'],
          {
            indexes: [
              { name: 'legacy_index', columns: ['uuid'], unique: false },
              { name: 'photos__title', columns: ['title'], unique: false },
              {
                name: 'photos__title_width',
                columns: ['title', 'width'],
                unique: false,
              },
            ],
          },
        ),
      ],
    );

    expect(plan.up).toEqual([]);
    expect(plan.down).toEqual([]);
    expect(plan.warnings).toEqual([
      'Table "photos" has extra index "legacy_index" — not dropped automatically',
    ]);
  });

  it('only diagnoses mismatches of existing indexes (#88)', () => {
    const plan = planMigration(
      [withIndexes],
      [
        description(
          [
            ['uuid', Type_PrimitiveTypeId.UUID],
            ['title', Type_PrimitiveTypeId.UTF8],
            ['width', Type_PrimitiveTypeId.INT32],
          ],
          ['uuid'],
          {
            indexes: [
              { name: 'photos__title', columns: ['title'], unique: true },
              {
                name: 'photos__title_width',
                columns: ['width'],
                unique: false,
              },
            ],
          },
        ),
      ],
    );

    expect(plan.up).toEqual([]);
    expect(plan.down).toEqual([]);
    expect(plan.warnings.some((w) => w.includes('unique flag mismatch'))).toBe(
      true,
    );
    expect(
      plan.warnings.some(
        (w) =>
          w.includes('columns mismatch') &&
          w.includes('recreate the index manually'),
      ),
    ).toBe(true);
  });

  it('plans SET TTL in up and RESET TTL in down when DB has no TTL (#88)', () => {
    const ttlSchema: ExpectedTableSchema = {
      ...expected,
      ttl: { interval: 'PT2H', column: 'title' },
    };
    const plan = planMigration(
      [ttlSchema],
      [
        description([
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['title', Type_PrimitiveTypeId.UTF8],
          ['width', Type_PrimitiveTypeId.INT32],
        ]),
      ],
    );

    expect(plan.up).toEqual([
      'ALTER TABLE `photos` SET (TTL = Interval("PT2H") ON `title`)',
    ]);
    expect(plan.down).toEqual(['ALTER TABLE `photos` RESET (TTL)']);
    expect(plan.warnings).toEqual([]);
  });

  it('plans TTL replacement and restores old settings in down (#88)', () => {
    const ttlSchema: ExpectedTableSchema = {
      ...expected,
      ttl: { interval: 'P1D', column: 'title' },
    };
    const plan = planMigration(
      [ttlSchema],
      [
        description(
          [
            ['uuid', Type_PrimitiveTypeId.UUID],
            ['title', Type_PrimitiveTypeId.UTF8],
            ['width', Type_PrimitiveTypeId.INT32],
          ],
          ['uuid'],
          {
            ttl: {
              column: 'width_col',
              expireAfterSeconds: 7200,
              unit: 'seconds',
            },
          },
        ),
      ],
    );

    expect(plan.up).toEqual([
      'ALTER TABLE `photos` SET (TTL = Interval("P1D") ON `title`)',
    ]);
    // down восстанавливает прежние настройки TTL из DescribeTable
    expect(plan.down).toEqual([
      'ALTER TABLE `photos` SET (TTL = Interval("PT2H") ON `width_col` AS SECONDS)',
    ]);
  });

  it('restores fractional TTL exactly in down without rounding (#88)', () => {
    const ttlSchema: ExpectedTableSchema = {
      ...expected,
      ttl: { interval: 'P1D', column: 'title' },
    };
    const plan = planMigration(
      [ttlSchema],
      [
        description(
          [
            ['uuid', Type_PrimitiveTypeId.UUID],
            ['title', Type_PrimitiveTypeId.UTF8],
            ['width', Type_PrimitiveTypeId.INT32],
          ],
          ['uuid'],
          { ttl: { column: 'width_col', expireAfterSeconds: 1.5 } },
        ),
      ],
    );

    expect(plan.up).toEqual([
      'ALTER TABLE `photos` SET (TTL = Interval("P1D") ON `title`)',
    ]);
    // Регрессия микросекундной точности YDB Interval: прежняя конверсия
    // через secondsToIsoDuration округляла 1.5s до "PT2S" и ломала откат.
    // down обязан восстановить дробный TTL ровно ("PT1.5S").
    expect(plan.down).toEqual([
      'ALTER TABLE `photos` SET (TTL = Interval("PT1.5S") ON `width_col`)',
    ]);
  });

  it('does not reset extra TTL without entity metadata and warns (#88)', () => {
    const plan = planMigration(
      [expected],
      [
        description(
          [
            ['uuid', Type_PrimitiveTypeId.UUID],
            ['title', Type_PrimitiveTypeId.UTF8],
            ['width', Type_PrimitiveTypeId.INT32],
          ],
          ['uuid'],
          { ttl: { column: 'title', expireAfterSeconds: 7200 } },
        ),
      ],
    );

    expect(plan.up).toEqual([]);
    expect(plan.down).toEqual([]);
    expect(plan.warnings).toEqual([
      'Table "photos" has extra TTL on column "title" — not reset automatically',
    ]);
  });
});

describe('planMigration composite primary key order (#89)', () => {
  const composite: ExpectedTableSchema = {
    tableName: 'tenant_objects',
    columns: { tenant_id: 'Utf8', id: 'Uuid' },
    primaryKey: ['tenant_id', 'id'],
    indexes: [],
  };

  const compositeDescription = (primaryKey: string[]) =>
    description(
      [
        ['tenant_id', Type_PrimitiveTypeId.UTF8],
        ['id', Type_PrimitiveTypeId.UUID],
      ],
      primaryKey,
    );

  it('plans nothing for identical composite PKs', () => {
    const plan = planMigration(
      [composite],
      [compositeDescription(['tenant_id', 'id'])],
    );

    expect(plan.up).toEqual([]);
    expect(plan.down).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it('warns on reordered composite PK without generating DDL (#89)', () => {
    const plan = planMigration(
      [composite],
      [compositeDescription(['id', 'tenant_id'])],
    );

    expect(plan.up).toEqual([]);
    expect(plan.down).toEqual([]);
    // Ручная миграция вместо опасного автогенерируемого DDL
    expect(plan.warnings).toEqual([
      'Table "tenant_objects": primary key column order mismatch: ' +
        'expected [tenant_id, id], actual [id, tenant_id] — ' +
        'YDB cannot alter a primary key, manual migration required',
    ]);
  });

  it('lists missing and extra PK columns in the warning (#89)', () => {
    const plan = planMigration(
      [composite],
      [compositeDescription(['id', 'legacy_id'])],
    );

    expect(plan.up).toEqual([]);
    expect(plan.down).toEqual([]);
    expect(plan.warnings.some((w) => w.includes('missing [tenant_id]'))).toBe(
      true,
    );
    expect(
      plan.warnings.some((w) => w.includes('unexpected [legacy_id]')),
    ).toBe(true);
    expect(plan.warnings.every((w) => w.includes('manual migration'))).toBe(
      true,
    );
  });
});

describe('planMigration input validation (#102)', () => {
  it('rejects non-array inputs with a clear error', () => {
    const wrongExpected = () =>
      planMigration(
        expected as unknown as ExpectedTableSchema[],
        undefined as unknown as (YdbTableDescription | null)[],
      );
    expect(wrongExpected).toThrow(TypeError);
    expect(wrongExpected).toThrow(/"expected" must be an array/);

    const wrongExisting = () =>
      planMigration(
        [expected],
        null as unknown as (YdbTableDescription | null)[],
      );
    expect(wrongExisting).toThrow(TypeError);
    expect(wrongExisting).toThrow(/"existing" must be an array/);
  });

  it('rejects mismatched array lengths instead of matching positionally', () => {
    expect(() => planMigration([expected], [])).toThrow(
      /"expected" \(1\) and "existing" \(0\) must have the same length/,
    );
    expect(() => planMigration([], [null])).toThrow(
      /"expected" \(0\) and "existing" \(1\) must have the same length/,
    );
  });

  it('mentions the involved tables in the length-mismatch error', () => {
    expect(() => planMigration([expected], [])).toThrow(/photos/);
  });
});

/**
 * #23: вероятные переименования колонок в migration:generate.
 */
describe('planMigration: rename suggestions (#23)', () => {
  // Сущность переименовала label -> title (тип сохранён)
  const renameExpected: ExpectedTableSchema = {
    tableName: 'photos',
    columns: { uuid: 'Uuid', title: 'Utf8' },
    primaryKey: ['uuid'],
    indexes: [],
  };
  const dbWithLabel = description([
    ['uuid', Type_PrimitiveTypeId.UUID],
    ['label', Type_PrimitiveTypeId.UTF8],
  ]);

  it('emits a suggestion and suppresses ADD/DROP for a likely rename', () => {
    const plan = planMigration([renameExpected], [dbWithLabel]);

    expect(plan.suggestions).toEqual([
      'ALTER TABLE `photos` RENAME COLUMN `label` TO `title`',
    ]);
    // ADD для переименованной колонки не генерируется
    expect(plan.up).toEqual([]);
    expect(plan.down).toEqual([]);
    expect(
      plan.warnings.some((w) => w.includes('may have been renamed to "title"')),
    ).toBe(true);
    // Лишняя колонка по-прежнему честно числится лишней и не удаляется
    expect(plan.warnings.some((w) => w.includes('extra column "label"'))).toBe(
      true,
    );
  });

  it('does not guess with several candidates and keeps ADD/DROP', () => {
    const plan = planMigration(
      [
        {
          tableName: 'photos',
          columns: { uuid: 'Uuid', title: 'Utf8', flag: 'Bool' },
          primaryKey: ['uuid'],
          indexes: [],
        },
      ],
      [
        description([
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['label', Type_PrimitiveTypeId.UTF8],
          ['legacy_flag', Type_PrimitiveTypeId.BOOL],
        ]),
      ],
    );

    expect(plan.suggestions).toEqual([]);
    expect(plan.up).toEqual([
      'ALTER TABLE `photos` ADD COLUMN `title` Utf8, ADD COLUMN `flag` Bool',
    ]);
    expect(plan.down).toEqual([
      'ALTER TABLE `photos` DROP COLUMN `flag`',
      'ALTER TABLE `photos` DROP COLUMN `title`',
    ]);
    expect(plan.warnings.filter((w) => w.includes('renamed'))).toEqual([]);
  });

  it('keeps plain ADD/DROP behavior when types differ (unrelated add/drop)', () => {
    const plan = planMigration(
      [{ ...renameExpected, columns: { uuid: 'Uuid', title: 'Int32' } }],
      [dbWithLabel],
    );

    expect(plan.suggestions).toEqual([]);
    expect(plan.up).toEqual(['ALTER TABLE `photos` ADD COLUMN `title` Int32']);
    expect(plan.down).toEqual(['ALTER TABLE `photos` DROP COLUMN `title`']);
    expect(plan.warnings).toEqual([
      'Table "photos" has extra column "label" — not dropped automatically',
    ]);
  });

  it('does not treat PK changes as a rename (#23)', () => {
    const plan = planMigration(
      [{ ...renameExpected, primaryKey: ['uuid', 'title'] }],
      [
        description(
          [
            ['uuid', Type_PrimitiveTypeId.UUID],
            ['label', Type_PrimitiveTypeId.UTF8],
          ],
          ['uuid', 'label'],
        ),
      ],
    );

    expect(plan.suggestions).toEqual([]);
    // Подсказки нет — расхождение PK обрабатывается прежним путём:
    // колонка добавляется обычным ADD, PK требует ручной миграции.
    expect(plan.up).toEqual(['ALTER TABLE `photos` ADD COLUMN `title` Utf8']);
    expect(plan.down).toEqual(['ALTER TABLE `photos` DROP COLUMN `title`']);
    expect(plan.warnings.some((w) => w.includes('primary key mismatch'))).toBe(
      true,
    );
    expect(plan.warnings.some((w) => w.includes('renamed'))).toBe(false);
  });

  it('does not treat TTL changes as a rename (#23)', () => {
    const plan = planMigration(
      [
        {
          ...renameExpected,
          ttl: { interval: 'PT1H', column: 'title' },
        },
      ],
      [dbWithLabel],
    );

    expect(plan.suggestions).toEqual([]);
    // Обычный путь: ADD колонки + установка TTL из метаданных
    expect(plan.up).toEqual([
      'ALTER TABLE `photos` ADD COLUMN `title` Utf8',
      'ALTER TABLE `photos` SET (TTL = Interval("PT1H") ON `title`)',
    ]);
    expect(plan.down).toEqual([
      'ALTER TABLE `photos` RESET (TTL)',
      'ALTER TABLE `photos` DROP COLUMN `title`',
    ]);
  });

  it('does not treat index changes as a rename (#23)', () => {
    const plan = planMigration(
      [
        {
          ...renameExpected,
          indexes: [
            { name: 'photos__title', columns: ['title'], unique: false },
          ],
        },
      ],
      [dbWithLabel],
    );

    expect(plan.suggestions).toEqual([]);
    expect(plan.up).toEqual([
      'ALTER TABLE `photos` ADD COLUMN `title` Utf8',
      'ALTER TABLE `photos` ADD INDEX `photos__title` GLOBAL SYNC ON (`title`)',
    ]);
  });
});

describe('renderMigrationFile', () => {
  it('renders a migration class with up/down statements', () => {
    const content = renderMigrationFile(
      'CreatePhotos1000',
      '1000-CreatePhotos',
      {
        up: ['CREATE TABLE `photos` (`uuid` Uuid, PRIMARY KEY (`uuid`))'],
        down: ['DROP TABLE `photos`'],
        warnings: ['Table "photos": something odd'],
      },
    );

    expect(content).toContain('export class CreatePhotos1000');
    expect(content).toContain(`readonly name = "1000-CreatePhotos";`);
    expect(content).toContain(
      'await executeSql(executor, "CREATE TABLE `photos` (`uuid` Uuid, PRIMARY KEY (`uuid`))");',
    );
    expect(content).toContain(
      'await executeSql(executor, "DROP TABLE `photos`");',
    );
    expect(content).toContain('WARNING: Table "photos": something odd');
  });

  it('renders placeholder comments for an empty plan', () => {
    const content = renderMigrationFile('Empty1000', '1000-Empty', {
      up: [],
      down: [],
      warnings: [],
    });

    expect(content.match(/no statements — fill in manually/g)).toHaveLength(2);
  });

  it('#23: renders rename as a comment suggestion only — never executable', () => {
    const content = renderMigrationFile('RenameLabel1000', '1000-RenameLabel', {
      up: [],
      down: [],
      warnings: [
        'Table "photos" column "label" may have been renamed to "title" — ' +
          'ADD/DROP suppressed for this pair, see SUGGESTION in the generated migration',
      ],
      suggestions: ['ALTER TABLE `photos` RENAME COLUMN `label` TO `title`'],
    });

    // Подсказка видна в обоих направлениях и явно помечена как неприменённая
    expect(content).toContain(
      '// SUGGESTION (not applied automatically): possible column rename detected.',
    );
    expect(
      content.match(
        /\/\/ {3}ALTER TABLE `photos` RENAME COLUMN `label` TO `title`;/g,
      ),
    ).toHaveLength(2);
    // RENAME не исполняется автоматически
    expect(content.match(/await executeSql/g) ?? []).toHaveLength(0);
    // Плейсхолдер «no statements» не нужен — тело занято подсказкой
    expect(content).not.toContain('no statements');
  });

  it('#23: keeps executable statements alongside the suggestion block', () => {
    const content = renderMigrationFile('Mixed1000', '1000-Mixed', {
      up: [
        'ALTER TABLE `photos` ADD INDEX `photos__uuid` GLOBAL SYNC ON (`uuid`)',
      ],
      down: ['ALTER TABLE `photos` DROP INDEX `photos__uuid`'],
      warnings: [],
      suggestions: ['ALTER TABLE `photos` RENAME COLUMN `a` TO `b`'],
    });

    expect(content).toContain(
      'await executeSql(executor, "ALTER TABLE `photos` ADD INDEX',
    );
    expect(content).toContain(
      'await executeSql(executor, "ALTER TABLE `photos` DROP INDEX',
    );
    // Ни один executeSql не содержит RENAME COLUMN
    for (const line of content.split('\n')) {
      if (line.includes('await executeSql')) {
        expect(line.includes('RENAME COLUMN')).toBe(false);
      }
    }
  });
});
