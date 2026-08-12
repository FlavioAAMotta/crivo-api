import { prisma } from '../lib/prisma.js';
import { getInstallationOctokit, withGithubRetry } from '../lib/octokit.js';
import { config } from '../lib/config.js';
import { exigirTrabalhoLiberado } from '../lib/janela.js';
import { logger } from '../lib/logger.js';
import { enqueueRepoSetupJob } from '../jobs/queues.js';

/**
 * Nome fixo do ruleset de proteção da main — usado também para checar idempotência
 * (ver D14 em DECISOES.md) antes de criar, já que POST /rulesets não é idempotente.
 */
const MAIN_RULESET_NAME = 'protect-main';

/**
 * A premissa de D14 (rulesets são gratuitos em repo privado) não vale para uma
 * ORGANIZAÇÃO no plano Free: rulesets em repositórios privados de org exigem
 * Team/Enterprise. Nesse caso o GitHub responde 403 com "Upgrade to GitHub Pro
 * or make this repository public to enable this feature". Isso é uma limitação
 * de plano, não uma falha do setup — o repositório funciona (colaboradores já
 * têm push), só não fica com a proteção aplicada.
 */
function isPlanLimitation(err: any): boolean {
  const msg = String(err?.message ?? '');
  return (
    err?.status === 403 &&
    (/upgrade to github/i.test(msg) || /make this repository public/i.test(msg))
  );
}

/**
 * Sanitizes and normalizes strings to make them safe for GitHub repository names.
 */
export function sanitizeRepoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Executes the post-creation sequence for a generated repository with polling retries.
 * Polling checks if the template contents have been fully populated (so 'main' branch exists),
 * then applies a protection ruleset and adds the student(s) as push collaborator(s).
 *
 * Lança em caso de falha — quem chama (o worker `repo-setup`) cuida do retry.
 */
async function runPostCreationSequence(repoName: string, studentLogins: string[]) {
  const octokit = await getInstallationOctokit();
  const org = config.GITHUB_ORG;

  let mainBranchExists = false;
  const maxPollAttempts = config.repoSetup.pollAttempts;
  const pollIntervalMs = config.repoSetup.pollIntervalMs;

  logger.info({ repoName }, 'Starting post-creation sequence polling for branch main');
  
  for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
    try {
      // Poll to check if the main branch exists
      await octokit.rest.repos.getBranch({
        owner: org,
        repo: repoName,
        branch: 'main',
      });
      
      mainBranchExists = true;
      logger.info({ repoName, attempt }, 'Branch main is ready');
      break;
    } catch (err: any) {
      if (err.status === 404) {
        logger.debug({ repoName, attempt }, 'Branch main not populated yet, waiting...');
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      } else {
        throw err;
      }
    }
  }
  
  if (!mainBranchExists) {
    throw new Error(`Repository ${repoName} main branch was not populated in time. Post-creation aborted.`);
  }
  
  // 1. Add students as collaborators with push permission
  for (const login of studentLogins) {
    logger.info({ repoName, login }, 'Adding collaborator to repository');
    await withGithubRetry(() => 
      octokit.rest.repos.addCollaborator({
        owner: org,
        repo: repoName,
        username: login,
        permission: 'push',
      })
    );
  }
  
  // 2. Protect main branch via Repository Ruleset (bloqueia force-push e deleção).
  //
  // Best-effort DE PROPÓSITO: proteger a main é PREVENÇÃO. O detector de
  // force-push (D2) ainda pega reescrita de histórico DEPOIS do fato via webhook,
  // então a garantia de integridade não depende do ruleset. Se a proteção não
  // puder ser aplicada — tipicamente org no plano Free com repo privado, onde
  // rulesets não estão disponíveis (ver isPlanLimitation e D14) — o repositório
  // continua utilizável (os colaboradores já foram adicionados no passo 1). Não
  // falhamos o setup por isso: marcar ERRO num repo que funciona assustava
  // professor e aluno com uma mensagem de acesso que não condiz com a realidade.
  logger.info({ repoName }, 'Applying protection ruleset to main');
  try {
    await withGithubRetry(async () => {
      // POST /rulesets não é idempotente — se um retry anterior já criou o ruleset
      // (ex.: a resposta se perdeu antes de confirmar), checar por nome evita 422.
      const { data: existing } = await octokit.rest.repos.getRepoRulesets({
        owner: org,
        repo: repoName,
      });
      if (existing.some((r) => r.name === MAIN_RULESET_NAME)) {
        logger.debug({ repoName }, 'protect-main ruleset already exists, skipping creation');
        return;
      }

      await octokit.rest.repos.createRepoRuleset({
        owner: org,
        repo: repoName,
        name: MAIN_RULESET_NAME,
        target: 'branch',
        enforcement: 'active',
        conditions: {
          ref_name: { include: ['refs/heads/main'], exclude: [] },
        },
        rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }],
      });
    });
    logger.info({ repoName }, 'Protection ruleset applied to main');
  } catch (err: any) {
    if (isPlanLimitation(err)) {
      logger.warn(
        { repoName },
        'Proteção da main indisponível no plano/visibilidade atuais (org Free + repo privado). Repo configurado sem proteção; force-push segue detectável pelo webhook.',
      );
    } else {
      logger.warn(
        { repoName, err: err?.message },
        'Falha ao aplicar o ruleset de proteção; seguindo sem proteção (repo utilizável).',
      );
    }
  }

  logger.info({ repoName }, 'Post-creation sequence completed successfully');
}

/**
 * Configura um repositório já criado: aguarda a branch main, adiciona colaboradores e
 * aplica o ruleset de proteção. Em sucesso marca CONFIGURADO; em falha propaga o erro para
 * o worker decidir entre novo retry e marcar ERRO (ver markRepoSetupFailed).
 */
export async function configureRepository(repoId: number) {
  const repo = await prisma.repositorio.findUnique({
    where: { id: repoId },
    include: {
      usuario: true,
      equipe: {
        include: {
          membros: { include: { usuario: true } },
        },
      },
    },
  });

  if (!repo) {
    throw new Error(`Repository ${repoId} not found`);
  }

  const repoNameOnly = repo.nome_completo.split('/')[1];
  const studentLogins = repo.dono_tipo === 'ALUNO'
    ? (repo.usuario ? [repo.usuario.github_login!] : [])
    : repo.equipe?.membros
        .map((m) => m.usuario.github_login)
        .filter((login): login is string => login !== null) ?? [];

  await prisma.repositorio.update({
    where: { id: repoId },
    data: { setup_tentativas: { increment: 1 } },
  });

  await runPostCreationSequence(repoNameOnly, studentLogins);

  await prisma.repositorio.update({
    where: { id: repoId },
    data: { setup_status: 'CONFIGURADO', setup_erro: null },
  });

  logger.info({ repoId, repoName: repo.nome_completo }, 'Repository setup completed');
}

/**
 * Marca o repositório como ERRO após esgotar os retries, deixando a causa visível
 * para o professor no dashboard.
 */
export async function markRepoSetupFailed(repoId: number, message: string) {
  await prisma.repositorio.update({
    where: { id: repoId },
    data: { setup_status: 'ERRO', setup_erro: message.slice(0, 500) },
  }).catch((err) => {
    logger.error({ err, repoId }, 'Failed to persist repo setup ERRO status');
  });
}

/**
 * Creates a repository for an individual student for a given trabalho.
 */
export async function createRepositoryForStudent(usuarioId: number, trabalhoId: number) {
  // Fetch user, trabalho, and check matricula
  const user = await prisma.usuario.findUnique({
    where: { id: usuarioId },
  });
  
  if (!user) {
    throw new Error('User not found');
  }
  
  const trabalho = await prisma.trabalho.findUnique({
    where: { id: trabalhoId },
    include: {
      turma: {
        include: {
          disciplina: true,
          matriculas: true,
        },
      },
    },
  });
  
  if (!trabalho) {
    throw new Error('Trabalho not found');
  }

  // O trabalho ainda fechado não gera repositório: o repositório é o template
  // do enunciado, criá-lo antes entregaria justamente o que a janela esconde.
  exigirTrabalhoLiberado(trabalho.janela_inicio);

  // Validate student is matriculated in the class
  const isMatriculated = trabalho.turma.matriculas.some(m => m.usuario_id === usuarioId);
  if (!isMatriculated) {
    throw new Error('Student is not matriculated in this class');
  }
  
  // Validate that a repository doesn't already exist
  const existingRepo = await prisma.repositorio.findFirst({
    where: {
      trabalho_id: trabalhoId,
      usuario_id: usuarioId,
    },
  });
  
  if (existingRepo) {
    throw new Error('Repository already exists for this student and trabalho');
  }
  
  // Naming format: {codigo-disciplina}-{trabalho-slug}-{login-aluno} normalized
  const baseName = `${trabalho.turma.disciplina.codigo}-${trabalho.slug}-${user.github_login!}`;
  const repoName = sanitizeRepoName(baseName);
  const fullName = `${config.GITHUB_ORG}/${repoName}`;
  
  // Destructure owner and name from template_repo (owner/repo)
  const templateParts = trabalho.template_repo.split('/');
  if (templateParts.length !== 2) {
    throw new Error('Invalid template_repo format in trabalho configuration (must be owner/repo)');
  }
  const [templateOwner, templateRepo] = templateParts;
  
  logger.info({ repoName, templateOwner, templateRepo }, 'Generating student repository from template');
  
  const octokit = await getInstallationOctokit();
  
  // Generate repo from template
  let githubRepo;
  try {
    const response = await withGithubRetry(() =>
      octokit.rest.repos.createUsingTemplate({
        template_owner: templateOwner,
        template_repo: templateRepo,
        owner: config.GITHUB_ORG,
        name: repoName,
        description: `Repositório para o trabalho "${trabalho.titulo}" - ${user.nome}`,
        private: true,
      })
    );
    githubRepo = response.data;
  } catch (error: any) {
    logger.error({ error, repoName }, 'GitHub API failed to generate repository');
    throw new Error(`Failed to generate repository on GitHub: ${error.message}`);
  }
  
  // Persist repository in Database
  const dbRepo = await prisma.repositorio.create({
    data: {
      trabalho_id: trabalhoId,
      dono_tipo: 'ALUNO',
      usuario_id: usuarioId,
      github_repo_id: BigInt(githubRepo.id),
      nome_completo: fullName,
    },
  });

  // A configuração roda no worker, com retry e backoff: o template ainda pode estar
  // sendo populado pelo GitHub neste instante.
  await enqueueRepoSetupJob(dbRepo.id);

  return dbRepo;
}

/**
 * Creates a repository for a team for a given trabalho.
 */
export async function createRepositoryForTeam(equipeId: number, trabalhoId: number) {
  const equipe = await prisma.equipe.findUnique({
    where: { id: equipeId },
    include: {
      membros: {
        include: {
          usuario: true,
        },
      },
    },
  });
  
  if (!equipe) {
    throw new Error('Team not found');
  }
  
  const trabalho = await prisma.trabalho.findUnique({
    where: { id: trabalhoId },
    include: {
      turma: {
        include: {
          disciplina: true,
        },
      },
    },
  });
  
  if (!trabalho) {
    throw new Error('Trabalho not found');
  }

  // Mesma trava do individual: a equipe pode ser montada antes da abertura, o
  // repositório dela não.
  exigirTrabalhoLiberado(trabalho.janela_inicio);

  // Validate that a repository doesn't already exist
  const existingRepo = await prisma.repositorio.findFirst({
    where: {
      trabalho_id: trabalhoId,
      equipe_id: equipeId,
    },
  });
  
  if (existingRepo) {
    throw new Error('Repository already exists for this team and trabalho');
  }
  
  if (equipe.membros.length === 0) {
    throw new Error('Team has no members');
  }
  
  // Naming format: {codigo-disciplina}-{trabalho-slug}-{equipe-nome} normalized
  const baseName = `${trabalho.turma.disciplina.codigo}-${trabalho.slug}-${equipe.nome}`;
  const repoName = sanitizeRepoName(baseName);
  const fullName = `${config.GITHUB_ORG}/${repoName}`;
  
  const templateParts = trabalho.template_repo.split('/');
  if (templateParts.length !== 2) {
    throw new Error('Invalid template_repo format in trabalho configuration (must be owner/repo)');
  }
  const [templateOwner, templateRepo] = templateParts;
  
  logger.info({ repoName, templateOwner, templateRepo }, 'Generating team repository from template');
  
  const octokit = await getInstallationOctokit();
  
  let githubRepo;
  try {
    const response = await withGithubRetry(() =>
      octokit.rest.repos.createUsingTemplate({
        template_owner: templateOwner,
        template_repo: templateRepo,
        owner: config.GITHUB_ORG,
        name: repoName,
        description: `Repositório de equipe para o trabalho "${trabalho.titulo}" - ${equipe.nome}`,
        private: true,
      })
    );
    githubRepo = response.data;
  } catch (error: any) {
    logger.error({ error, repoName }, 'GitHub API failed to generate team repository');
    throw new Error(`Failed to generate repository on GitHub: ${error.message}`);
  }
  
  // Persist repository in Database
  const dbRepo = await prisma.repositorio.create({
    data: {
      trabalho_id: trabalhoId,
      dono_tipo: 'EQUIPE',
      equipe_id: equipeId,
      github_repo_id: BigInt(githubRepo.id),
      nome_completo: fullName,
    },
  });

  await enqueueRepoSetupJob(dbRepo.id);

  return dbRepo;
}
