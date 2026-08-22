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
});
