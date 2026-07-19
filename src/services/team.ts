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

  // Add the member
  return prisma.equipeMembro.create({
    data: {
      equipe_id: equipeId,
      usuario_id: usuarioId,
    },
  });
}
