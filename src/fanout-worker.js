import { randomUUID } from 'node:crypto';
import { boundedIdentifier, safeInteger } from './contracts.js';

export class FanoutWorker {
  constructor({
    store,
    clock = Date.now,
    uuid = randomUUID,
    workerId = `worker-${randomUUID()}`,
    leaseMs = 30_000,
    crashCooldownMs = 10_000,
    chunkSize = 100,
    maxChunksPerRun = 100,
    afterChunk = async () => {},
  }) {
    this.store = store;
    this.clock = clock;
    this.uuid = uuid;
    this.workerId = boundedIdentifier(workerId, 'workerId', { max: 64 });
    this.leaseMs = safeInteger(leaseMs, 'leaseMs', { min: 1 });
    this.crashCooldownMs = safeInteger(crashCooldownMs, 'crashCooldownMs');
    this.chunkSize = safeInteger(chunkSize, 'chunkSize', { min: 1, max: 500 });
    this.maxChunksPerRun = safeInteger(maxChunksPerRun, 'maxChunksPerRun', { min: 1, max: 100 });
    this.afterChunk = afterChunk;
  }

  async runOne() {
    const job = await this.store.claimFanoutJob({
      nowMs: this.clock(),
      leaseMs: this.leaseMs,
      crashCooldownMs: this.crashCooldownMs,
      leaseToken: this.uuid(),
      workerId: this.workerId,
    });
    if (!job) return { kind: 'idle' };

    let scanned = 0;
    let inserted = 0;
    for (let chunkIndex = 1; chunkIndex <= this.maxChunksPerRun; chunkIndex += 1) {
      const result = await this.store.processFanoutChunk({
        postId: job.postId,
        leaseToken: job.leaseToken,
        nowMs: this.clock(),
        leaseMs: this.leaseMs,
        chunkSize: this.chunkSize,
      });
      scanned += result.scanned;
      inserted += result.inserted;
      await this.afterChunk({ job, result, chunkIndex });
      if (result.completed) {
        return { kind: 'completed', attempt: job.attempt, chunks: chunkIndex, scanned, inserted };
      }
    }
    const result = await this.store.yieldFanoutJob({
      postId: job.postId,
      leaseToken: job.leaseToken,
      nowMs: this.clock(),
    });
    return { ...result, attempt: job.attempt, chunks: this.maxChunksPerRun, scanned, inserted };
  }
}
