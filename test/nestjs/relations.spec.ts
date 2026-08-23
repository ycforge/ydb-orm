import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import {
  YdbCoreModule,
  YdbModule,
  YDB_DRIVER,
  YDB_QUERY,
} from '../../src/index.js';
import { UserProfileEntity } from '../fixtures/user_profile/user_profile.entity.js';
import { PhotoWithTagsEntity } from '../fixtures/photo_with_tags/photo_with_tags.entity.js';
import { TagEntity } from '../fixtures/tag/tag.entity.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import { createMockExecutor } from '../helpers/mock-executor.js';

@Module({
  imports: [
    YdbModule.forFeature([UserProfileEntity, PhotoWithTagsEntity, TagEntity]),
  ],
})
class RelationFeatureModule {}

const profileRow = {
  uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
  user_uuid: '11111111-1111-1111-1111-111111111111',
  bio: 'hello',
};

const userRow = {
  uuid: '11111111-1111-1111-1111-111111111111',
  email_encrypted: new TextEncoder().encode('enc'),
  full_name: new TextEncoder().encode('Ivan'),
};

const photoRow = {
  uuid: '22222222-2222-2222-2222-222222222222',
  title: 'Sunset',
};

async function createTestingModule(rows: any[][]) {
  const mock = createMockExecutor(rows);

  const module = await Test.createTestingModule({
    imports: [
      YdbCoreModule.forRootAsync({
        useFactory: () => ({
          endpoint: 'grpc://localhost:2136/local',
          auth_type: 'anonymous' as const,
          authOptions: {},
          encryptionProvider: new TestOnlyEncryptionProvider(),
          blindIndexProvider: new TestOnlyEncryptionProvider(),
          sync: false,
        }),
      }),
      RelationFeatureModule,
    ],
  })
    .overrideProvider(YDB_DRIVER)
    .useValue({})
    .overrideProvider(YDB_QUERY)
    .useValue(mock.executor)
    .compile();

  return { module, mock };
}

describe('NestJS integration: relations', () => {
  it('eager-loads one-to-one relation with IN query', async () => {
    const { module, mock } = await createTestingModule([
      [profileRow],
      [userRow],
    ]);

    await UserProfileEntity.findByUuid(profileRow.uuid);

    expect(mock.queries[0].sql).toContain('FROM `user_profiles`');
    expect(mock.queries[1].sql).toContain('FROM `users`');
    expect(mock.queries[1].sql).toContain('WHERE `uuid` IN');

    await module.close();
  });

  it('eager-loads many-to-many relation via join table', async () => {
    const { module, mock } = await createTestingModule([[photoRow], [], []]);

    await PhotoWithTagsEntity.findByUuid(photoRow.uuid);

    expect(mock.queries[0].sql).toContain('FROM `photos_with_tags`');
    expect(mock.queries[1].sql).toContain('FROM `photo_tag`');
    expect(mock.queries[1].sql).toContain('`photos_with_tags_uuid` IN');
    // #86: join-таблица вернула ноль ссылок — выборка тегов не выполняется.
    expect(mock.queries).toHaveLength(2);

    await module.close();
  });

  it('loadRelations loads many-to-many for single entity', async () => {
    const { module, mock } = await createTestingModule([[photoRow], [], []]);

    const photo = new PhotoWithTagsEntity();
    photo.uuid = photoRow.uuid;
    photo.title = photoRow.title;
    await photo.loadRelations(['tags']);

    expect(mock.queries[0].sql).toContain('FROM `photo_tag`');
    // #86: join-таблица вернула ноль ссылок — выборка тегов не выполняется.
    expect(mock.queries).toHaveLength(1);

    await module.close();
  });
});
