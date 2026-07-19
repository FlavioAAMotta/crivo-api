import { prisma } from '../lib/prisma.js';
import { getInstallationOctokit, withGithubRetry } from '../lib/octokit.js';
import { logger } from '../lib/logger.js';
import { config } from '../lib/config.js';

/**
 * Sweeps all active trabalhos where deadline has expired, obtains the HEAD SHA of their main branch,
 * creates a git tag 'entrega-1' on GitHub, and creates an Entrega record in the DB.
 */
export async function runCongelador() {
  logger.info('Running congelador job to check for expired deadlines');
  const now = new Date();

  try {
    const expiredTrabalhos = await prisma.trabalho.findMany({
      where: {
        congelamento_automatico: true,
        deadline: { lte: now },
      },
      include: {
        repositorios: {
          include: {
            entregas: true,
          },
        },
      },
    });

    if (expiredTrabalhos.length === 0) {
      logger.debug('No expired trabalhos found for freezing');
      return;
    }

    const octokit = await getInstallationOctokit();
    const org = config.GITHUB_ORG;

    for (const trabalho of expiredTrabalhos) {
      for (const repo of trabalho.repositorios) {
        // Idempotency: Skip if already frozen in DB
        if (repo.entregas.length > 0) {
          logger.debug({ repoName: repo.nome_completo }, 'Repo already frozen in database, skipping');
          continue;
        }

        const repoNameOnly = repo.nome_completo.split('/')[1];
        logger.info({ repoId: repo.id, repoName: repo.nome_completo }, 'Freezing repository');

        try {
          // 1. Get HEAD commit of main branch
          const branchResponse = await withGithubRetry(() =>
            octokit.rest.repos.getBranch({
              owner: org,
              repo: repoNameOnly,
              branch: 'main',
            })
          );
          
          const sha = branchResponse.data.commit.sha;

          // 2. Create git ref refs/tags/entrega-1
          try {
            await withGithubRetry(() =>
              octokit.rest.git.createRef({
                owner: org,
                repo: repoNameOnly,
                ref: 'refs/tags/entrega-1',
                sha,
              })
            );
            logger.info({ repoName: repo.nome_completo, sha }, 'Created Git tag refs/tags/entrega-1 on GitHub');
          } catch (gitErr: any) {
            // Handle if reference already exists (422 status code)
            const isAlreadyExists = gitErr.status === 422 && 
              (gitErr.message?.toLowerCase().includes('already exists') || 
               JSON.stringify(gitErr.response?.data)?.toLowerCase().includes('already exists'));
            
            if (isAlreadyExists) {
              logger.info({ repoName: repo.nome_completo }, 'Git tag refs/tags/entrega-1 already exists on GitHub');
            } else {
              throw gitErr;
            }
          }

          // 3. Save Entrega record in DB
          await prisma.entrega.create({
            data: {
              repositorio_id: repo.id,
              trabalho_id: trabalho.id,
              sha_congelado: sha,
              tag: 'entrega-1',
              congelado_em: now,
            },
          });
          
          logger.info({ repoName: repo.nome_completo }, 'Saved Entrega record in database successfully');

        } catch (err: any) {
          logger.error({ err: err.message, repoName: repo.nome_completo }, 'Failed to freeze repository automatically');
        }
      }
    }
  } catch (error: any) {
    logger.error({ error: error.message }, 'Error executing congelador job');
  }
}
