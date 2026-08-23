import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import {
  createEntityFile,
  createEntityFileFromSpec,
  createMigrationFile,
  entityFilePath,
  renderEntityFile,
  toEnumMemberName,
  toKebabCase,
  toPascalCase,
  toSnakeCase,
  toValidClassName,
  buildDefaultEntitySpec,
  validateEntitySpec,
  type YdbEntitySpec,
} from './generators.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydb-orm-gen-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('case utils', () => {
  it('converts names between cases', () => {
    expect(toPascalCase('user profile')).toBe('UserProfile');
    expect(toPascalCase('user-profile')).toBe('UserProfile');
    expect(toPascalCase('UserProfile')).toBe('UserProfile');
    expect(toSnakeCase('UserProfile')).toBe('user_profile');
    expect(toKebabCase('UserProfile')).toBe('user-profile');
  });
});

describe('toValidClassName (#102)', () => {
  it('keeps valid identifiers untouched', () => {
    expect(toValidClassName('create users')).toBe('CreateUsers');
    expect(toValidClassName('UserProfile')).toBe('UserProfile');
  });

  it('prefixes digit-leading names so the class compiles', () => {
    expect(toValidClassName('123')).toBe('Migration123');
    expect(toValidClassName('2fa setup')).toBe('Migration2faSetup');
  });

  it('falls back to Migration when the name has no letters or digits', () => {
    expect(toValidClassName('---')).toBe('Migration');
    expect(toValidClassName('')).toBe('Migration');
  });
});

describe('createEntityFile', () => {
  it('creates an entity class file', () => {
    const created = createEntityFile(dir, 'user profile');

    expect(path.basename(created.filePath)).toBe('user-profile.entity.ts');
    expect(created.name).toBe('UserProfile');

    const content = fs.readFileSync(created.filePath, 'utf-8');
    expect(content).toContain(`@YdbEntity('user_profile')`);
    expect(content).toContain('export class UserProfile extends YdbBaseEntity');
    expect(content).toContain(`@YdbPrimaryColumn('Uuid')`);
    expect(content).toContain(`from '@ycforge/ydb-orm'`);
  });

  it('refuses to overwrite an existing file', () => {
    createEntityFile(dir, 'photo');
    expect(() => createEntityFile(dir, 'photo')).toThrow(/already exists/);
  });
});

// ---------------------------------------------------------------------------
// Генерация по спецификации (#24, entity:create)
// ---------------------------------------------------------------------------

describe('validateEntitySpec (#24)', () => {
  const validSpec = (): YdbEntitySpec => ({
    className: 'User',
    tableName: 'users',
    columns: [
      { name: 'uuid', type: 'Uuid', primary: true },
      { name: 'name', type: 'Utf8' },
    ],
  });

  it('accepts a minimal valid spec', () => {
    expect(validateEntitySpec(validSpec())).toEqual([]);
  });

  it('rejects invalid table and class names', () => {
    const issues = validateEntitySpec({
      ...validSpec(),
      className: '1Bad Class',
      tableName: 'bad-table',
    });
    expect(issues.some((i) => /invalid table name/.test(i))).toBe(true);
    expect(issues.some((i) => /invalid class name/.test(i))).toBe(true);
  });

  it('rejects invalid property names (SQL/TS identifier rules)', () => {
    for (const name of ['1abc', 'my-col', 'my col', '']) {
      const spec = validSpec();
      spec.columns.push({ name, type: 'Utf8' });
      expect(
        validateEntitySpec(spec).some((i) => /invalid property name/.test(i)),
      ).toBe(true);
    }
  });

  it('rejects names conflicting with YdbBaseEntity members', () => {
    for (const name of ['save', 'find', 'delete', 'toJSON', 'constructor']) {
      const spec = validSpec();
      spec.columns.push({ name, type: 'Utf8' });
      expect(
        validateEntitySpec(spec).some((i) => /YdbBaseEntity member/.test(i)),
      ).toBe(true);
    }
  });

  it('rejects duplicate column names and entities without primary key', () => {
    const dup: YdbEntitySpec = validSpec();
    dup.columns.push({ name: 'name', type: 'Utf8' });
    expect(
      validateEntitySpec(dup).some((i) => /duplicate column/.test(i)),
    ).toBe(true);

    const noPk = validSpec();
    noPk.columns = noPk.columns.map((c) => ({ ...c, primary: false }));
    expect(
      validateEntitySpec(noPk).some((i) => /at least one primary key/.test(i)),
    ).toBe(true);
  });

  it('rejects encrypted primary keys and unknown types', () => {
    const spec = validSpec();
    spec.columns[0] = {
      name: 'uuid',
      type: 'Uuid',
      primary: true,
      encrypted: true,
    };
    expect(
      validateEntitySpec(spec).some((i) =>
        /primary key cannot be encrypted/.test(i),
      ),
    ).toBe(true);

    const badType = validSpec();
    badType.columns.push({
      name: 'flag',
      type: 'Uint32' as never,
    });
    expect(
      validateEntitySpec(badType).some((i) => /unsupported YDB type/.test(i)),
    ).toBe(true);
  });

  it('validates enum definitions', () => {
    const emptyEnum = validSpec();
    emptyEnum.columns.push({
      name: 'status',
      type: 'Utf8',
      enumValues: [],
    });
    expect(
      validateEntitySpec(emptyEnum).some((i) => /at least one value/.test(i)),
    ).toBe(true);

    const storageWithoutValues = validSpec();
    storageWithoutValues.columns.push({
      name: 'status',
      type: 'Utf8',
      enumStorage: 'Int32',
    });
    expect(
      validateEntitySpec(storageWithoutValues).some((i) =>
        /enumStorage requires enumValues/.test(i),
      ),
    ).toBe(true);

    const ok: YdbEntitySpec = validSpec();
    ok.columns.push({
      name: 'status',
      type: 'Utf8',
      enumValues: ['active', 'inactive'],
      enumStorage: 'Int32',
    });
    expect(validateEntitySpec(ok)).toEqual([]);
  });

  it('rejects enum values colliding after member-name normalization (#153)', () => {
    // Пунктуация нормализуется в '_': "a-b" и "a_b" → один член A_B.
    const punct: YdbEntitySpec = validSpec();
    punct.columns.push({
      name: 'status',
      type: 'Utf8',
      enumValues: ['a-b', 'a_b'],
    });
    const punctIssues = validateEntitySpec(punct);
    expect(
      punctIssues.some((i) => /same TypeScript member "A_B"/.test(i)),
    ).toBe(true);
    expect(
      punctIssues.some((i) => i.includes('"a-b"') && i.includes('"a_b"')),
    ).toBe(true);

    // Пунктуация + регистр: "foo.bar" и "FOO-BAR" → FOO_BAR.
    const mixed: YdbEntitySpec = validSpec();
    mixed.columns.push({
      name: 'status',
      type: 'Utf8',
      enumValues: ['foo.bar', 'FOO-BAR'],
    });
    expect(
      validateEntitySpec(mixed).some((i) =>
        /same TypeScript member "FOO_BAR"/.test(i),
      ),
    ).toBe(true);

    // Префикс цифры не спасает: "1" и "v_1" → V_1.
    const digit: YdbEntitySpec = validSpec();
    digit.columns.push({
      name: 'status',
      type: 'Utf8',
      enumValues: ['1', 'v_1'],
    });
    expect(
      validateEntitySpec(digit).some((i) =>
        /same TypeScript member "V_1"/.test(i),
      ),
    ).toBe(true);
  });

  it('keeps current member names for values that normalize uniquely (#153)', () => {
    const spec: YdbEntitySpec = validSpec();
    spec.columns.push({
      name: 'status',
      type: 'Utf8',
      enumValues: ['active', 'new_order', 'in-progress', '2fa'],
    });
    expect(validateEntitySpec(spec)).toEqual([]);

    const rendered = renderEntityFile(spec);
    for (const member of ['ACTIVE', 'NEW_ORDER', 'IN_PROGRESS', 'V_2FA']) {
      expect(rendered).toContain(`  ${member} = `);
    }
  });

  it('rejects two columns whose derived enum type names collide (#153)', () => {
    const spec: YdbEntitySpec = validSpec();
    spec.columns.push(
      { name: 'foo_bar', type: 'Utf8', enumValues: ['a', 'b'] },
      { name: 'fooBar', type: 'Utf8', enumValues: ['c', 'd'] },
    );
    expect(
      validateEntitySpec(spec).some((i) =>
        /columns "foo_bar" and "fooBar" produce the same enum type name "FooBarEnum"/.test(
          i,
        ),
      ),
    ).toBe(true);
  });

  it('requires date-like types for create/update date columns (one per entity)', () => {
    const wrongType = validSpec();
    wrongType.columns.push({
      name: 'created_at',
      type: 'Utf8',
      createDate: true,
    });
    expect(
      validateEntitySpec(wrongType).some((i) =>
        /@YdbCreateDateColumn requires a Date\/Datetime\/Timestamp/.test(i),
      ),
    ).toBe(true);

    const twice: YdbEntitySpec = validSpec();
    twice.columns.push(
      { name: 'created_a', type: 'Timestamp', createDate: true },
      { name: 'created_b', type: 'Timestamp', createDate: true },
    );
    expect(
      validateEntitySpec(twice).some((i) =>
        /only one @YdbCreateDateColumn/.test(i),
      ),
    ).toBe(true);
  });

  it('validates TTL column and ISO interval', () => {
    const unknownColumn = validSpec();
    unknownColumn.ttl = { interval: 'PT2H', column: 'nope' };
    expect(
      validateEntitySpec(unknownColumn).some((i) =>
        /TTL references unknown column/.test(i),
      ),
    ).toBe(true);

    const notDate = validSpec();
    notDate.ttl = { interval: 'PT2H', column: 'name' };
    expect(
      validateEntitySpec(notDate).some((i) =>
        /TTL column "name" must be Date\/Datetime\/Timestamp/.test(i),
      ),
    ).toBe(true);

    const calendarInterval = validSpec();
    calendarInterval.columns.push({
      name: 'expires_at',
      type: 'Timestamp',
    });
    calendarInterval.ttl = { interval: 'P1Y', column: 'expires_at' };
    expect(
      validateEntitySpec(calendarInterval).some((i) =>
        /not a valid ISO 8601 duration/.test(i),
      ),
    ).toBe(true);

    const ok = validSpec();
    ok.columns.push({ name: 'expires_at', type: 'Datetime' });
    ok.ttl = { interval: 'P30D', column: 'expires_at' };
    expect(validateEntitySpec(ok)).toEqual([]);
  });
});

describe('renderEntityFile (#24)', () => {
  it('renders the minimal default template exactly as the legacy path', () => {
    const rendered = renderEntityFile(buildDefaultEntitySpec('user profile'));
    expect(rendered).toContain(`@YdbEntity('user_profile')`);
    expect(rendered).toContain(
      'export class UserProfile extends YdbBaseEntity',
    );
    expect(rendered).toContain(`@YdbPrimaryColumn('Uuid')`);
    expect(rendered).toContain(`@YdbColumn('Utf8')`);
    // Импорты сортируются и содержат только используемые декораторы.
    expect(rendered.match(/^import \{$/m)).toBeTruthy();
    expect(rendered).not.toContain('YdbEncrypted');
    expect(rendered).not.toContain('YdbTtl');
  });

  it('renders enum, encryption, date and TTL decorators in current API form', () => {
    const rendered = renderEntityFile({
      className: 'OrderItem',
      tableName: 'order_items',
      columns: [
        { name: 'id', type: 'Int64', primary: true },
        {
          name: 'status_code',
          type: 'Int32',
          enumValues: ['draft', 'sent'],
          enumStorage: 'Int32',
        },
        { name: 'email', type: 'Utf8', encrypted: true, blindIndex: false },
        { name: 'created_at', type: 'Timestamp', createDate: true },
        { name: 'updated_at', type: 'Datetime', updateDate: true },
      ],
      ttl: { interval: 'P30D', column: 'updated_at' },
    });

    expect(rendered).toContain(`export enum StatusCodeEnum {`);
    expect(rendered).toContain("  DRAFT = 'draft',");
    expect(rendered).toContain("  SENT = 'sent',");
    expect(rendered).toContain(`@YdbPrimaryColumn('Int64')`);
    expect(rendered).toContain(`id: bigint;`);
    expect(rendered).toContain(`@YdbColumn('Int32')`);
    expect(
      rendered.includes(
        `@YdbEnum({ values: Object.values(StatusCodeEnum), storage: 'Int32' })`,
      ),
    ).toBe(true);
    expect(rendered).toContain('@YdbEncrypted({ blindIndex: false })');
    expect(rendered).not.toMatch(/@YdbColumn\('Utf8'\)\n\s*@YdbEncrypted/);
    expect(rendered).toContain('@YdbCreateDateColumn()');
    expect(rendered).toContain(`created_at: Date;`);
    expect(rendered).toContain('@YdbUpdateDateColumn()');
    expect(rendered).toContain(
      `@YdbTtl({ interval: 'P30D', column: 'updated_at' })`,
    );
  });

  it('throws on invalid spec instead of rendering broken code', () => {
    expect(() =>
      renderEntityFile({
        className: 'X',
        tableName: 'x',
        columns: [{ name: 'uuid', type: 'Uuid' }],
      }),
    ).toThrow(/at least one primary key/);
  });
});

describe('createEntityFileFromSpec (#24)', () => {
  it('writes a file from spec and reports the created class', () => {
    const created = createEntityFileFromSpec(dir, {
      className: 'Photo',
      tableName: 'photos',
      columns: [
        { name: 'uuid', type: 'Uuid', primary: true },
        { name: 'title', type: 'Utf8' },
      ],
    });
    expect(fs.existsSync(created.filePath)).toBe(true);
    expect(created.name).toBe('Photo');
    expect(fs.readFileSync(created.filePath, 'utf-8')).toContain(
      `@YdbEntity('photos')`,
    );
  });

  it('never overwrites an existing file', () => {
    const spec: YdbEntitySpec = {
      className: 'Photo',
      tableName: 'photos',
      columns: [
        { name: 'uuid', type: 'Uuid', primary: true },
        { name: 'title', type: 'Utf8' },
      ],
    };
    const first = createEntityFileFromSpec(dir, spec);
    const before = fs.readFileSync(first.filePath, 'utf-8');
    expect(() => createEntityFileFromSpec(dir, spec)).toThrow(/already exists/);
    expect(fs.readFileSync(first.filePath, 'utf-8')).toBe(before);
  });

  it('fails validation BEFORE writing anything', () => {
    expect(() =>
      createEntityFileFromSpec(dir, {
        className: 'Bad',
        tableName: 'bad table!',
        columns: [],
      }),
    ).toThrow(/Invalid entity spec/);
    expect(fs.readdirSync(dir)).toHaveLength(0);

    // Коллизия нормализованных членов enum — тоже до записи файла (#153).
    expect(() =>
      createEntityFileFromSpec(dir, {
        className: 'BadEnum',
        tableName: 'bad_enums',
        columns: [
          { name: 'uuid', type: 'Uuid', primary: true },
          { name: 'status', type: 'Utf8', enumValues: ['a-b', 'a_b'] },
        ],
      }),
    ).toThrow(/same TypeScript member "A_B"/);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('derives kebab-case file paths from entity names', () => {
    expect(entityFilePath('/tmp/x', 'user profile')).toBe(
      '/tmp/x/user-profile.entity.ts',
    );
    expect(entityFilePath('/tmp/x', 'UserProfile')).toBe(
      '/tmp/x/user-profile.entity.ts',
    );
  });
});

describe('toEnumMemberName (#24)', () => {
  it('sanitizes values into enum member identifiers', () => {
    expect(toEnumMemberName('active')).toBe('ACTIVE');
    expect(toEnumMemberName('new_order')).toBe('NEW_ORDER');
    expect(toEnumMemberName('in-progress')).toBe('IN_PROGRESS');
    expect(toEnumMemberName('2fa')).toBe('V_2FA');
  });
});

describe('createMigrationFile', () => {
  it('creates an empty migration template', () => {
    const created = createMigrationFile(dir, 'create users');

    expect(path.basename(created.filePath)).toMatch(/^\d+-CreateUsers\.ts$/);

    const content = fs.readFileSync(created.filePath, 'utf-8');
    expect(content).toMatch(
      /export class CreateUsers\d+ implements YdbMigration/,
    );
    expect(content).toContain(`readonly name = "${created.name}";`);
    expect(content.match(/no statements — fill in manually/g)).toHaveLength(2);
  });

  it('creates a migration with DDL from a plan', () => {
    const created = createMigrationFile(dir, 'add photos', {
      up: ['CREATE TABLE `photos` (`uuid` Uuid, PRIMARY KEY (`uuid`))'],
      down: ['DROP TABLE `photos`'],
      warnings: ['Table "photos": extra column "legacy"'],
    });

    const content = fs.readFileSync(created.filePath, 'utf-8');
    expect(content).toContain(
      'await executeSql(executor, "CREATE TABLE `photos` (`uuid` Uuid, PRIMARY KEY (`uuid`))");',
    );
    expect(content).toContain(
      'await executeSql(executor, "DROP TABLE `photos`");',
    );
    expect(content).toContain('WARNING: Table "photos": extra column "legacy"');
  });

  it('does not collide when called repeatedly at the same millisecond (#102)', () => {
    // Фиксируем Date.now() в будущем (после любых реальных вызовов
    // в других тестах): все три генерации попадают в одну миллисекунду.
    const fixed = Date.now() + 60_000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(fixed);
    try {
      const first = createMigrationFile(dir, 'add photos');
      const second = createMigrationFile(dir, 'add photos');
      const third = createMigrationFile(dir, 'add photos');

      expect(first.name).toBe(`${fixed}-AddPhotos`);
      expect(second.name).toBe(`${fixed}-AddPhotos-1`);
      expect(third.name).toBe(`${fixed}-AddPhotos-2`);

      for (const created of [first, second, third]) {
        expect(fs.existsSync(created.filePath)).toBe(true);
      }

      // Лексикографическая сортировка загрузчика сохраняет хронологию:
      // порядок имён после сортировки совпадает с порядком генерации.
      expect([first.name, second.name, third.name].sort()).toEqual([
        first.name,
        second.name,
        third.name,
      ]);

      // Имена классов уникальны и являются валидными идентификаторами.
      const classNames = [first, second, third].map(
        (created) =>
          fs
            .readFileSync(created.filePath, 'utf-8')
            .match(/export class (\w+) implements/)?.[1],
      );
      expect(new Set(classNames).size).toBe(3);
      for (const className of classNames) {
        expect(className).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('generates a compilable class for names without letters or with leading digits (#102)', () => {
    const fromDigits = createMigrationFile(dir, '123');
    const fromSymbols = createMigrationFile(dir, '---');
    const fromMixed = createMigrationFile(dir, '2fa setup');

    for (const created of [fromDigits, fromSymbols, fromMixed]) {
      const content = fs.readFileSync(created.filePath, 'utf-8');
      const className = content.match(/export class (\w+) implements/)?.[1];
      // Класс не может начинаться с цифры — иначе файл не скомпилируется.
      expect(className).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
      expect(content).toContain(`readonly name = "${created.name}";`);
      expect(path.basename(created.filePath)).toBe(`${created.name}.ts`);
    }
  });
});
