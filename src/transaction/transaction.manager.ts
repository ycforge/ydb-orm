import { Injectable, Inject } from '@nestjs/common';
import { YDB_QUERY } from '../core/constants.js';
import type { YdbExecutor } from '../core/interfaces.js';

@Injectable()
export class YdbTransactionManager {
  constructor(@Inject(YDB_QUERY) private readonly db: YdbExecutor) {}

  async runInTransaction<T>(fn: (trx: YdbExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(fn);
  }
}
