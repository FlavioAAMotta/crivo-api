import { prisma } from '../lib/prisma.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { SinalizacaoTipo, SinalizacaoIntensidade } from '@prisma/client';

/**
 * Runs all detectors for a given repository.
 */
export async function runDetectors(repoId: number, trigger: string) {
  logger.info({ repoId, trigger }, 'Running detectors for repository');
  
  try {
    const repo = await prisma.repositorio.findUnique({
      where: { id: repoId },
      include: {
        trabalho: {
          include: {
            turma: {
              include: {
                matriculas: {
                  include: {
                    usuario: true,
                  },
                },
              },
            },
          },
        },
        usuario: true, // Owner student if individual
        equipe: {
          include: {
            membros: {
              include: {
                usuario: true,
              },
            },
          },
        },
      },
    });

    if (!repo) {
      logger.error({ repoId }, 'Repository not found for detection run');
      return;
    }

    // Run each detector
    await detectDivergencia(repo);
    await detectSemAtividade(repo);
    await detectCommitGigante(repo);
    await detectForcePush(repo);
    await detectAutorNaoReconhecido(repo);
    
  } catch (error) {
    logger.error({ error, repoId }, 'Error running detectors');
  }
}

/**
 * Helper to check if a pending signal of the same type and repository already exists.
 * If yes, we skip to avoid duplicates.
 */
async function hasPendingSignal(repoId: number, tipo: SinalizacaoTipo): Promise<boolean> {
  const signal = await prisma.sinalizacao.findFirst({
    where: {
      repositorio_id: repoId,
      tipo,
      status: 'PENDENTE',
    },
  });
  return !!signal;
}

/**
 * Helper to create a new signal if it doesn't already exist in PENDING state.
 */
async function createSignal(
  repoId: number,
  tipo: SinalizacaoTipo,
  intensidade: SinalizacaoIntensidade,
  evidencia: any
) {
  if (await hasPendingSignal(repoId, tipo)) {
    logger.debug({ repoId, tipo }, 'Pending signal already exists, skipping creation');
    return;
  }

  const signal = await prisma.sinalizacao.create({
    data: {
      repositorio_id: repoId,
      tipo,
      intensidade,
      evidencia_json: evidencia,
      status: 'PENDENTE',
    },
  });
  
  logger.info({ repoId, tipo, signalId: signal.id }, 'Generated new signal successfully');
}

/**
 * 1. DIVERGENCIA_PUSHER_AUTOR
 */
async function detectDivergencia(repo: any) {
  const repoId = repo.id;
  const isIndividual = repo.dono_tipo === 'ALUNO';

  if (isIndividual) {
    const owner = repo.usuario;
    if (!owner) return;
    
    // Check Pushes: any push where pusher_github_id !== owner.github_id
    const suspiciousPushes = await prisma.push.findMany({
      where: {
        repositorio_id: repoId,
        pusher_github_id: { not: owner.github_id },
      },
    });

    if (suspiciousPushes.length > 0) {
      const lastPush = suspiciousPushes[suspiciousPushes.length - 1];
      await createSignal(repoId, 'DIVERGENCIA_PUSHER_AUTOR', 'ALTA', {
        context: 'individual_pusher_mismatch',
        pusher_login: lastPush.pusher_login,
        pusher_github_id: lastPush.pusher_github_id.toString(),
        owner_login: owner.github_login,
        owner_github_id: owner.github_id.toString(),
      });
      return;
    }

    // Check Commits: any commit with a resolved author that is not the owner
    const suspiciousCommits = await prisma.commit.findMany({
      where: {
        repositorio_id: repoId,
        autor_usuario_id: {
          not: null,
          notIn: [owner.id],
        },
      },
      include: {
        autor_usuario: true,
      },
    });

    if (suspiciousCommits.length > 0) {
      const lastCommit = suspiciousCommits[suspiciousCommits.length - 1];
      await createSignal(repoId, 'DIVERGENCIA_PUSHER_AUTOR', 'MEDIA', {
        context: 'individual_author_mismatch',
        commit_sha: lastCommit.sha,
        resolved_author_login: lastCommit.autor_usuario?.github_login,
        resolved_author_email: lastCommit.autor_email,
        owner_login: owner.github_login,
      });
    }
  } else {
    // Team Divergence (systematic pattern)
    // Check if one pusher is responsible for >70% of pushes, with >=3 author emails, and >=10 commits
    const totalCommits = await prisma.commit.count({
      where: { repositorio_id: repoId },
    });
    
    if (totalCommits < config.detectors.divergenciaEquipe.minCommits) {
      return;
    }

    const uniqueAuthorsList = await prisma.commit.groupBy({
      by: ['autor_email'],
      where: { repositorio_id: repoId },
    });
    
    if (uniqueAuthorsList.length < config.detectors.divergenciaEquipe.minAuthors) {
      return;
    }

    // Aggregate pushes by pusher
    const pushes = await prisma.push.findMany({
      where: { repositorio_id: repoId },
    });
    
    const totalPushes = pushes.length;
    if (totalPushes === 0) return;

    const pushCountsByPusher: Record<string, number> = {};
    for (const p of pushes) {
      pushCountsByPusher[p.pusher_login] = (pushCountsByPusher[p.pusher_login] || 0) + 1;
    }

    for (const [pusher, count] of Object.entries(pushCountsByPusher)) {
      const percent = count / totalPushes;
      if (percent > config.detectors.divergenciaEquipe.thresholdPushPercent) {
        await createSignal(repoId, 'DIVERGENCIA_PUSHER_AUTOR', 'MEDIA', {
          context: 'team_systematic_push_divergence',
          dominant_pusher: pusher,
          pusher_pushes: count,
          total_pushes: totalPushes,
          push_percentage: Math.round(percent * 100),
          unique_authors_count: uniqueAuthorsList.length,
          total_commits: totalCommits,
        });
        break; // Triggered for dominant pusher
      }
    }
  }
}

/**
 * 2. SEM_ATIVIDADE
 */
async function detectSemAtividade(repo: any) {
  const repoId = repo.id;
  const deadline = new Date(repo.trabalho.deadline);
  const now = new Date();
  
  // Skip if deadline is already past and entrega exists
  const entrega = await prisma.entrega.findFirst({
    where: { repositorio_id: repoId },
  });
  if (entrega) return;

  const thresholdDays = config.detectors.semAtividade.defaultDays;
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(now.getTime() - thresholdMs);

  // Calculate intensity based on distance to deadline
  const timeToDeadlineMs = deadline.getTime() - now.getTime();
  let intensidade: SinalizacaoIntensidade = 'BAIXA';
  if (timeToDeadlineMs <= 2 * 24 * 60 * 60 * 1000) {
    intensidade = 'ALTA'; // Under 48h
  } else if (timeToDeadlineMs <= 5 * 24 * 60 * 60 * 1000) {
    intensidade = 'MEDIA'; // Under 5 days
  }

  if (repo.dono_tipo === 'ALUNO') {
    const owner = repo.usuario;
    if (!owner) return;

    // Find last commit by this owner
    const lastCommit = await prisma.commit.findFirst({
      where: {
        repositorio_id: repoId,
        autor_usuario_id: owner.id,
      },
      orderBy: { committed_em: 'desc' },
    });

    const lastActivityDate = lastCommit ? new Date(lastCommit.committed_em) : new Date(repo.trabalho.janela_inicio);
    if (lastActivityDate < cutoffDate) {
      const daysInactive = Math.round((now.getTime() - lastActivityDate.getTime()) / (24 * 60 * 60 * 1000));
      await createSignal(repoId, 'SEM_ATIVIDADE', intensidade, {
        context: 'individual_no_activity',
        github_login: owner.github_login,
        days_inactive: daysInactive,
        last_activity_date: lastActivityDate.toISOString(),
      });
    }
  } else {
    // Group: check if ANY team member is inactive for >= thresholdDays
    const members = repo.equipe?.membros || [];
    for (const member of members) {
      const student = member.usuario;
      const lastCommit = await prisma.commit.findFirst({
        where: {
          repositorio_id: repoId,
          autor_usuario_id: student.id,
        },
        orderBy: { committed_em: 'desc' },
      });

      const lastActivityDate = lastCommit ? new Date(lastCommit.committed_em) : new Date(repo.trabalho.janela_inicio);
      if (lastActivityDate < cutoffDate) {
        const daysInactive = Math.round((now.getTime() - lastActivityDate.getTime()) / (24 * 60 * 60 * 1000));
        await createSignal(repoId, 'SEM_ATIVIDADE', intensidade, {
          context: 'team_member_no_activity',
          github_login: student.github_login,
          days_inactive: daysInactive,
          last_activity_date: lastActivityDate.toISOString(),
        });
      }
    }
  }
}

/**
 * 3. COMMIT_GIGANTE (only counts CALCULADO commits)
 */
async function detectCommitGigante(repo: any) {
  const repoId = repo.id;
  const deadline = new Date(repo.trabalho.deadline);
  
  // Calculate total additions inside the repo for CALCULADO commits
  const aggregations = await prisma.commit.aggregate({
    _sum: {
      additions: true,
    },
    where: {
      repositorio_id: repoId,
      stats_status: 'CALCULADO',
    },
  });

  const totalAdditions = aggregations._sum.additions || 0;
  if (totalAdditions === 0) return;

  // Find commits that are CALCULADO, additions >= 50% of total additions, 
  // and committed within 24 hours of the deadline.
  const twentyFourHours = 24 * 60 * 60 * 1000;
  const deadlineStart = new Date(deadline.getTime() - twentyFourHours);

  const giantCommits = await prisma.commit.findMany({
    where: {
      repositorio_id: repoId,
      stats_status: 'CALCULADO',
      additions: {
        gte: Math.round(totalAdditions * config.detectors.commitGigante.linePercent),
      },
      committed_em: {
        gte: deadlineStart,
        lte: deadline,
      },
    },
  });

  for (const c of giantCommits) {
    const percent = Math.round((c.additions || 0) / totalAdditions * 100);
    await createSignal(repoId, 'COMMIT_GIGANTE', 'ALTA', {
      commit_sha: c.sha,
      commit_additions: c.additions,
      total_additions: totalAdditions,
      percentage: percent,
      committed_em: c.committed_em.toISOString(),
      deadline: deadline.toISOString(),
    });
  }
}

/**
 * 4. FORCE_PUSH
 */
async function detectForcePush(repo: any) {
  const repoId = repo.id;
  
  const forcePushes = await prisma.push.findMany({
    where: {
      repositorio_id: repoId,
      forced: true,
    },
  });

  if (forcePushes.length > 0) {
    const lastForce = forcePushes[forcePushes.length - 1];
    await createSignal(repoId, 'FORCE_PUSH', 'ALTA', {
      push_id: lastForce.id,
      pusher_login: lastForce.pusher_login,
      ref: lastForce.ref,
      recebido_em: lastForce.recebido_em.toISOString(),
    });
  }
}

/**
 * 5. AUTOR_NAO_RECONHECIDO
 */
async function detectAutorNaoReconhecido(repo: any) {
  const repoId = repo.id;

  const unrecognizedCommits = await prisma.commit.findMany({
    where: {
      repositorio_id: repoId,
      autor_usuario_id: null,
    },
  });

  if (unrecognizedCommits.length > 0) {
    const lastCommit = unrecognizedCommits[unrecognizedCommits.length - 1];
    await createSignal(repoId, 'AUTOR_NAO_RECONHECIDO', 'BAIXA', {
      commit_sha: lastCommit.sha,
      autor_nome: lastCommit.autor_nome,
      autor_email: lastCommit.autor_email,
      committed_em: lastCommit.committed_em.toISOString(),
    });
  }
}
