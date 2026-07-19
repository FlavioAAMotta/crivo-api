import { Worker, Job } from 'bullmq';
import { config } from '../lib/config.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { getInstallationOctokit, withGithubRetry } from '../lib/octokit.js';
import { runDetectors } from '../detectors/index.js';
import { enqueueDetectorJob } from './queues.js';

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
