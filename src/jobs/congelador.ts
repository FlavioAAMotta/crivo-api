import { prisma } from '../lib/prisma.js';
import { getInstallationOctokit, withGithubRetry } from '../lib/octokit.js';
import { logger } from '../lib/logger.js';
import { config } from '../lib/config.js';

export interface CongeladorOptions {
  /** Restringe a varredura a um trabalho. Quando informado, o deadline não precisa ter expirado. */
  trabalhoId?: number;
  /**
   * Cria uma nova entrega mesmo que o repositório já tenha sido congelado antes
   * (ex.: professor prorrogou o prazo e quer uma segunda entrega).
   * Sem force, um repositório já congelado é ignorado — é isso que torna o job
   * repetível a cada 60s seguro.
   */
  force?: boolean;
}

/**
 * Varre os trabalhos com deadline expirado (ou o trabalho informado em `trabalhoId`),
 * obtém o HEAD da branch main de cada repositório, cria a tag `entrega-N` no GitHub e
 * grava o registro de Entrega.
 *
 * N = quantidade de entregas já existentes DAQUELE repositório + 1. A contagem é por
 * repositório, não por trabalho, porque a tag vive no repositório: todos os repositórios
 * recebem `entrega-1` na primeira rodada e só divergem se forem recongelados.
 */
export async function runCongelador(options: CongeladorOptions = {}) {
  const { trabalhoId, force = false } = options;
  logger.info({ trabalhoId, force }, 'Running congelador job to check for expired deadlines');
  const now = new Date();

  try {
    const expiredTrabalhos = await prisma.trabalho.findMany({
      where: trabalhoId
        ? { id: trabalhoId }
        : {
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
        // Idempotência: sem force, um repositório já congelado é pulado.
        if (repo.entregas.length > 0 && !force) {
          logger.debug({ repoName: repo.nome_completo }, 'Repo already frozen in database, skipping');
          continue;
        }

        const repoNameOnly = repo.nome_completo.split('/')[1];
        const tag = `entrega-${repo.entregas.length + 1}`;
        logger.info({ repoId: repo.id, repoName: repo.nome_completo, tag }, 'Freezing repository');

        try {
          // 1. HEAD da branch main
          const branchResponse = await withGithubRetry(() =>
            octokit.rest.repos.getBranch({
              owner: org,
              repo: repoNameOnly,
              branch: 'main',
            })
          );

          const sha = branchResponse.data.commit.sha;

          // 2. Cria refs/tags/entrega-N
          try {
            await withGithubRetry(() =>
              octokit.rest.git.createRef({
                owner: org,
                repo: repoNameOnly,
                ref: `refs/tags/${tag}`,
                sha,
              })
            );
            logger.info({ repoName: repo.nome_completo, sha, tag }, 'Created Git tag on GitHub');
          } catch (gitErr: any) {
            // A tag já existir não é erro: o registro em banco ainda precisa ser gravado.
            const isAlreadyExists = gitErr.status === 422 &&
              (gitErr.message?.toLowerCase().includes('already exists') ||
               JSON.stringify(gitErr.response?.data)?.toLowerCase().includes('already exists'));

            if (isAlreadyExists) {
              logger.info({ repoName: repo.nome_completo, tag }, 'Git tag already exists on GitHub');
            } else {
              throw gitErr;
            }
          }

          // 3. Registra a Entrega
          await prisma.entrega.create({
            data: {
              repositorio_id: repo.id,
              trabalho_id: trabalho.id,
              sha_congelado: sha,
              tag,
              congelado_em: now,
            },
          });

          logger.info({ repoName: repo.nome_completo, tag }, 'Saved Entrega record in database successfully');

        } catch (err: any) {
          logger.error({ err: err.message, repoName: repo.nome_completo }, 'Failed to freeze repository automatically');
        }
      }
    }
  } catch (error: any) {
    logger.error({ error: error.message }, 'Error executing congelador job');
  }
}
