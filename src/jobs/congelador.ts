import { prisma } from '../lib/prisma.js';
import { getInstallationOctokit, withGithubRetry } from '../lib/octokit.js';
import { logger } from '../lib/logger.js';
import { config } from '../lib/config.js';

type Octokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

interface RepoParaCongelar {
  id: number;
  nome_completo: string;
  entregas: { entrega_agendada_id: number | null }[];
}

export interface CongeladorOptions {
  /** Restringe a varredura clássica (por deadline) a um trabalho. */
  trabalhoId?: number;
  /**
   * Restringe o congelamento a um marco (`EntregaAgendada`) específico, em vez
   * do deadline único do trabalho. Usado pelo endpoint
   * `POST /prof/trabalhos/:id/entregas-agendadas/:entregaAgendadaId/congelar`.
   */
  entregaAgendadaId?: number;
  /**
   * Cria uma nova entrega mesmo que o repositório já tenha sido congelado antes
   * (ex.: professor prorrogou o prazo e quer uma segunda entrega).
   * Sem force, um repositório já congelado é ignorado — é isso que torna o job
   * repetível a cada 60s seguro.
   */
  force?: boolean;
}

/**
 * Cria a tag `entrega-N` no GitHub (N = quantidade de entregas já existentes
 * DAQUELE repositório + 1, contagem por repositório, compartilhada entre o
 * deadline clássico e qualquer marco agendado) e grava a `Entrega`.
 * `entregaAgendadaId: null` é a entrega do deadline único do trabalho.
 */
async function congelarRepositorio(params: {
  octokit: Octokit;
  org: string;
  repo: RepoParaCongelar;
  trabalhoId: number;
  entregaAgendadaId: number | null;
  sha: string;
}) {
  const { octokit, org, repo, trabalhoId, entregaAgendadaId, sha } = params;
  const repoNameOnly = repo.nome_completo.split('/')[1];
  const tag = `entrega-${repo.entregas.length + 1}`;
  logger.info({ repoId: repo.id, repoName: repo.nome_completo, tag, entregaAgendadaId }, 'Freezing repository');

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

  await prisma.entrega.create({
    data: {
      repositorio_id: repo.id,
      trabalho_id: trabalhoId,
      entrega_agendada_id: entregaAgendadaId,
      sha_congelado: sha,
      tag,
      congelado_em: new Date(),
    },
  });

  logger.info({ repoName: repo.nome_completo, tag }, 'Saved Entrega record in database successfully');
}

/**
 * Varredura clássica: trabalhos com `deadline` expirado (ou o `trabalhoId`
 * informado, ignorando o deadline). Pega o HEAD atual de `main` — inalterado
 * desde antes dos marcos agendados existirem.
 */
async function congelarPorDeadline(params: { octokit: Octokit; org: string; trabalhoId?: number; force: boolean }) {
  const { octokit, org, trabalhoId, force } = params;
  const now = new Date();

  const expiredTrabalhos = await prisma.trabalho.findMany({
    where: trabalhoId
      ? { id: trabalhoId }
      : {
          congelamento_automatico: true,
          deadline: { lte: now },
        },
    include: {
      repositorios: {
        include: { entregas: true },
      },
    },
  });

  if (expiredTrabalhos.length === 0) {
    logger.debug('No expired trabalhos found for freezing (deadline)');
    return;
  }

  for (const trabalho of expiredTrabalhos) {
    for (const repo of trabalho.repositorios) {
      // Idempotência: sem force, um repositório que já tem a entrega do
      // deadline clássico (entrega_agendada_id null) é pulado. Entregas de
      // marcos agendados não contam aqui — são independentes.
      const jaCongelado = repo.entregas.some((e) => e.entrega_agendada_id === null);
      if (jaCongelado && !force) {
        logger.debug({ repoName: repo.nome_completo }, 'Repo already frozen (deadline), skipping');
        continue;
      }

      try {
        const repoNameOnly = repo.nome_completo.split('/')[1];
        const branchResponse = await withGithubRetry(() =>
          octokit.rest.repos.getBranch({
            owner: org,
            repo: repoNameOnly,
            branch: 'main',
          })
        );

        await congelarRepositorio({
          octokit,
          org,
          repo,
          trabalhoId: trabalho.id,
          entregaAgendadaId: null,
          sha: branchResponse.data.commit.sha,
        });
      } catch (err: any) {
        logger.error({ err: err.message, repoName: repo.nome_completo }, 'Failed to freeze repository automatically (deadline)');
      }
    }
  }
}

type MarcoComRepositorios = {
  id: number;
  trabalho_id: number;
  data_hora: Date;
  trabalho: { repositorios: RepoParaCongelar[] };
};

/**
 * Congela os repositórios de UM marco agendado. Usa o commit que era HEAD de
 * `main` NA DATA do marco (`listCommits ... until`), nunca o HEAD atual — é o
 * que faz um marco no passado (entrega retroativa) e um marco recém-vencido
 * se comportarem da mesma forma, sem depender de rodar exatamente na hora.
 */
async function congelarUmMarco(params: { octokit: Octokit; org: string; marco: MarcoComRepositorios; force: boolean }) {
  const { octokit, org, marco, force } = params;

  for (const repo of marco.trabalho.repositorios) {
    const jaCongelado = repo.entregas.some((e) => e.entrega_agendada_id === marco.id);
    if (jaCongelado && !force) {
      logger.debug({ repoName: repo.nome_completo, entregaAgendadaId: marco.id }, 'Repo already frozen for this marco, skipping');
      continue;
    }

    try {
      const repoNameOnly = repo.nome_completo.split('/')[1];
      const commitsResponse = await withGithubRetry(() =>
        octokit.rest.repos.listCommits({
          owner: org,
          repo: repoNameOnly,
          sha: 'main',
          until: marco.data_hora.toISOString(),
          per_page: 1,
        })
      );

      const sha = commitsResponse.data[0]?.sha;
      if (!sha) {
        // Repositório sem nenhum commit até a data do marco: nada a congelar.
        logger.info({ repoName: repo.nome_completo, entregaAgendadaId: marco.id }, 'No commit found before the marco date, skipping');
        continue;
      }

      await congelarRepositorio({
        octokit,
        org,
        repo,
        trabalhoId: marco.trabalho_id,
        entregaAgendadaId: marco.id,
        sha,
      });
    } catch (err: any) {
      logger.error({ err: err.message, repoName: repo.nome_completo, entregaAgendadaId: marco.id }, 'Failed to freeze repository for marco');
    }
  }
}

async function congelarMarcoPorId(params: { octokit: Octokit; org: string; entregaAgendadaId: number; force: boolean }) {
  const { octokit, org, entregaAgendadaId, force } = params;

  const marco = await prisma.entregaAgendada.findUnique({
    where: { id: entregaAgendadaId },
    include: { trabalho: { include: { repositorios: { include: { entregas: true } } } } },
  });

  if (!marco) {
    logger.warn({ entregaAgendadaId }, 'EntregaAgendada not found for congelamento');
    return;
  }

  await congelarUmMarco({ octokit, org, marco, force });
}

/** Varredura automática dos marcos agendados vencidos (parte do repeatable job). */
async function congelarMarcosVencidos(params: { octokit: Octokit; org: string }) {
  const { octokit, org } = params;
  const now = new Date();

  const marcos = await prisma.entregaAgendada.findMany({
    where: { congelamento_automatico: true, data_hora: { lte: now } },
    include: { trabalho: { include: { repositorios: { include: { entregas: true } } } } },
  });

  if (marcos.length === 0) {
    logger.debug('No due EntregaAgendada marcos found for freezing');
    return;
  }

  for (const marco of marcos) {
    await congelarUmMarco({ octokit, org, marco, force: false });
  }
}

/**
 * Congela entregas: pelo deadline único do trabalho (comportamento original,
 * `options.entregaAgendadaId` ausente) ou por um marco agendado específico
 * (`options.entregaAgendadaId`). Dois chamadores do modo clássico: o
 * repeatable job (sem argumentos — também varre marcos vencidos) e
 * `POST /prof/trabalhos/:id/congelar` (escopado a um trabalho). O modo por
 * marco é usado por `POST .../entregas-agendadas/:id/congelar`.
 */
export async function runCongelador(options: CongeladorOptions = {}) {
  const { trabalhoId, entregaAgendadaId, force = false } = options;
  logger.info({ trabalhoId, entregaAgendadaId, force }, 'Running congelador job to check for expired deadlines');

  try {
    const octokit = await getInstallationOctokit();
    const org = config.GITHUB_ORG;

    if (entregaAgendadaId) {
      await congelarMarcoPorId({ octokit, org, entregaAgendadaId, force });
      return;
    }

    await congelarPorDeadline({ octokit, org, trabalhoId, force });

    // A varredura repetível (sem trabalhoId) também cobre os marcos agendados
    // vencidos. O endpoint manual de um trabalho específico, sem
    // entregaAgendadaId, mantém o escopo só no deadline clássico.
    if (!trabalhoId) {
      await congelarMarcosVencidos({ octokit, org });
    }
  } catch (error: any) {
    logger.error({ error: error.message }, 'Error executing congelador job');
  }
}
