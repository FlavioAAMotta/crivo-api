import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * Liga a commits já gravados os e-mails que o aluno cadastrou depois.
 *
 * O webhook resolve `autor_usuario_id` **uma única vez**, no instante em que o
 * push chega (`src/routes/webhooks.ts`): se o `EmailCommit` ainda não existia,
 * o commit fica órfão para sempre. Cadastrar o e-mail depois — no onboarding,
 * no perfil, ou pela prepopulação do OAuth — não reprocessava nada, e o commit
 * seguia como "autor não reconhecido", que `getRepositoryMetrics` conta como
 * divergente. Na prática o professor via "N de N com autor declarado ≠ quem
 * enviou o push" num repositório onde autor e pusher são a mesma pessoa.
 *
 * Só toca em commits órfãos (`autor_usuario_id: null`): um commit já atribuído
 * a outro usuário não é reatribuído aqui — a unicidade global de
 * `EmailCommit.email` é quem garante que dois alunos não reivindiquem o mesmo
 * endereço.
 *
 * @param emails e-mails que comprovadamente pertencem a `usuarioId`
 * @returns quantidade de commits vinculados
 */
export async function vincularCommitsOrfaos(usuarioId: number, emails: string[]): Promise<number> {
  const alvos = [...new Set(emails.filter(Boolean).map((e) => e.toLowerCase()))];
  if (alvos.length === 0) return 0;

  const { count } = await prisma.commit.updateMany({
    where: {
      autor_usuario_id: null,
      autor_email: { in: alvos },
    },
    data: { autor_usuario_id: usuarioId },
  });

  if (count > 0) {
    logger.info({ usuarioId, emails: alvos, commits: count }, 'Commits órfãos vinculados ao autor');
  }

  return count;
}
