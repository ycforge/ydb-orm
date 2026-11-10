import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { YdbTopics } from '@ycforge/ydb-orm/nest';

@Injectable()
class ConfigurationService {
  getPublic(): string {
    return 'DI works';
  }
}
@Injectable()
class NewsService {
  constructor(private readonly config: ConfigurationService) {}
  check(): string {
    return this.config.getPublic();
  }
}
@Module({ providers: [ConfigurationService, NewsService] })
class AppModule {}

// Проверяется именно вывод tsc: esbuild не создаёт design:paramtypes сам.
export async function smoke(): Promise<void> {
  if (typeof YdbTopics !== 'function') throw new Error('ORM import failed');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    if (app.get(NewsService).check() !== 'DI works')
      throw new Error('DI failed');
  } finally {
    await app.close();
  }
}
