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
  YDB_SCHEMA_SYNC,
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
      // Verify the close order for BOTH configurations: topics before
      // their own driver.
      const primaryClose = primary.close.bind(primary);
      jest.spyOn(primary, 'close').mockImplementation(async () => {
        events.push('topics');
        await primaryClose();
      });
      const otherClose = other.close.bind(other);
      jest.spyOn(other, 'close').mockImplementation(async () => {
        events.push('other-topics');
        await otherClose();
      });
    } finally {
      await module.close();
    }
    expect(events).toEqual(
      expect.arrayContaining([
        'topics',
        'default',
        'other-topics',
        'topics-other',
      ]),
    );
    expect(events.indexOf('topics')).toBeLessThan(events.indexOf('default'));
    expect(events.indexOf('other-topics')).toBeLessThan(
      events.indexOf('topics-other'),
    );
  });

  it('при провале bootstrap проглатывает ошибку закрытия топиков и закрывает драйвер', async () => {
    const events: string[] = [];
    const module = await Test.createTestingModule({
      imports: [
        YdbCoreModule.forRootAsync({
          useFactory: () => ({
            endpoint: 'grpc://localhost:2136/local',
            auth: createAuth({ type: 'anonymous' }),
            sync: true,
            driverFactory: () =>
              ({
                close: () => {
                  events.push('driver');
                },
              }) as never,
          }),
        }),
      ],
    })
      .overrideProvider(YDB_QUERY)
      .useValue(createMockExecutor())
      // sync fails on bootstrap -> dispose({ ignoreCloseErrors: true }).
      .overrideProvider(YDB_SCHEMA_SYNC)
      .useValue({
        sync: () => Promise.reject(new Error('schema failure')),
      })
      .compile();
    const topics = module.get(YdbTopics);
    // Closing topics fails too: the error must be swallowed rather than
    // replace the original schema sync error.
    const closeSpy = jest
      .spyOn(topics, 'close')
      .mockRejectedValue(new Error('topic close'));
    // After a failed init() module.close() rethrows the original
    // bootstrap error — dispose already ran, no second close is needed.
    await expect(module.init()).rejects.toThrow('schema failure');
    // The driver is closed despite both errors (ignoreCloseErrors on dispose).
    expect(closeSpy).toHaveBeenCalled();
    expect(events).toEqual(['driver']);
  });
});
