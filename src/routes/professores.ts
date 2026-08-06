import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireProfessor } from '../lib/auth.js';
import { getInstallationOctokit, withGithubRetry } from '../lib/octokit.js';
import { getRepositoryMetrics } from '../services/metrics.js';
import { enqueueRepoSetupJob } from '../jobs/queues.js';
import { runCongelador } from '../jobs/congelador.js';
import { logger } from '../lib/logger.js';
import { serializeBigInt } from '../lib/serializer.js';
import { docSchema } from '../lib/openapi.js';

const criarDisciplinaBodySchema = z.object({
  nome: z.string().min(3),
  codigo: z.string().min(2),
});

const criarTurmaBodySchema = z.object({
  disciplina_id: z.number(),
  nome: z.string().min(2),
  periodo: z.string().min(4),
});

const turmaIdParamsSchema = z.object({ id: z.string().transform(Number) });

const alunoIdParamsSchema = z.object({ id: z.string().transform(Number) });

const importarMatriculasBodySchema = z.object({
  matriculas: z.array(
    z.object({
      ra: z.string().min(1),
      nome: z.string().min(1),
    })
  ),
});

const criarTrabalhoBodySchema = z.object({
  turma_id: z.number(),
  titulo: z.string().min(3),
  descricao_md: z.string(),
  slug: z.string().min(2),
  tipo: z.enum(['INDIVIDUAL', 'EQUIPE']),
  template_repo: z.string().includes('/'), // format owner/repo
  janela_inicio: z.string().transform(d => new Date(d)),
  deadline: z.string().transform(d => new Date(d)),
  congelamento_automatico: z.boolean().default(true),
});

const gradeQuerySchema = z.object({ trabalho_id: z.string().transform(Number) });

const repositorioIdParamsSchema = z.object({ id: z.string().transform(Number) });

const sinalizacoesQuerySchema = z.object({
  status: z.enum(['PENDENTE', 'PROCEDE', 'DESCARTADA']).optional(),
  tipo: z.enum(['DIVERGENCIA_PUSHER_AUTOR', 'SEM_ATIVIDADE', 'FORCE_PUSH', 'COMMIT_GIGANTE', 'AUTOR_NAO_RECONHECIDO']).optional(),
  turma_id: z.string().transform(Number).optional(),
});

const sinalizacaoIdParamsSchema = z.object({ id: z.string().transform(Number) });

const revisarSinalizacaoBodySchema = z.object({
  status: z.enum(['PROCEDE', 'DESCARTADA']),
  nota_revisao: z.string().min(5), // mandatory comment
});

const trabalhoIdParamsSchema = z.object({ id: z.string().transform(Number) });

// force=true recongela repositórios que já possuem entrega, criando entrega-N+1.
const congelarQuerySchema = z.object({
  force: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
});

const AUTH_SECURITY: Record<string, string[]>[] = [{ cookieAuth: [] }, { bearerAuth: [] }];

export async function professorRoutes(fastify: FastifyInstance) {

  // Apply requireProfessor middleware to all professor routes
  fastify.addHook('preHandler', requireProfessor);

  // ==========================================
  // 1. CRUD Disciplinas
  // ==========================================

  fastify.get('/prof/disciplinas', {
    schema: {
      tags: ['professores'],
      summary: 'Lista todas as disciplinas',
      security: AUTH_SECURITY,
    },
  }, async (request, reply) => {
    const list = await prisma.disciplina.findMany({
      include: { turmas: true },
    });
    return reply.send(list);
  });

  fastify.post('/prof/disciplinas', {
    schema: {
      tags: ['professores'],
      summary: 'Cria uma disciplina',
      security: AUTH_SECURITY,
      body: docSchema(criarDisciplinaBodySchema),
    },
  }, async (request, reply) => {
    const schema = criarDisciplinaBodySchema;

    const parsed = schema.parse(request.body);
    try {
      const created = await prisma.disciplina.create({ data: parsed });
      return reply.status(201).send(created);
    } catch (err: any) {
      if (err.code === 'P2002') {
        reply.status(409).send({ error: 'Disciplina code already exists' });
      } else {
        throw err;
      }
    }
  });

  // ==========================================
  // 2. CRUD Turmas
  // ==========================================

  fastify.get('/prof/turmas', {
    schema: {
      tags: ['professores'],
      summary: 'Lista todas as turmas',
      security: AUTH_SECURITY,
    },
  }, async (request, reply) => {
    const list = await prisma.turma.findMany({
      include: { disciplina: true },
    });
    return reply.send(list);
  });

  fastify.post('/prof/turmas', {
    schema: {
      tags: ['professores'],
      summary: 'Cria uma turma',
      security: AUTH_SECURITY,
      body: docSchema(criarTurmaBodySchema),
    },
  }, async (request, reply) => {
    const schema = criarTurmaBodySchema;

    const parsed = schema.parse(request.body);
    const created = await prisma.turma.create({ data: parsed });
    return reply.status(201).send(created);
  });

  // ==========================================
  // 3. CRUD Matriculas & Import
  // ==========================================

  fastify.post('/prof/turmas/:id/matriculas', {
    schema: {
      tags: ['professores'],
      summary: 'Importa matrículas de alunos em uma turma a partir do RA (sem GitHub)',
      security: AUTH_SECURITY,
      params: docSchema(turmaIdParamsSchema),
      body: docSchema(importarMatriculasBodySchema),
    },
  }, async (request, reply) => {
    const { id: turmaId } = turmaIdParamsSchema.parse(request.params);
    const { matriculas } = importarMatriculasBodySchema.parse(request.body);

    const importados: string[] = [];

    for (const item of matriculas) {
      const usuario = await prisma.usuario.upsert({
        where: { matricula: item.ra },
        update: {},
        create: {
          matricula: item.ra,
          nome: item.nome,
          papel: 'ALUNO',
          github_id: null,
          github_login: null,
          senha_hash: null,
        },
      });

      await prisma.matricula.upsert({
        where: { usuario_id_turma_id: { usuario_id: usuario.id, turma_id: turmaId } },
        update: {},
        create: { usuario_id: usuario.id, turma_id: turmaId },
      });

      importados.push(item.ra);
    }

    return reply.send({ success: true, imported: importados });
  });

  fastify.get('/prof/turmas/:id/matriculas', {
    schema: {
      tags: ['professores'],
      summary: 'Lista os alunos matriculados na turma e o status de ativação de cada um',
      security: AUTH_SECURITY,
      params: docSchema(turmaIdParamsSchema),
    },
  }, async (request, reply) => {
    const { id: turmaId } = turmaIdParamsSchema.parse(request.params);

    const matriculas = await prisma.matricula.findMany({
      where: { turma_id: turmaId },
      include: { usuario: true },
    });

    const linhas = matriculas.map((m) => ({
      usuario_id: m.usuario.id,
      nome: m.usuario.nome,
      matricula: m.usuario.matricula,
      github_login: m.usuario.github_login,
      senha_definida: m.usuario.senha_hash !== null,
      vinculado: m.usuario.github_login !== null,
    }));

    return reply.send(linhas);
  });

  fastify.post('/prof/alunos/:id/resetar-senha', {
    schema: {
      tags: ['professores'],
      summary: 'Zera a senha de um aluno pendente de vínculo do GitHub (escape hatch)',
      security: AUTH_SECURITY,
      params: docSchema(alunoIdParamsSchema),
    },
  }, async (request, reply) => {
    const { id } = alunoIdParamsSchema.parse(request.params);

    const aluno = await prisma.usuario.findUnique({ where: { id } });
    if (!aluno || aluno.papel !== 'ALUNO') {
      reply.status(404).send({ error: 'Aluno not found' });
      return;
    }
    if (aluno.github_id) {
      reply.status(409).send({ error: 'Aluno já vinculado ao GitHub — reset não é necessário' });
      return;
    }

    const atualizado = await prisma.usuario.update({
      where: { id },
      data: { senha_hash: null, senha_redefinida_em: null },
    });

    return reply.send({ success: true, usuario: serializeBigInt(atualizado) });
  });

  fastify.post('/prof/alunos/:id/resetar-acesso', {
    schema: {
      tags: ['professores'],
      summary: 'Devolve um aluno ao estado de primeiro acesso, removendo senha e vínculo do GitHub',
      security: AUTH_SECURITY,
      params: docSchema(alunoIdParamsSchema),
    },
  }, async (request, reply) => {
    const { id } = alunoIdParamsSchema.parse(request.params);

    const aluno = await prisma.usuario.findUnique({ where: { id } });
    if (!aluno || aluno.papel !== 'ALUNO') {
      reply.status(404).send({ error: 'Aluno not found' });
      return;
    }

    await prisma.usuario.update({
      where: { id },
      data: {
        github_id: null,
        github_login: null,
        senha_hash: null,
        senha_redefinida_em: null,
      },
    });

    return reply.send({ success: true });
  });

  // Escape hatch para o caso que o resetar-senha não cobre: o aluno vinculou a conta
  // ERRADA do GitHub (pessoal em vez da institucional, ou simplesmente outra). Desfaz o
  // vínculo e devolve a conta ao estado de primeiro acesso — o aluno refaz login-ra
  // (senha = RA) → redefinir-senha → vincular-github, agora com a conta certa.
  fastify.post('/prof/alunos/:id/desvincular-github', {
    schema: {
      tags: ['professores'],
      summary: 'Desfaz o vínculo do GitHub de um aluno e devolve a conta ao primeiro acesso (escape hatch)',
      security: AUTH_SECURITY,
      params: docSchema(alunoIdParamsSchema),
    },
  }, async (request, reply) => {
    const { id } = alunoIdParamsSchema.parse(request.params);

    const aluno = await prisma.usuario.findUnique({ where: { id } });
    if (!aluno || aluno.papel !== 'ALUNO') {
      reply.status(404).send({ error: 'Aluno not found' });
      return;
    }
    if (aluno.github_id === null) {
      reply.status(409).send({
        error: 'Aluno não está vinculado ao GitHub — nada a desvincular. Use resetar-senha se ele também precisa de nova senha inicial.',
      });
      return;
    }

    const atualizado = await prisma.usuario.update({
      where: { id },
      data: {
        github_id: null,
        github_login: null,
        senha_hash: null,
        senha_redefinida_em: null,
      },
    });

    return reply.send({ success: true, usuario: serializeBigInt(atualizado) });
  });

  // ==========================================
  // 4. CRUD Trabalhos
  // ==========================================

  fastify.get('/prof/trabalhos', {
    schema: {
      tags: ['professores'],
      summary: 'Lista todos os trabalhos',
      security: AUTH_SECURITY,
    },
  }, async (request, reply) => {
    const list = await prisma.trabalho.findMany({
      include: { turma: true },
    });
    return reply.send(list);
  });

  fastify.post('/prof/trabalhos', {
    schema: {
      tags: ['professores'],
      summary: 'Cria um trabalho, validando o repositório template no GitHub',
      security: AUTH_SECURITY,
      body: docSchema(criarTrabalhoBodySchema),
    },
  }, async (request, reply) => {
    const schema = criarTrabalhoBodySchema;

    const parsed = schema.parse(request.body);
    
    // Validate template repo exists on GitHub
    const [owner, repo] = parsed.template_repo.split('/');
    const octokit = await getInstallationOctokit();
    
    try {
      await withGithubRetry(() =>
        octokit.rest.repos.get({ owner, repo })
      );
    } catch (err: any) {
      reply.status(400).send({ error: `Template repository '${parsed.template_repo}' not found on GitHub or unauthorized: ${err.message}` });
      return;
    }
    
    try {
      const created = await prisma.trabalho.create({ data: parsed });
      return reply.status(201).send(created);
    } catch (err: any) {
      if (err.code === 'P2002') {
        reply.status(409).send({ error: 'Trabalho slug must be unique' });
      } else {
        throw err;
      }
    }
  });

  // ==========================================
  // 5. GET /prof/turmas/:id/grade?trabalho_id=
  // ==========================================

  fastify.get('/prof/turmas/:id/grade', {
    schema: {
      tags: ['professores'],
      summary: 'Retorna a grade (status de entrega) de um trabalho em uma turma',
      security: AUTH_SECURITY,
      params: docSchema(turmaIdParamsSchema),
      querystring: docSchema(gradeQuerySchema),
    },
  }, async (request, reply) => {
    const paramsSchema = turmaIdParamsSchema;
    const querySchema = gradeQuerySchema;

    const { id: turmaId } = paramsSchema.parse(request.params);
    const { trabalho_id: trabalhoId } = querySchema.parse(request.query);
    
    const trabalho = await prisma.trabalho.findFirst({
      where: { id: trabalhoId, turma_id: turmaId },
    });
    
    if (!trabalho) {
      reply.status(404).send({ error: 'Trabalho not found in this class' });
      return;
    }
    
    const repos = await prisma.repositorio.findMany({
      where: { trabalho_id: trabalhoId },
      include: {
        usuario: true,
        equipe: {
          include: {
            membros: {
              include: { usuario: true },
            },
          },
        },
        entregas: true,
        sinalizacoes: {
          where: { status: 'PENDENTE' },
        },
        pushes: {
          orderBy: { recebido_em: 'desc' },
          take: 1,
        },
        commits: true,
      },
    });

    const now = new Date();
    const rows = [];
    
    // Process matching repositories
    for (const r of repos) {
      let donoLabel = '';
      let membros: string[] = [];
      
      if (r.dono_tipo === 'ALUNO' && r.usuario) {
        donoLabel = r.usuario.nome;
        membros = [r.usuario.github_login!];
      } else if (r.dono_tipo === 'EQUIPE' && r.equipe) {
        donoLabel = `Equipe: ${r.equipe.nome}`;
        membros = r.equipe.membros.map(m => m.usuario.github_login ?? m.usuario.matricula ?? '(sem login)');
      }
      
      const lastPush = r.pushes[0];
      const isFrozen = r.entregas.length > 0 || (trabalho.congelamento_automatico && now >= trabalho.deadline);
      
      // Calculate inactivity status (default 5 days)
      let statusLabel: 'congelado' | 'sem atividade' | 'em andamento' = isFrozen ? 'congelado' : 'em andamento';
      
      if (statusLabel === 'em andamento') {
        const cutoff = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
        const lastCommit = r.commits[0];
        const lastActivity = lastCommit ? new Date(lastCommit.committed_em) : new Date(trabalho.janela_inicio);
        if (lastActivity < cutoff) {
          statusLabel = 'sem atividade';
        }
      }

      rows.push({
        repositorio_id: r.id,
        nome_completo: r.nome_completo,
        dono: donoLabel,
        membros,
        ultimo_push: lastPush ? {
          quando: lastPush.recebido_em,
          quem: lastPush.pusher_login,
        } : null,
        total_commits: r.commits.length,
        sinalizacoes_pendentes: r.sinalizacoes.length,
        status: statusLabel,
        // ERRO aqui significa que o aluno pode estar sem acesso de push ao próprio
        // repositório, ou que a branch main ficou desprotegida.
        setup_status: r.setup_status,
        setup_erro: r.setup_erro,
      });
    }

    // Process students/teams with NO repository yet (sem repo)
    if (trabalho.tipo === 'INDIVIDUAL') {
      const allStudents = await prisma.matricula.findMany({
        where: { turma_id: turmaId },
        include: { usuario: true },
      });
      
      for (const m of allStudents) {
        const hasRepo = repos.some(r => r.usuario_id === m.usuario_id);
        if (!hasRepo) {
          rows.push({
            repositorio_id: null,
            nome_completo: null,
            dono: m.usuario.nome,
            membros: [m.usuario.github_login ?? m.usuario.matricula ?? '(sem login)'],
            ultimo_push: null,
            total_commits: 0,
            sinalizacoes_pendentes: 0,
            status: 'sem repo',
          });
        }
      }
    } else {
      const allTeams = await prisma.equipe.findMany({
        where: { trabalho_id: trabalhoId },
        include: {
          membros: { include: { usuario: true } },
        },
      });

      for (const team of allTeams) {
        const hasRepo = repos.some(r => r.equipe_id === team.id);
        if (!hasRepo) {
          rows.push({
            repositorio_id: null,
            nome_completo: null,
            dono: `Equipe: ${team.nome}`,
            membros: team.membros.map(m => m.usuario.github_login ?? m.usuario.matricula ?? '(sem login)'),
            ultimo_push: null,
            total_commits: 0,
            sinalizacoes_pendentes: 0,
            status: 'sem repo',
          });
        }
      }
    }

    return reply.send(rows);
  });

  // ==========================================
  // 6. GET /prof/repositorios/:id
  // ==========================================

  fastify.get('/prof/repositorios/:id', {
    schema: {
      tags: ['professores'],
      summary: 'Retorna as métricas de um repositório',
      security: AUTH_SECURITY,
      params: docSchema(repositorioIdParamsSchema),
    },
  }, async (request, reply) => {
    const paramsSchema = repositorioIdParamsSchema;
    const { id: repoId } = paramsSchema.parse(request.params);
    
    try {
      const metrics = await getRepositoryMetrics(repoId);
      return reply.send(metrics);
    } catch (err: any) {
      reply.status(404).send({ error: err.message });
    }
  });

  // ==========================================
  // 6b. POST /prof/repositorios/:id/reprocessar-setup
  // ==========================================

  fastify.post('/prof/repositorios/:id/reprocessar-setup', {
    schema: {
      tags: ['professores'],
      summary: 'Reprocessa a configuração pós-criação (colaboradores + ruleset) de um repositório em ERRO',
      security: AUTH_SECURITY,
      params: docSchema(repositorioIdParamsSchema),
    },
  }, async (request, reply) => {
    const paramsSchema = repositorioIdParamsSchema;
    const { id: repoId } = paramsSchema.parse(request.params);

    const repo = await prisma.repositorio.findUnique({ where: { id: repoId } });
    if (!repo) {
      reply.status(404).send({ error: 'Repositório not found' });
      return;
    }

    // Só faz sentido reenfileirar quem falhou — repositório saudável não deve
    // reentrar na fila por engano (idempotência do ruleset cobre reentrada
    // acidental, mas o guard aqui deixa a intenção explícita).
    if (repo.setup_status !== 'ERRO') {
      reply.status(409).send({ error: `Repositório está com setup_status=${repo.setup_status}, não ERRO — nada a reprocessar` });
      return;
    }

    const atualizado = await prisma.repositorio.update({
      where: { id: repoId },
      data: { setup_status: 'PENDENTE', setup_erro: null },
    });

    await enqueueRepoSetupJob(repoId);

    return reply.send({ success: true, repositorio: serializeBigInt(atualizado) });
  });

  // ==========================================
  // 7. GET & PATCH /prof/sinalizacoes
  // ==========================================

  fastify.get('/prof/sinalizacoes', {
    schema: {
      tags: ['professores'],
      summary: 'Lista sinalizações de integridade, com filtros opcionais',
      security: AUTH_SECURITY,
      querystring: docSchema(sinalizacoesQuerySchema),
    },
  }, async (request, reply) => {
    const querySchema = sinalizacoesQuerySchema;

    const filters = querySchema.parse(request.query);
    const whereClause: any = {};
    
    if (filters.status) whereClause.status = filters.status;
    if (filters.tipo) whereClause.tipo = filters.tipo;
    if (filters.turma_id) {
      whereClause.repositorio = {
        trabalho: {
          turma_id: filters.turma_id,
        },
      };
    }
    
    const list = await prisma.sinalizacao.findMany({
      where: whereClause,
      include: {
        repositorio: true,
        revisor: true,
      },
      orderBy: { detectado_em: 'desc' },
    });
    
    return reply.send(serializeBigInt(list));
  });

  fastify.patch('/prof/sinalizacoes/:id', {
    schema: {
      tags: ['professores'],
      summary: 'Revisa (aprova/descarta) uma sinalização pendente',
      security: AUTH_SECURITY,
      params: docSchema(sinalizacaoIdParamsSchema),
      body: docSchema(revisarSinalizacaoBodySchema),
    },
  }, async (request, reply) => {
    const paramsSchema = sinalizacaoIdParamsSchema;
    const bodySchema = revisarSinalizacaoBodySchema;

    const { id: signalId } = paramsSchema.parse(request.params);
    const { status, nota_revisao } = bodySchema.parse(request.body);
    
    const signal = await prisma.sinalizacao.findUnique({
      where: { id: signalId },
    });
    
    if (!signal) {
      reply.status(404).send({ error: 'Signal not found' });
      return;
    }
    
    // Immutability: block modifications on resolved decisions
    if (signal.status !== 'PENDENTE') {
      reply.status(400).send({ error: 'Signal has already been reviewed and is immutable' });
      return;
    }
    
    const updated = await prisma.sinalizacao.update({
      where: { id: signalId },
      data: {
        status,
        nota_revisao,
        revisado_por: request.user!.id,
        revisado_em: new Date(),
      },
    });
    
    return reply.send(serializeBigInt(updated));
  });

  // ==========================================
  // 8. POST /prof/trabalhos/:id/congelar
  // ==========================================

  fastify.post('/prof/trabalhos/:id/congelar', {
    schema: {
      tags: ['professores'],
      summary: 'Força o congelamento imediato dos repositórios de um trabalho',
      security: AUTH_SECURITY,
      params: docSchema(trabalhoIdParamsSchema),
      querystring: docSchema(congelarQuerySchema),
    },
  }, async (request, reply) => {
    const paramsSchema = trabalhoIdParamsSchema;
    const { id: trabalhoId } = paramsSchema.parse(request.params);
    
    const trabalho = await prisma.trabalho.findUnique({
      where: { id: trabalhoId },
    });
    
    if (!trabalho) {
      reply.status(404).send({ error: 'Trabalho not found' });
      return;
    }
    
    // Congelamento manual: roda a varredura restrita a este trabalho, ignorando o deadline.
    // `force` permite recongelar um repositório que já tem entrega, gerando entrega-N+1
    // (ex.: o prazo foi prorrogado). Sem force, repositórios já congelados são pulados.
    const { force } = congelarQuerySchema.parse(request.query);
    await runCongelador({ trabalhoId, force });

    return reply.send({ success: true, message: 'Freezing routine executed for this trabalho' });
  });
}
export default professorRoutes;
