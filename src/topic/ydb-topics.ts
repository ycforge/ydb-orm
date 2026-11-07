import type { Driver } from '@ydbjs/core';
import { topic, type TopicClient } from '@ydbjs/topic';
import type {
  TopicReader,
  TopicReaderOptions,
  TopicTxReader,
} from '@ydbjs/topic/reader';
import type {
  TopicWriter,
  TopicWriterOptions,
  TopicTxWriter,
} from '@ydbjs/topic/writer';
import type { YdbExecutor } from '../core/interfaces.js';
import { getActiveTransaction } from '../transaction/transaction-context.js';
import { resolveTopicTransaction } from './transaction-binding.js';

export interface YdbTopicOperationOptions {
  trx?: YdbExecutor;
}
export type YdbTopicWriterOptions = Omit<TopicWriterOptions, 'tx'>;
export type YdbTopicTxReader = Pick<TopicTxReader, 'read'>;
export type YdbTopicTxWriter = Pick<TopicTxWriter, 'write' | 'flush'>;
export type YdbTopicReader = TopicReader | YdbTopicTxReader;
export type YdbTopicWriter = TopicWriter | YdbTopicTxWriter;

/** Работа с существующими топиками. Транзакционными ресурсами владеет SDK. */
export class YdbTopics implements AsyncDisposable {
  private readonly client: TopicClient;
  private readonly resources = new Set<TopicReader | TopicWriter>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly driver: Driver) {
    this.client = topic(driver);
  }

  createReader(
    options: TopicReaderOptions,
    operation?: YdbTopicOperationOptions,
  ): YdbTopicReader {
    this.assertOpen();
    const tx = this.resolveTransaction(operation);
    if (tx) {
      const reader = this.client.createTxReader(tx, { ...options });
      return {
        read: (options) =>
          reader.read({
            ...options,
            signal:
              tx.signal && options?.signal
                ? AbortSignal.any([tx.signal, options.signal])
                : (tx.signal ?? options?.signal),
          }),
      };
    }
    const reader = this.client.createReader({ ...options });
    return this.track(reader);
  }

  createWriter(
    options: YdbTopicWriterOptions,
    operation?: YdbTopicOperationOptions,
  ): YdbTopicWriter {
    this.assertOpen();
    // Даже JS-вызов не может обойти проверку транзакции через SDK options.tx.
    if ('tx' in options)
      throw new Error(
        'Pass the ORM transaction via { trx }, not writer options.tx.',
      );
    const tx = this.resolveTransaction(operation);
    if (tx) {
      const writer = this.client.createTxWriter(tx, { ...options });
      return {
        write: (payload, extra) => writer.write(payload, extra),
        flush: () => writer.flush(),
      };
    }
    const writer = this.client.createWriter({ ...options });
    return this.track(writer);
  }

  private track<T extends TopicReader | TopicWriter>(resource: T): T {
    const close = resource.close.bind(resource);
    const destroy = resource.destroy.bind(resource);
    resource.close = async () => {
      try {
        await close();
      } finally {
        destroy();
        this.resources.delete(resource);
      }
    };
    resource.destroy = (reason?: Error) => {
      destroy(reason);
      this.resources.delete(resource);
    };
    resource[Symbol.asyncDispose] = () => resource.close();
    if (Symbol.dispose in resource)
      resource[Symbol.dispose] = () => resource.destroy();
    this.resources.add(resource);
    return resource;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const results = await Promise.allSettled(
        [...this.resources].map((resource) => resource.close()),
      );
      // Освобождаем все ресурсы, даже если graceful close одного из них упал.
      for (const resource of this.resources) resource.destroy();
      this.resources.clear();
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason as unknown);
      if (errors.length)
        throw new AggregateError(errors, 'Failed to close topic resources.');
    })();
    return this.closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('YdbTopics is closed.');
  }

  private resolveTransaction(operation?: YdbTopicOperationOptions) {
    const active = getActiveTransaction();
    const explicit = operation?.trx;
    // Сравниваем исходные SDK-транзакции, включая обёрнутые executor.
    const tx = explicit
      ? resolveTopicTransaction(explicit, this.driver)
      : undefined;
    if (active?.ambient) {
      const ambient = resolveTopicTransaction(active.trx, this.driver);
      if (tx && tx !== ambient)
        throw new Error('Topic transaction mixing detected.');
      return ambient;
    }
    return tx;
  }
}
