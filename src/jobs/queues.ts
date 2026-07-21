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

/**
 * Sequência pós-criação de repositório (colaboradores + branch protection).
 * Tentativas espaçadas porque o GitHub leva alguns segundos para popular o template.
 */
export const repoSetupQueue = new Queue('repo-setup', {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: config.repoSetup.attempts,
    backoff: {
      type: 'exponential',
      delay: config.repoSetup.backoffMs,
    },
  },
});

/** Fila do congelador. Alimentada por um repeatable job registrado no processo do worker. */
export const congeladorQueue = new Queue('congelador', {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

export const CONGELADOR_REPEAT_JOB_NAME = 'sweep';

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

export async function enqueueRepoSetupJob(repoId: number) {
  try {
    await repoSetupQueue.add('configure', { repoId });
    logger.debug({ repoId }, 'Enqueued repo-setup job successfully');
  } catch (error) {
    logger.error({ error, repoId }, 'Failed to enqueue repo-setup job');
  }
}

/**
 * Registra (idempotentemente) o repeatable job do congelador.
 * Chamado apenas pelo processo do worker — a API não agenda nada.
 */
export async function scheduleCongelador() {
  await congeladorQueue.add(
    CONGELADOR_REPEAT_JOB_NAME,
    {},
    {
      repeat: { every: config.congelador.intervalMs },
      // jobId fixo evita acumular schedulers duplicados a cada restart do worker.
      jobId: CONGELADOR_REPEAT_JOB_NAME,
    }
  );
  logger.info({ everyMs: config.congelador.intervalMs }, 'Congelador repeatable job scheduled');
}
