import { Worker, Job } from 'bullmq';
import { config } from '../lib/config.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { getInstallationOctokit, withGithubRetry } from '../lib/octokit.js';
import { runDetectors } from '../detectors/index.js';
import { configureRepository, markRepoSetupFailed } from '../services/repo.js';
import { runCongelador } from './congelador.js';
import { enqueueDetectorJob, scheduleCongelador } from './queues.js';

// Setup Redis connection options
const connectionOptions = {
  url: config.REDIS_URL,
};

// 1. Commit Stats Worker
export const statsWorker = new Worker(
  'stats-commit',
  async (job: Job) => {
    const { commitId, repoFullName, sha } = job.data;
    logger.info({ jobId: job.id, commitId, sha }, 'Processing commit stats fetch');

    const [owner, repo] = repoFullName.split('/');
    if (!owner || !repo) {
      logger.error({ repoFullName }, 'Invalid repoFullName parsed in job');
      throw new Error('Invalid repository full name');
    }

    try {
      const octokit = await getInstallationOctokit();
      
      const response = await withGithubRetry(() =>
        octokit.rest.repos.getCommit({
          owner,
          repo,
          ref: sha,
        })
      );

      const additions = response.data.stats?.additions || 0;
      const deletions = response.data.stats?.deletions || 0;

      // Update commit in database
      const updatedCommit = await prisma.commit.update({
        where: { id: commitId },
        data: {
          additions,
          deletions,
          stats_status: 'CALCULADO',
        },
      });

      logger.info({ commitId, sha, additions, deletions }, 'Commit stats calculated and stored');

      // Crucial: Enqueue detector job now that commit additions/deletions are populated
      await enqueueDetectorJob(updatedCommit.repositorio_id, 'stats_calculated');

    } catch (error: any) {
      logger.error({ error, commitId, sha }, 'Error fetching commit stats from GitHub API');
      
      // If we are on the last attempt, mark the commit stats status as ERRO
      if (job.attemptsMade + 1 >= (job.opts.attempts || 3)) {
        await prisma.commit.update({
          where: { id: commitId },
          data: {
            stats_status: 'ERRO',
          },
        }).catch((dbErr) => {
          logger.error({ dbErr, commitId }, 'Failed to set commit status to ERRO');
        });
      }
      
      throw error; // Rethrow to trigger BullMQ retry
    }
  },
  { connection: connectionOptions }
);

// 2. Detector Worker
export const detectorWorker = new Worker(
  'detector',
  async (job: Job) => {
    const { repoId, trigger } = job.data;
    logger.info({ jobId: job.id, repoId, trigger }, 'Processing anomaly detection');

    try {
      await runDetectors(repoId, trigger);
    } catch (error) {
      logger.error({ error, repoId }, 'Detector worker execution failed');
      throw error;
    }
  },
  { connection: connectionOptions }
);

// 3. Repo Setup Worker (colaboradores + branch protection, com retry/backoff)
export const repoSetupWorker = new Worker(
  'repo-setup',
  async (job: Job) => {
    const { repoId } = job.data;
    logger.info({ jobId: job.id, repoId, attempt: job.attemptsMade + 1 }, 'Processing repository setup');

    try {
      await configureRepository(repoId);
    } catch (error: any) {
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts || config.repoSetup.attempts);
      logger.error({ error: error.message, repoId, isLastAttempt }, 'Repository setup attempt failed');

      // Esgotou o retry: grava o erro no repositório para o professor ver no dashboard.
      if (isLastAttempt) {
        await markRepoSetupFailed(repoId, error.message ?? 'Unknown error');
      }

      throw error; // Rethrow para o BullMQ agendar o retry
    }
  },
  { connection: connectionOptions }
);

// 4. Congelador Worker (alimentado pelo repeatable job a cada CONGELADOR_INTERVAL_MS)
export const congeladorWorker = new Worker(
  'congelador',
  async (job: Job) => {
    logger.debug({ jobId: job.id }, 'Processing congelador sweep');
    await runCongelador();
  },
  { connection: connectionOptions }
);

// Start listeners and print logger details
statsWorker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'stats-commit job completed');
});
statsWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'stats-commit job failed');
});

detectorWorker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'detector job completed');
});
detectorWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'detector job failed');
});

repoSetupWorker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'repo-setup job completed');
});
repoSetupWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'repo-setup job failed');
});

congeladorWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'congelador job failed');
});

const allWorkers = [statsWorker, detectorWorker, repoSetupWorker, congeladorWorker];

// Sem um listener de 'error', uma queda momentânea do Redis vira exceção não tratada e
// derruba o processo inteiro. O ioredis reconecta sozinho; basta registrar e seguir.
for (const w of allWorkers) {
  w.on('error', (err) => {
    logger.error({ err: err.message, worker: w.name }, 'Worker connection error');
  });
}

/**
 * Encerra os workers aguardando os jobs em andamento (evita commit pela metade
 * quando o container recebe SIGTERM em um deploy).
 */
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down worker process');
  await Promise.allSettled(allWorkers.map((w) => w.close()));
  await prisma.$disconnect();
  process.exit(0);
}

// Entrypoint: este módulo é executado como processo próprio (`npm run worker`).
// A API (src/index.ts) NÃO o importa — sem este processo nada consome as filas.
if (process.env.NODE_ENV !== 'test') {
  scheduleCongelador().catch((err) => {
    logger.error({ err }, 'Failed to schedule congelador repeatable job');
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info(
    { queues: ['stats-commit', 'detector', 'repo-setup', 'congelador'] },
    'Crivo worker process started'
  );
}
