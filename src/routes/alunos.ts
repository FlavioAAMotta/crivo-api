import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../lib/auth.js';
import { createRepositoryForStudent, createRepositoryForTeam } from '../services/repo.js';
import { createTeam, addTeamMember, listTeamsForTrabalho, getMyTeam, finalizeTeam, requestTeamEntry, decideTeamRequest, deleteTeam } from '../services/team.js';
import { getRepositoryMetrics } from '../services/metrics.js';
import { trabalhoLiberado } from '../lib/janela.js';
import { serializeBigInt } from '../lib/serializer.js';
import { docSchema } from '../lib/openapi.js';

const trabalhoIdParamsSchema = z.object({
  id: z.string().transform(Number),
});

const criarEquipeBodySchema = z.object({
  nome: z.string().min(2).max(100),
});

const equipeIdParamsSchema = z.object({
  id: z.string().transform(Number),
});

const solicitacaoIdParamsSchema = z.object({ id: z.string().transform(Number) });
const decidirSolicitacaoBodySchema = z.object({ aceitar: z.boolean() });

const addMembroBodySchema = z.object({
  usuario_id: z.number(),
});

const repositorioIdParamsSchema = z.object({
  id: z.string().transform(Number),
});

const AUTH_SECURITY: Record<string, string[]>[] = [{ cookieAuth: [] }, { bearerAuth: [] }];

export async function alunoRoutes(fastify: FastifyInstance) {

  // Apply requireAuth middleware to all aluno routes
  fastify.addHook('preHandler', requireAuth);

  // 1. List classes and works with their status
  fastify.get('/me/turmas', {
    schema: {
      tags: ['alunos'],
      summary: 'Lista as turmas do aluno autenticado com o status dos trabalhos',
      security: AUTH_SECURITY,
    },
  }, async (request, reply) => {
    const requesterId = request.user!.id;

    // Get all turmas the user is matriculated in
    const matriculas = await prisma.matricula.findMany({
      where: { usuario_id: requesterId },
      include: {
        turma: {
          include: {
            disciplina: true,
            trabalhos: {
              include: {
                repositorios: {
                  include: {
                    entregas: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    // Equipes do aluno: o repositório de um trabalho em equipe pertence ao grupo,
    // não a ele. Uma consulta só, em vez de uma por trabalho.
    const equipesDoAluno = await prisma.equipeMembro.findMany({
      where: { usuario_id: requesterId },
      select: { equipe_id: true },
    });
    const equipeIds = new Set(equipesDoAluno.map((e) => e.equipe_id));

    const agora = new Date();

    const result = matriculas.map((m) => {
      const turma = m.turma;

      const trabalhosWithStatus = turma.trabalhos.map((t) => {
        const repo = t.tipo === 'INDIVIDUAL'
          ? t.repositorios.find((r) => r.dono_tipo === 'ALUNO' && r.usuario_id === requesterId)
          : t.repositorios.find((r) => r.dono_tipo === 'EQUIPE' && r.equipe_id !== null && equipeIds.has(r.equipe_id));

        // Um repositório já criado destrava o trabalho mesmo que a janela tenha
        // sido reagendada para o futuro: esconder o enunciado de quem já está
        // trabalhando nele seria esconder o trabalho do próprio aluno.
        const liberado = trabalhoLiberado(t.janela_inicio, agora) || Boolean(repo);

        let status: 'agendado' | 'sem repo' | 'em andamento' | 'congelado' = 'sem repo';
        if (!liberado) {
          status = 'agendado';
        } else if (repo) {
          // Congelado quando já existe Entrega, ou quando o prazo passou e o
          // congelamento automático está ligado.
          const isFrozen = repo.entregas.length > 0 || (t.congelamento_automatico && agora >= t.deadline);
          status = isFrozen ? 'congelado' : 'em andamento';
        }

        return {
          id: t.id,
          titulo: t.titulo,
          // Antes da abertura o aluno vê que o trabalho existe e quando abre —
          // nunca o que ele pede. Enunciado e prazo saem do payload, não são só
          // escondidos na tela.
          descricao_md: liberado ? t.descricao_md : null,
          slug: t.slug,
          tipo: t.tipo,
          min_integrantes_equipe: t.min_integrantes_equipe,
          max_integrantes_equipe: t.max_integrantes_equipe,
          janela_inicio: t.janela_inicio,
          deadline: liberado ? t.deadline : null,
          liberado,
          status,
          repositorio: repo ? {
            id: repo.id,
            nome_completo: repo.nome_completo,
            github_repo_id: repo.github_repo_id.toString(),
          } : null,
        };
      });

      return {
        id: turma.id,
        nome: turma.nome,
        periodo: turma.periodo,
        disciplina: turma.disciplina,
        trabalhos: trabalhosWithStatus,
      };
    });

    return reply.send(serializeBigInt(result));
  });

  // 2. POST /trabalhos/:id/repositorio -> creates repo for the student
  fastify.post('/trabalhos/:id/repositorio', {
    schema: {
      tags: ['alunos'],
      summary: 'Cria o repositório do aluno para um trabalho individual',
      security: AUTH_SECURITY,
      params: docSchema(trabalhoIdParamsSchema),
    },
  }, async (request, reply) => {
    const paramsSchema = trabalhoIdParamsSchema;

    const parseResult = paramsSchema.safeParse(request.params);
    if (!parseResult.success) {
      reply.status(400).send({ error: 'Invalid trabalho ID' });
      return;
    }
    
    const trabalhoId = parseResult.data.id;
    const requesterId = request.user!.id;
    
    try {
      const dbRepo = await createRepositoryForStudent(requesterId, trabalhoId);
      return reply.status(201).send(serializeBigInt(dbRepo));
    } catch (err: any) {
      // TrabalhoNaoLiberadoError carrega 403; o resto continua caindo em 400.
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  // 3a. GET /trabalhos/:id/equipes -> lists all teams of a group work (class board)
  fastify.get('/trabalhos/:id/equipes', {
    schema: {
      tags: ['alunos'],
      summary: 'Lista as equipes de um trabalho em grupo (quadro da turma)',
      description:
        'Devolve líder, integrantes, tamanho e status de cada equipe. Apenas para alunos matriculados na turma.',
      security: AUTH_SECURITY,
      params: docSchema(trabalhoIdParamsSchema),
    },
  }, async (request, reply) => {
    const parseResult = trabalhoIdParamsSchema.safeParse(request.params);
    if (!parseResult.success) {
      reply.status(400).send({ error: 'Invalid trabalho ID' });
      return;
    }

    try {
      const equipes = await listTeamsForTrabalho(parseResult.data.id, request.user!.id);
      return reply.send(equipes);
    } catch (err: any) {
      // TeamError carrega o status; erros inesperados caem em 400.
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  fastify.get('/trabalhos/:id/minha-equipe', {
    schema: { tags: ['alunos'], summary: 'Retorna a equipe do aluno, inclusive antes do repositório', security: AUTH_SECURITY, params: docSchema(trabalhoIdParamsSchema) },
  }, async (request, reply) => {
    const { id } = trabalhoIdParamsSchema.parse(request.params);
    return reply.send(serializeBigInt(await getMyTeam(id, request.user!.id)));
  });

  // 3. POST /trabalhos/:id/equipes { nome } -> creates team for a work
  fastify.post('/trabalhos/:id/equipes', {
    schema: {
      tags: ['alunos'],
      summary: 'Cria uma equipe para um trabalho em grupo',
      security: AUTH_SECURITY,
      params: docSchema(trabalhoIdParamsSchema),
      body: docSchema(criarEquipeBodySchema),
    },
  }, async (request, reply) => {
    const paramsSchema = trabalhoIdParamsSchema;
    const bodySchema = criarEquipeBodySchema;

    const paramsParse = paramsSchema.safeParse(request.params);
    const bodyParse = bodySchema.safeParse(request.body);
    
    if (!paramsParse.success || !bodyParse.success) {
      reply.status(400).send({ error: 'Invalid input parameters or body' });
      return;
    }
    
    const trabalhoId = paramsParse.data.id;
    const { nome } = bodyParse.data;
    const requesterId = request.user!.id;
    
    try {
      const team = await createTeam(trabalhoId, nome, requesterId);
      return reply.status(201).send(team);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // 4. POST /equipes/:id/membros { usuario_id } -> adds a member
  fastify.post('/equipes/:id/membros', {
    schema: {
      tags: ['alunos'],
      summary: 'Adiciona um membro a uma equipe',
      security: AUTH_SECURITY,
      params: docSchema(equipeIdParamsSchema),
      body: docSchema(addMembroBodySchema),
    },
  }, async (request, reply) => {
    const paramsSchema = equipeIdParamsSchema;
    const bodySchema = addMembroBodySchema;

    const paramsParse = paramsSchema.safeParse(request.params);
    const bodyParse = bodySchema.safeParse(request.body);
    
    if (!paramsParse.success || !bodyParse.success) {
      reply.status(400).send({ error: 'Invalid input' });
      return;
    }
    
    const equipeId = paramsParse.data.id;
    const { usuario_id } = bodyParse.data;
    const requesterId = request.user!.id;
    
    try {
      const membership = await addTeamMember(equipeId, usuario_id, requesterId, request.user!.papel);
      return reply.status(201).send(membership);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.post('/equipes/:id/finalizar', {
    schema: { tags: ['alunos'], summary: 'Finaliza a formação da equipe antes de criar o repositório', security: AUTH_SECURITY, params: docSchema(equipeIdParamsSchema) },
  }, async (request, reply) => {
    const { id } = equipeIdParamsSchema.parse(request.params);
    try {
      return reply.send(serializeBigInt(await finalizeTeam(id, request.user!.id)));
    } catch (err: any) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  fastify.delete('/equipes/:id', {
    schema: {
      tags: ['alunos'],
      summary: 'Exclui uma equipe ainda sem repositório (só quem a criou)',
      security: AUTH_SECURITY,
      params: docSchema(equipeIdParamsSchema),
    },
  }, async (request, reply) => {
    const { id } = equipeIdParamsSchema.parse(request.params);
    try {
      await deleteTeam(id, request.user!.id);
      return reply.status(204).send();
    } catch (err: any) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  fastify.post('/equipes/:id/solicitacoes', {
    schema: { tags: ['alunos'], summary: 'Solicita entrada em uma equipe aberta', security: AUTH_SECURITY, params: docSchema(equipeIdParamsSchema) },
  }, async (request, reply) => {
    const { id } = equipeIdParamsSchema.parse(request.params);
    try {
      return reply.status(201).send(await requestTeamEntry(id, request.user!.id));
    } catch (err: any) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  fastify.post('/solicitacoes-equipe/:id/decidir', {
    schema: { tags: ['alunos'], summary: 'Líder aceita ou recusa entrada na equipe', security: AUTH_SECURITY,
      params: docSchema(solicitacaoIdParamsSchema), body: docSchema(decidirSolicitacaoBodySchema) },
  }, async (request, reply) => {
    const { id } = solicitacaoIdParamsSchema.parse(request.params);
    const { aceitar } = decidirSolicitacaoBodySchema.parse(request.body);
    try {
      return reply.send(await decideTeamRequest(id, request.user!.id, aceitar));
    } catch (err: any) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  // 5. POST /equipes/:id/repositorio -> creates repo for the team
  fastify.post('/equipes/:id/repositorio', {
    schema: {
      tags: ['alunos'],
      summary: 'Cria o repositório de uma equipe',
      security: AUTH_SECURITY,
      params: docSchema(equipeIdParamsSchema),
    },
  }, async (request, reply) => {
    const paramsSchema = equipeIdParamsSchema;

    const paramsParse = paramsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400).send({ error: 'Invalid team ID' });
      return;
    }
    
    const equipeId = paramsParse.data.id;
    const requesterId = request.user!.id;
    
    try {
      // Validate requester is member of team or a professor
      const isProfessor = request.user!.papel === 'PROFESSOR';
      const isMember = await prisma.equipeMembro.count({
        where: { equipe_id: equipeId, usuario_id: requesterId }
      }) > 0;
      
      if (!isProfessor && !isMember) {
        reply.status(403).send({ error: 'Forbidden: You do not have access to this team' });
        return;
      }
      
      const team = await prisma.equipe.findUnique({
        where: { id: equipeId },
      });
      
      if (!team) {
        reply.status(404).send({ error: 'Team not found' });
        return;
      }
      
      const dbRepo = await createRepositoryForTeam(equipeId, team.trabalho_id);
      return reply.status(201).send(serializeBigInt(dbRepo));
    } catch (err: any) {
      // TrabalhoNaoLiberadoError carrega 403; o resto continua caindo em 400.
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  // 6. GET /me/repositorios/:id/metricas -> LGPD route to see own metrics
  fastify.get('/me/repositorios/:id/metricas', {
    schema: {
      tags: ['alunos'],
      summary: 'Retorna as métricas do repositório do próprio aluno/equipe (LGPD)',
      security: AUTH_SECURITY,
      params: docSchema(repositorioIdParamsSchema),
    },
  }, async (request, reply) => {
    const paramsSchema = repositorioIdParamsSchema;

    const paramsParse = paramsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400).send({ error: 'Invalid repository ID' });
      return;
    }
    
    const repoId = paramsParse.data.id;
    const requesterId = request.user!.id;
    
    try {
      const repo = await prisma.repositorio.findUnique({
        where: { id: repoId },
        include: {
          equipe: {
            include: {
              membros: true,
            },
          },
        },
      });
      
      if (!repo) {
        reply.status(404).send({ error: 'Repository not found' });
        return;
      }
      
      // Ownership check for security (LGPD requirement)
      if (repo.dono_tipo === 'ALUNO') {
        if (repo.usuario_id !== requesterId) {
          reply.status(403).send({ error: 'Forbidden: You do not own this repository' });
          return;
        }
      } else {
        const isMember = repo.equipe?.membros.some(m => m.usuario_id === requesterId);
        if (!isMember) {
          reply.status(403).send({ error: 'Forbidden: You are not a member of this team' });
          return;
        }
      }
      
      const metrics = await getRepositoryMetrics(repoId);
      return reply.send(metrics);
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });
}
export default alunoRoutes;
