import 'reflect-metadata';
import { describe, it, expect, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { createAuth } from '@ycforge/auth';
import {
  YdbCoreModule,
  YdbTopics,
  getTopicsToken,
  getScopedToken,
  YDB_QUERY,
} from '../../src/nest/index.js';
import { createMockExecutor } from '../helpers/mock-executor.js';

describe('NestJS: топики (#265)', () => {
  it('изолирует именованные конфигурации и закрывает топики до драйвера', async () => {
    const events: string[] = [];
    const options = (name: string) => ({
      name,
      useFactory: () => ({
        endpoint: 'grpc://localhost:2136/local',
        auth: createAuth({ type: 'anonymous' }),
        driverFactory: () =>
          ({
            close: () => {
              events.push(name);
            },
          }) as never,
      }),
    });
    const module = await Test.createTestingModule({
      imports: [
        YdbCoreModule.forRootAsync(options('default')),
        YdbCoreModule.forRootAsync(options('topics-other')),
      ],
    })
      .overrideProvider(YDB_QUERY)
      .useValue(createMockExecutor())
      .overrideProvider(getScopedToken(YDB_QUERY, 'topics-other'))
      .useValue(createMockExecutor())
      .compile();
    try {
      const primary = module.get(YdbTopics);
      const other = module.get<YdbTopics>(getTopicsToken('topics-other'));
      expect(primary).not.toBe(other);
      const close = primary.close.bind(primary);
      jest.spyOn(primary, 'close').mockImplementation(async () => {
        events.push('topics');
        await close();
      });
    } finally {
      await module.close();
    }
    expect(events.indexOf('topics')).toBeLessThan(events.indexOf('default'));
  });
});
