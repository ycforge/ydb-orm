import 'reflect-metadata';
import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import {
  YdbCoreModule,
  YdbModule,
  YDB_DRIVER,
  YDB_QUERY,
  YdbEncryptionProvider,
  YdbBlindIndexProvider,
} from '../../src/index.js';
import { PhotoEntity } from '../fixtures/photo/photo.entity.js';
import { createMockExecutor, MockExecutor } from '../helpers/mock-executor.js';

@Module({
  imports: [YdbModule.forFeature([PhotoEntity])],
})
class TestFeatureModule {}

const encryptMock = jest.fn((value: string) =>
  Promise.resolve(new TextEncoder().encode(`enc:${value}`)),
);
const decryptMock = jest.fn((value: Uint8Array) =>
  Promise.resolve(new TextDecoder().decode(value).replace(/^enc:/, '')),
);
const hashMock = jest.fn((value: string) => Promise.resolve(`bi:${value}`));

const encryptionProvider: YdbEncryptionProvider = {
  encrypt: encryptMock,
  decrypt: decryptMock,
};

const blindIndexProvider: YdbBlindIndexProvider = {
  hash: hashMock,
};

async function createTestingModule(
  rows: any[][] = [[]],
): Promise<{ module: TestingModule; mock: MockExecutor }> {
  const mock = createMockExecutor(rows);

  const module = await Test.createTestingModule({
    imports: [
      YdbCoreModule.forRootAsync({
        useFactory: () => ({
          endpoint: 'grpc://localhost:2136/local',
          auth_type: 'anonymous' as const,
          authOptions: {},
          encryptionProvider,
          blindIndexProvider,
        }),
      }),
      TestFeatureModule,
    ],
  })
    .overrideProvider(YDB_DRIVER)
    .useValue({})
    .overrideProvider(YDB_QUERY)
    .useValue(mock.executor)
    .compile();

  return { module, mock };
}

describe('NestJS integration: encryption providers', () => {
  let module: TestingModule;

  afterEach(async () => {
    await module?.close();
    jest.clearAllMocks();
  });

  it('encrypts fields and computes blind index on save', async () => {
    let mock: MockExecutor;
    ({ module, mock } = await createTestingModule());

    const photo = new PhotoEntity();
    photo.title = 'Sunset';
    photo.author_email = 'a@b.c';

    await PhotoEntity.save(photo);

    expect(encryptMock).toHaveBeenCalledWith(
      'a@b.c',
      expect.any(String),
      expect.objectContaining({ fieldName: 'author_email' }),
    );
    expect(hashMock).toHaveBeenCalledWith(
      'a@b.c',
      expect.objectContaining({ fieldName: 'author_email' }),
    );

    // uuid сгенерирован автоматически при вставке
    expect(photo.uuid).toBeDefined();

    const [upsert] = mock.queries;
    expect(upsert.sql).toContain('UPSERT INTO `photos`');
    expect(upsert.sql).toContain('`author_email_bi`');
    // параметры обёрнуты в YDB-значения: Bytes.value = ciphertext / blind index (Utf8)
    expect((upsert.params.author_email as any).value).toEqual(
      new TextEncoder().encode('enc:a@b.c'),
    );
    expect((upsert.params.author_email_bi as any).value).toBe('bi:a@b.c');
    expect((upsert.params.title as any).value).toBe('Sunset');
  });

  it('decrypts fields on read', async () => {
    let mock: MockExecutor;
    ({ module, mock } = await createTestingModule([
      [
        {
          uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
          title: 'Sunset',
          author_email: new TextEncoder().encode('enc:a@b.c'),
        },
      ],
    ]));

    const photo = await PhotoEntity.find({
      uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
    });

    expect(decryptMock).toHaveBeenCalledWith(
      new TextEncoder().encode('enc:a@b.c'),
      expect.any(String),
      expect.objectContaining({ fieldName: 'author_email' }),
    );
    expect(photo).toBeInstanceOf(PhotoEntity);
    expect(photo?.author_email).toBe('a@b.c');
    expect(mock.queries[0].sql).toContain('SELECT * FROM `photos`');
  });

  it('searches by encrypted field via blind index hash', async () => {
    let mock: MockExecutor;
    ({ module, mock } = await createTestingModule([[]]));

    await PhotoEntity.findAll({ author_email: 'a@b.c' });

    expect(hashMock).toHaveBeenCalledWith(
      'a@b.c',
      expect.objectContaining({ fieldName: 'author_email' }),
    );
    const [select] = mock.queries;
    expect(select.sql).toContain('WHERE `author_email_bi` = $author_email_bi');
    expect((select.params.author_email_bi as any).value).toBe('bi:a@b.c');
  });
});
