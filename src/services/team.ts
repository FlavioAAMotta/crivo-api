import { prisma } from '../lib/prisma.js';

/**
 * Creates a new team for a given work (trabalho), adding the creator as the first member.
 */
export async function createTeam(trabalhoId: number, nome: string, creatorId: number) {
  const trabalho = await prisma.trabalho.findUnique({
    where: { id: trabalhoId },
    include: {
      turma: {
        include: {
          matriculas: true,
        },
      },
    },
  });

  if (!trabalho) {
    throw new Error('Trabalho not found');
  }

  if (trabalho.tipo !== 'EQUIPE') {
    throw new Error('This trabalho does not accept teams');
  }

  // Verify creator is matriculated in the class
  const isCreatorMatriculated = trabalho.turma.matriculas.some(m => m.usuario_id === creatorId);
  if (!isCreatorMatriculated) {
    throw new Error('Creator is not matriculated in this class');
  }

  const equipeExistente = await prisma.equipeMembro.findFirst({
    where: { usuario_id: creatorId, equipe: { trabalho_id: trabalhoId } },
  });
  if (equipeExistente) throw new TeamError('Student already belongs to a team in this trabalho', 409);

  // Create team and add creator as member in a transaction
  return prisma.$transaction(async (tx) => {
    const equipe = await tx.equipe.create({
      data: {
        trabalho_id: trabalhoId,
        nome,
        lider_id: creatorId,
      },
    });

    await tx.equipeMembro.create({
      data: {
        equipe_id: equipe.id,
        usuario_id: creatorId,
      },
    });

    return equipe;
  });
}

/**
 * Erro com status HTTP embutido, para o handler mapear sem adivinhar.
 */
class TeamError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'TeamError';
    this.statusCode = statusCode;
  }
}

/**
 * Lista as equipes de um trabalho em grupo — o "quadro da turma" do aluno.
 *
 * Expõe líder e integrantes para facilitar a formação dos grupos dentro da
 * própria turma. A própria equipe do aluno é sinalizada por `sou_membro`.
 *
 * Status: `completo` quando a equipe já criou seu repositório (comprometeu-se
 * com o trabalho); `formando` enquanto ainda não criou. É o único sinal
 * objetivo de "pronto" no schema — não há tamanho-alvo de equipe para comparar.
 *
 * Acesso: apenas alunos matriculados na turma do trabalho. Sem isso, um aluno
 * poderia enumerar os grupos de turmas das quais não participa.
 */
export async function listTeamsForTrabalho(trabalhoId: number, requesterId: number) {
  const trabalho = await prisma.trabalho.findUnique({
    where: { id: trabalhoId },
    include: {
      turma: {
        include: {
          matriculas: { select: { usuario_id: true } },
        },
      },
      equipes: {
        include: {
          membros: { include: { usuario: { select: { id: true, nome: true, matricula: true, github_login: true } } } },
          lider: { select: { id: true, nome: true } },
          solicitacoes: { where: { usuario_id: requesterId }, select: { id: true } },
          repositorios: { select: { id: true } },
        },
      },
    },
  });

  if (!trabalho) {
    throw new TeamError('Trabalho not found', 404);
  }

  const isMatriculated = trabalho.turma.matriculas.some(m => m.usuario_id === requesterId);
  if (isMatriculated === false) {
    throw new TeamError('Forbidden: you are not enrolled in this class', 403);
  }

  // Trabalho individual simplesmente não tem equipes; devolver lista vazia é
  // mais amigável para a UI do que um erro.
  return trabalho.equipes.map(equipe => {
    const temRepositorio = equipe.repositorios.length > 0;
    const formada = Boolean(equipe.formada_em);
    return {
      id: equipe.id,
      nome: equipe.nome,
      total_integrantes: equipe.membros.length,
      tem_repositorio: temRepositorio,
      formada,
      max_integrantes: trabalho.max_integrantes_equipe,
      status: temRepositorio ? 'completo' : formada ? 'formada' : 'formando',
      sou_membro: equipe.membros.some(m => m.usuario_id === requesterId),
      lider: equipe.lider,
      membros: equipe.membros.map(m => m.usuario),
      solicitacao_pendente: equipe.solicitacoes.length > 0,
      pode_solicitar: !formada && equipe.membros.length < trabalho.max_integrantes_equipe,
    };
  });
}

/**
 * Adds a new member to an existing team.
 */
export async function addTeamMember(equipeId: number, usuarioId: number, requesterId: number, requesterRole: 'ALUNO' | 'PROFESSOR') {
  const equipe = await prisma.equipe.findUnique({
    where: { id: equipeId },
    include: {
      trabalho: {
        include: {
          turma: {
            include: {
              matriculas: true,
            },
          },
        },
      },
      membros: true,
    },
  });

  if (!equipe) {
    throw new Error('Team not found');
  }

  if (equipe.formada_em) throw new TeamError('A equipe já foi finalizada e não aceita novos integrantes', 409);
  if (equipe.membros.length >= equipe.trabalho.max_integrantes_equipe) {
    throw new TeamError(`A equipe atingiu o limite de ${equipe.trabalho.max_integrantes_equipe} integrantes`, 409);
  }

  // Convites diretos ficam restritos ao líder (e ao professor). Alunos de fora
  // entram pelo fluxo explícito de solicitação e aceite.
  if (requesterRole !== 'PROFESSOR') {
    if (equipe.lider_id !== requesterId) {
      throw new TeamError('Apenas o líder pode adicionar integrantes', 403);
    }
  }

  // Verify the new member is matriculated in the class
  const isMemberMatriculated = equipe.trabalho.turma.matriculas.some(m => m.usuario_id === usuarioId);
  if (!isMemberMatriculated) {
    throw new Error('New member is not matriculated in this class');
  }

  // Verify the user is not already in the team
  const isAlreadyMember = equipe.membros.some(m => m.usuario_id === usuarioId);
  if (isAlreadyMember) {
    throw new Error('User is already a member of this team');
  }

  const outraEquipe = await prisma.equipeMembro.findFirst({
    where: { usuario_id: usuarioId, equipe: { trabalho_id: equipe.trabalho_id } },
  });
  if (outraEquipe) throw new TeamError('Student already belongs to another team in this trabalho', 409);

  // Add the member
  return prisma.equipeMembro.create({
    data: {
      equipe_id: equipeId,
      usuario_id: usuarioId,
    },
  });
}

export async function getMyTeam(trabalhoId: number, usuarioId: number) {
  const equipe = await prisma.equipe.findFirst({
    where: { trabalho_id: trabalhoId, membros: { some: { usuario_id: usuarioId } } },
    include: { membros: { include: { usuario: true } }, repositorios: true, trabalho: true, lider: true,
      solicitacoes: { include: { usuario: true }, orderBy: { criada_em: 'asc' } } },
  });
  if (equipe && equipe.lider_id !== usuarioId) equipe.solicitacoes = [];
  return equipe;
}

export async function finalizeTeam(equipeId: number, requesterId: number) {
  const equipe = await prisma.equipe.findUnique({
    where: { id: equipeId }, include: { membros: true, repositorios: true, trabalho: true },
  });
  if (!equipe) throw new TeamError('Equipe não encontrada', 404);
  if (equipe.lider_id !== requesterId) throw new TeamError('Apenas o líder pode finalizar a equipe', 403);
  if (equipe.formada_em) return equipe;
  if (equipe.repositorios.length > 0) throw new TeamError('A equipe já possui repositório', 409);
  if (equipe.membros.length < 2) throw new TeamError('Adicione pelo menos 2 integrantes antes de finalizar a equipe', 409);
  if (equipe.membros.length > equipe.trabalho.max_integrantes_equipe) throw new TeamError('A equipe excede o limite do trabalho', 409);
  return prisma.equipe.update({ where: { id: equipeId }, data: { formada_em: new Date() } });
}

export async function requestTeamEntry(equipeId: number, requesterId: number) {
  const equipe = await prisma.equipe.findUnique({
    where: { id: equipeId },
    include: { membros: true, trabalho: { include: { turma: { include: { matriculas: true } } } } },
  });
  if (!equipe) throw new TeamError('Equipe não encontrada', 404);
  if (equipe.formada_em) throw new TeamError('A equipe já foi finalizada', 409);
  if (equipe.membros.length >= equipe.trabalho.max_integrantes_equipe) throw new TeamError('A equipe está completa', 409);
  if (!equipe.trabalho.turma.matriculas.some(m => m.usuario_id === requesterId)) throw new TeamError('Você não pertence a esta turma', 403);
  if (equipe.membros.some(m => m.usuario_id === requesterId)) throw new TeamError('Você já pertence a esta equipe', 409);
  const outraEquipe = await prisma.equipeMembro.findFirst({ where: { usuario_id: requesterId, equipe: { trabalho_id: equipe.trabalho_id } } });
  if (outraEquipe) throw new TeamError('Você já pertence a outra equipe neste trabalho', 409);
  const existente = await prisma.solicitacaoEquipe.findUnique({ where: { equipe_id_usuario_id: { equipe_id: equipeId, usuario_id: requesterId } } });
  if (existente) return existente;
  return prisma.solicitacaoEquipe.create({ data: { equipe_id: equipeId, usuario_id: requesterId } });
}

export async function decideTeamRequest(solicitacaoId: number, leaderId: number, aceitar: boolean) {
  return prisma.$transaction(async tx => {
    const pedido = await tx.solicitacaoEquipe.findUnique({
      where: { id: solicitacaoId },
      include: { equipe: { include: { membros: true, trabalho: true } } },
    });
    if (!pedido) throw new TeamError('Solicitação não encontrada', 404);
    if (pedido.equipe.lider_id !== leaderId) throw new TeamError('Apenas o líder pode responder solicitações', 403);
    if (!aceitar) return tx.solicitacaoEquipe.delete({ where: { id: solicitacaoId } });
    if (pedido.equipe.formada_em) throw new TeamError('A equipe já foi finalizada', 409);
    if (pedido.equipe.membros.length >= pedido.equipe.trabalho.max_integrantes_equipe) throw new TeamError('A equipe atingiu o limite de integrantes', 409);
    const outraEquipe = await tx.equipeMembro.findFirst({ where: { usuario_id: pedido.usuario_id, equipe: { trabalho_id: pedido.equipe.trabalho_id } } });
    if (outraEquipe) throw new TeamError('O aluno já entrou em outra equipe', 409);
    const membro = await tx.equipeMembro.create({ data: { equipe_id: pedido.equipe_id, usuario_id: pedido.usuario_id } });
    await tx.solicitacaoEquipe.deleteMany({ where: { usuario_id: pedido.usuario_id, equipe: { trabalho_id: pedido.equipe.trabalho_id } } });
    return membro;
  });
}
