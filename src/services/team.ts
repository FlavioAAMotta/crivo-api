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
 * Privacidade: NÃO expõe quem está em cada equipe, só o tamanho e o status. Um
 * aluno pode ver quais grupos existem e quais ainda estão formando sem que a
 * composição de cada grupo vire informação pública. A própria equipe do aluno
 * é sinalizada por `sou_membro`, para a UI destacá-la.
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
          membros: { select: { usuario_id: true } },
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

  // Verify authorization: requester must be a professor or a member of the team
  if (requesterRole !== 'PROFESSOR') {
    const isRequesterMember = equipe.membros.some(m => m.usuario_id === requesterId);
    if (!isRequesterMember) {
      throw new Error('Forbidden: You are not a member of this team');
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
  return prisma.equipe.findFirst({
    where: { trabalho_id: trabalhoId, membros: { some: { usuario_id: usuarioId } } },
    include: { membros: { include: { usuario: true } }, repositorios: true, trabalho: true },
  });
}

export async function finalizeTeam(equipeId: number, requesterId: number) {
  const equipe = await prisma.equipe.findUnique({
    where: { id: equipeId }, include: { membros: true, repositorios: true, trabalho: true },
  });
  if (!equipe) throw new TeamError('Equipe não encontrada', 404);
  if (!equipe.membros.some(m => m.usuario_id === requesterId)) throw new TeamError('Você não pertence a esta equipe', 403);
  if (equipe.formada_em) return equipe;
  if (equipe.repositorios.length > 0) throw new TeamError('A equipe já possui repositório', 409);
  if (equipe.membros.length < 2) throw new TeamError('Adicione pelo menos 2 integrantes antes de finalizar a equipe', 409);
  if (equipe.membros.length > equipe.trabalho.max_integrantes_equipe) throw new TeamError('A equipe excede o limite do trabalho', 409);
  return prisma.equipe.update({ where: { id: equipeId }, data: { formada_em: new Date() } });
}
