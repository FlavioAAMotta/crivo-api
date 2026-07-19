import { prisma } from '../lib/prisma.js';
import { serializeBigInt } from '../lib/serializer.js';

export async function getRepositoryMetrics(repoId: number) {
  const repo = await prisma.repositorio.findUnique({
    where: { id: repoId },
    include: {
      trabalho: true,
      usuario: true,
      equipe: {
        include: {
          membros: {
            include: {
              usuario: true,
            },
          },
        },
      },
      entregas: true,
      sinalizacoes: {
        include: {
          revisor: true,
        },
      },
      pushes: {
        orderBy: { recebido_em: 'desc' },
      },
      commits: {
        include: {
          autor_usuario: true,
        },
        orderBy: { committed_em: 'desc' },
      },
    },
  });

  if (!repo) {
    throw new Error('Repository not found');
  }

  // 1. Commit List with details
  const commitsList = repo.commits.map((c) => {
    const pusherLogin = repo.pushes.find(p => p.id === c.push_id)?.pusher_login || 'unknown';
    
    // Check if author declared differs from pusher
    const autorLogin = c.autor_usuario?.github_login;
    const divergente = autorLogin 
      ? autorLogin.toLowerCase() !== pusherLogin.toLowerCase()
      : true; // Unrecognized is treated as divergent for flags

    return {
      id: c.id,
      sha: c.sha,
      mensagem: c.mensagem,
      autor_nome: c.autor_nome,
      autor_email: c.autor_email,
      pusher: pusherLogin,
      divergente,
      additions: c.additions,
      deletions: c.deletions,
      stats_status: c.stats_status,
      committed_em: c.committed_em,
    };
  });

  // 2. Aggregated commits by day for temporal chart (janela_inicio -> deadline)
  const startDate = new Date(repo.trabalho.janela_inicio);
  const endDate = new Date(repo.trabalho.deadline);
  
  // Set times to midnight to calculate days accurately
  const startDay = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const endDay = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  
  const dailyCommits: Record<string, number> = {};
  
  // Pre-populate daily timeline with zeros
  const currentDay = new Date(startDay);
  while (currentDay <= endDay) {
    const dateStr = currentDay.toISOString().split('T')[0];
    dailyCommits[dateStr] = 0;
    currentDay.setDate(currentDay.getDate() + 1);
  }

  // Count commits for each day in range
  for (const c of repo.commits) {
    const commitDateStr = new Date(c.committed_em).toISOString().split('T')[0];
    if (dailyCommits[commitDateStr] !== undefined) {
      dailyCommits[commitDateStr]++;
    }
  }

  const timeline = Object.entries(dailyCommits).map(([date, count]) => ({
    date,
    count,
  })).sort((a, b) => a.date.localeCompare(b.date));

  // 3. % of commits in the last 48 hours
  const now = new Date();
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const commitsInLast48h = repo.commits.filter(c => new Date(c.committed_em) >= fortyEightHoursAgo).length;
  const totalCommitsCount = repo.commits.length;
  const percentLast48h = totalCommitsCount > 0 
    ? Math.round((commitsInLast48h / totalCommitsCount) * 100)
    : 0;

  // 4. Force pushes count
  const forcePushesCount = repo.pushes.filter(p => p.forced).length;

  // 5. Frozen delivery tag if present
  const entrega = repo.entregas[0] || null;

  return serializeBigInt({
    repositorio: {
      id: repo.id,
      nome_completo: repo.nome_completo,
      github_repo_id: repo.github_repo_id,
      criado_em: repo.criado_em,
      dono_tipo: repo.dono_tipo,
      usuario: repo.usuario,
      equipe: repo.equipe,
    },
    trabalho: repo.trabalho,
    total_commits: totalCommitsCount,
    percent_commits_last_48h: percentLast48h,
    force_pushes_count: forcePushesCount,
    entrega_congelada: entrega,
    commits: commitsList,
    timeline_commits: timeline,
    sinalizacoes: repo.sinalizacoes,
  });
}
export default getRepositoryMetrics;
