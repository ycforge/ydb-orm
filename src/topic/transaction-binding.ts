import type { TX } from '@ydbjs/query';
import type { TopicClient } from '@ydbjs/topic';
import type { Driver } from '@ydbjs/core';
import type { YdbExecutor, YdbIsolationLevel } from '../core/interfaces.js';

type TopicTransaction = Parameters<TopicClient['createTxWriter']>[0];

// Привязка хранится вне executor и переносится через штатные обёртки ORM.
interface Binding {
  tx: TopicTransaction;
  driver: Driver;
  isolation: YdbIsolationLevel;
  active: boolean;
  signal?: AbortSignal;
}
const bindings = new WeakMap<YdbExecutor, Binding>();

export function bindTopicTransaction(
  executor: YdbExecutor,
  tx: TX,
  driver: Driver,
  isolation: YdbIsolationLevel = 'serializableReadWrite',
  signal?: AbortSignal,
): void {
  // SDK переиспользует callable: снимок защищает от соседних транзакций.
  const snapshot: TopicTransaction = Object.freeze({
    sessionId: tx.sessionId,
    transactionId: tx.transactionId,
    onCommit: tx.onCommit.bind(tx),
    onRollback: tx.onRollback.bind(tx),
    onClose: tx.onClose.bind(tx),
    signal,
  });
  const binding: Binding = {
    tx: snapshot,
    driver,
    isolation,
    active: true,
    signal,
  };
  bindings.set(executor, binding);
  tx.onClose(() => {
    binding.active = false;
  });
}

export function inheritTopicTransaction(
  source: YdbExecutor,
  target: YdbExecutor,
): void {
  const binding = bindings.get(source);
  if (binding) bindings.set(target, binding);
}

export function resolveTopicTransaction(
  executor: YdbExecutor,
  driver: Driver,
): TopicTransaction {
  const binding = bindings.get(executor);
  if (!binding || !binding.active) {
    throw new Error(
      'Topics require a live transaction created by createExecutor().',
    );
  }
  if (binding.driver !== driver)
    throw new Error('Topic transaction belongs to a different YDB driver.');
  if (binding.isolation !== 'serializableReadWrite') {
    throw new Error(
      'Topic transactions require serializableReadWrite isolation.',
    );
  }
  binding.signal?.throwIfAborted();
  return binding.tx;
}
