import { Queue } from 'bullmq';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

// Setup Redis connection options
const connectionOptions = {
  url: config.REDIS_URL,
};

// Define queues. If we are in test environment, we can handle them without crashing.
export const statsCommitQueue = new Queue('stats-commit', {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },
});

export const detectorQueue = new Queue('detector', {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'fixed',
      delay: 5000,
    },
  },
});

export async function enqueueStatsJob(commitId: number, repoFullName: string, sha: string) {
  try {
    await statsCommitQueue.add('fetch-stats', { commitId, repoFullName, sha });
    logger.debug({ commitId, sha }, 'Enqueued stats-commit job successfully');
  } catch (error) {
    logger.error({ error, commitId, sha }, 'Failed to enqueue stats-commit job');
  }
}

export async function enqueueDetectorJob(repoId: number, trigger: string) {
  try {
    await detectorQueue.add('detect', { repoId, trigger });
    logger.debug({ repoId, trigger }, 'Enqueued detector job successfully');
  } catch (error) {
    logger.error({ error, repoId, trigger }, 'Failed to enqueue detector job');
  }
}
