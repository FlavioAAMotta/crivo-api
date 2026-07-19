import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../lib/auth.js';
import { createRepositoryForStudent, createRepositoryForTeam } from '../services/repo.js';
import { createTeam, addTeamMember } from '../services/team.js';
import { getRepositoryMetrics } from '../services/metrics.js';
import { serializeBigInt } from '../lib/serializer.js';

export async function alunoRoutes(fastify: FastifyInstance) {
  
  // Apply requireAuth middleware to all aluno routes
  fastify.addHook('preHandler', requireAuth);

  // 1. List classes and works with their status
  fastify.get('/me/turmas', async (request, reply) => {
    const requesterId = request.user!.id;

    // Database repo query helper to optimize nested async lookups
    const dbRepoCache = await prisma.repositorio.findMany({
      include: { entregas: true }
    });

    function mRepositorioForStudent(trabalhos: any[], trabalhoId: number, studentId: number) {
      const matched = dbRepoCache.find(r => r.trabalho_id === trabalhoId && r.dono_tipo === 'ALUNO' && r.usuario_id === studentId);
      return matched ? { id: matched.id, nome_completo: matched.nome_completo, github_repo_id: matched.github_repo_id } : null;
    }

    function mRepositorioForTeam(trabalhos: any[], trabalhoId: number, teamIds: number[]) {
      const matched = dbRepoCache.find(r => r.trabalho_id === trabalhoId && r.dono_tipo === 'EQUIPE' && r.equipe_id && teamIds.includes(r.equipe_id));
      return matched ? { id: matched.id, nome_completo: matched.nome_completo, github_repo_id: matched.github_repo_id } : null;
    }

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

    const now = new Date();

    const result = matriculas.map((m) => {
      const turma = m.turma;
      
      const trabalhosWithStatus = turma.trabalhos.map((t) => {
        // Find user's repo or user's team's repo for this trabalho
        let repo = null;
        if (t.tipo === 'INDIVIDUAL') {
          repo = t.repositorios.find(r => r.usuario_id === requesterId);
        } else {
          // Find if user belongs to any team for this trabalho
          // We can query this to be absolutely certain
          repo = t.repositorios.find(async (r) => {
            if (r.equipe_id) {
              const count = await prisma.equipeMembro.count({
                where: { equipe_id: r.equipe_id, usuario_id: requesterId }
              });
              return count > 0;
            }
            return false;
          });
        }

        // Determine status
        let status: 'sem repo' | 'em andamento' | 'congelado' = 'sem repo';
        if (repo) {
          // If already has an Entrega record, or if deadline has passed and auto-freeze is active
          const isFrozen = repo.entregas.length > 0 || (t.congelamento_automatico && now >= t.deadline);
          status = isFrozen ? 'congelado' : 'em andamento';
        }

        return {
          id: t.id,
          titulo: t.titulo,
          descricao_md: t.descricao_md,
          slug: t.slug,
          tipo: t.tipo,
          deadline: t.deadline,
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

    // Resolve the async repo checks for teams manually (to handle team repos cleanly)
    // We can pre-fetch teams of this student to make it non-async and faster
    const userTeams = await prisma.equipeMembro.findMany({
      where: { usuario_id: requesterId },
      select: { equipe_id: true }
    });
    const userTeamIds = userTeams.map(ut => ut.equipe_id);

    const resolvedResult = result.map(tData => {
      const trabalhos = tData.trabalhos.map(t => {
        let repo = null;
        if (t.tipo === 'INDIVIDUAL') {
          repo = mRepositorioForStudent(tData.trabalhos, t.id, requesterId);
        } else {
          repo = mRepositorioForTeam(tData.trabalhos, t.id, userTeamIds);
        }

        let status: 'sem repo' | 'em andamento' | 'congelado' = 'sem repo';
        if (repo) {
          const matchedDbRepo = dbRepoCache.find(r => r.id === repo.id);
          const isFrozen = matchedDbRepo?.entregas.length > 0 || (new Date(t.deadline) <= now);
          status = isFrozen ? 'congelado' : 'em andamento';
        }

        return {
          ...t,
          status,
          repositorio: repo,
        };
      });
      return {
        ...tData,
        trabalhos,
      };
    });

    return reply.send(serializeBigInt(resolvedResult));
  });

  // 2. POST /trabalhos/:id/repositorio -> creates repo for the student
  fastify.post('/trabalhos/:id/repositorio', async (request, reply) => {
    const paramsSchema = z.object({
      id: z.string().transform(Number),
    });
    
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
      return reply.status(400).send({ error: err.message });
    }
  });

  // 3. POST /trabalhos/:id/equipes { nome } -> creates team for a work
  fastify.post('/trabalhos/:id/equipes', async (request, reply) => {
    const paramsSchema = z.object({
      id: z.string().transform(Number),
    });
    const bodySchema = z.object({
      nome: z.string().min(2).max(100),
    });
    
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
  fastify.post('/equipes/:id/membros', async (request, reply) => {
    const paramsSchema = z.object({
      id: z.string().transform(Number),
    });
    const bodySchema = z.object({
      usuario_id: z.number(),
    });
    
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

  // 5. POST /equipes/:id/repositorio -> creates repo for the team
  fastify.post('/equipes/:id/repositorio', async (request, reply) => {
    const paramsSchema = z.object({
      id: z.string().transform(Number),
    });
    
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
      return reply.status(400).send({ error: err.message });
    }
  });

  // 6. GET /me/repositorios/:id/metricas -> LGPD route to see own metrics
  fastify.get('/me/repositorios/:id/metricas', async (request, reply) => {
    const paramsSchema = z.object({
      id: z.string().transform(Number),
    });
    
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
