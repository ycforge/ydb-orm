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
};

const description = (
  columns: [string, Type_PrimitiveTypeId][],
  primaryKey: string[] = ['uuid'],
): YdbTableDescription => ({ columns: new Map(columns), primaryKey });

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
