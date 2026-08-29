/**
 * Общие опции подключения для примеров.
 *
 * По умолчанию примеры рассчитаны на локальный Docker YDB
 * (anonymous auth, endpoint `grpc://localhost:2136/local`).
 * Для работы против реальной облачной базы задайте YDB_ENDPOINT
 * и замените `auth` на нужную стратегию (см. @ycforge/auth).
 */
import { createAuth } from '@ycforge/auth';
import type { YdbModuleOptions } from '../../src/index.js';

/** Опции YDB, общие для всех примеров: адрес + anonymous-аутентификация. */
export function buildYdbOptions(): YdbModuleOptions {
  return {
    endpoint: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136/local',
    auth: createAuth({ type: 'anonymous' }),
  };
}
