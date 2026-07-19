import { prisma } from '../lib/prisma.js';
import { getInstallationOctokit, withGithubRetry } from '../lib/octokit.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

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
 * then applies branch protection and adds the student(s) as push collaborator(s).
 */
async function runPostCreationSequence(repoName: string, studentLogins: string[]) {
  const octokit = await getInstallationOctokit();
  const org = config.GITHUB_ORG;
  
  let mainBranchExists = false;
  const maxPollAttempts = 10;
  const pollIntervalMs = 2000;
  
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
  
  // 2. Protect main branch (block force push and deletions)
  logger.info({ repoName }, 'Applying branch protection to main');
  await withGithubRetry(() =>
    octokit.rest.repos.updateBranchProtection({
      owner: org,
      repo: repoName,
      branch: 'main',
      enforce_admins: true, // Blocks force push for everyone, including admin tokens
      required_status_checks: null,
      required_pull_request_reviews: null,
      restrictions: null,
    })
  );
  
  logger.info({ repoName }, 'Post-creation sequence completed successfully');
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
  const baseName = `${trabalho.turma.disciplina.codigo}-${trabalho.slug}-${user.github_login}`;
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
      octokit.rest.repos.generate({
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
  
  // Run the asynchronous post-creation setup (wait for main, set protection, add collaborator)
  try {
    await runPostCreationSequence(repoName, [user.github_login]);
  } catch (err: any) {
    logger.error({ err, repoName }, 'Post-creation configuration sequence failed');
    // We do not delete the repo, but log the error so the teacher can debug.
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
      octokit.rest.repos.generate({
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
  
  // Run the asynchronous post-creation setup for all members of the team
  const studentLogins = equipe.membros.map(m => m.usuario.github_login);
  try {
    await runPostCreationSequence(repoName, studentLogins);
  } catch (err: any) {
    logger.error({ err, repoName }, 'Post-creation configuration sequence failed for team');
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
  
  return dbRepo;
}
