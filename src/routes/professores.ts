import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ZipArchive } from 'archiver';
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
const alunoTesteBodySchema = z.object({ aluno_teste: z.boolean() });

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
  min_integrantes_equipe: z.number().int().min(1).max(20).default(2),
  max_integrantes_equipe: z.number().int().min(1).max(20).default(4),
}).refine(data => data.min_integrantes_equipe <= data.max_integrantes_equipe, {
  message: 'min_integrantes_equipe must not exceed max_integrantes_equipe',
  path: ['min_integrantes_equipe'],
});

// Edição de trabalho já criado. `turma_id` fica de fora de propósito: mover um
// trabalho de turma deixaria repositórios, equipes e matrículas apontando para
// a turma antiga. `tipo` só é aceito enquanto o trabalho não tem repositório
// (ver a checagem no handler). `min`/`max_integrantes_equipe` são parciais aqui
// pelo mesmo motivo da janela: um PATCH que mexe só numa ponta ainda pode
// inverter a ordem, então a coerência é checada no handler contra o valor salvo.
const atualizarTrabalhoBodySchema = z.object({
  titulo: z.string().min(3).optional(),
  descricao_md: z.string().optional(),
  slug: z.string().min(2).optional(),
  tipo: z.enum(['INDIVIDUAL', 'EQUIPE']).optional(),
  template_repo: z.string().includes('/').optional(),
  janela_inicio: z.string().transform(d => new Date(d)).optional(),
  deadline: z.string().transform(d => new Date(d)).optional(),
  congelamento_automatico: z.boolean().optional(),
  min_integrantes_equipe: z.number().int().min(1).max(20).optional(),
  max_integrantes_equipe: z.number().int().min(1).max(20).optional(),
});

const gradeQuerySchema = z.object({ trabalho_id: z.string().transform(Number) });

const repositorioIdParamsSchema = z.object({ id: z.string().transform(Number) });

// Nota e comentário são independentes: o professor pode salvar só um deles
// primeiro (ex.: comentar antes de decidir a nota) e completar depois.
const avaliacaoBodySchema = z.object({
  nota: z.number().min(0).max(10).nullable().optional(),
  comentario: z.string().max(5000).nullable().optional(),
});

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

// Marco de entrega agendado: um trabalho pode ter N destes, além do deadline
// único (que não é tocado por nenhuma rota abaixo).
const criarEntregaAgendadaBodySchema = z.object({
  nome: z.string().min(2),
  // Aceita datas no passado de propósito: é o que permite criar uma entrega
  // retroativa (o congelador busca o commit que era HEAD na data informada).
  data_hora: z.string().transform(d => new Date(d)),
  congelamento_automatico: z.boolean().default(true),
});

const atualizarEntregaAgendadaBodySchema = z.object({
  nome: z.string().min(2).optional(),
  data_hora: z.string().transform(d => new Date(d)).optional(),
  congelamento_automatico: z.boolean().optional(),
});

const entregaAgendadaParamsSchema = z.object({
  id: z.string().transform(Number),
  entregaAgendadaId: z.string().transform(Number),
});

const downloadEntregasQuerySchema = z.object({
  entrega_agendada_id: z.string().transform(Number).optional(),
});

const AUTH_SECURITY: Record<string, string[]>[] = [{ cookieAuth: [] }, { bearerAuth: [] }];

/**
 * Checa o template no GitHub antes de gravar o trabalho. Devolve a mensagem de
 * erro (em português, porque vai direto para a tela do professor) ou `null`.
 *
 * `POST /repos/:owner/:repo/generate` responde **404 para quatro causas
 * distintas** — repositório invisível para a instalação, repositório que não é
 * template, App sem permissão e App não instalado — e esse 404 só apareceria
 * mais tarde, para o primeiro aluno que tentasse criar o repositório dele. Como
 * `repos.get` já era chamado aqui e a resposta traz `is_template` e `archived`,
 * as duas causas verificáveis viram erro na hora, com o conserto no texto.
 */
async function checarTemplateNoGithub(templateRepo: string): Promise<string | null> {
  const [owner, repo] = templateRepo.split('/');
  const octokit = await getInstallationOctokit();

  let data;
  try {
    ({ data } = await withGithubRetry(() => octokit.rest.repos.get({ owner, repo })));
  } catch (err: any) {
    return (
      `O app do Crivo não encontrou '${templateRepo}' no GitHub (${err.message}). ` +
      `Verifique o nome, e se o repositório está na organização onde o app foi instalado ` +
      `e liberado em Repository access.`
    );
  }

  if (!data.is_template) {
    return (
      `O repositório '${templateRepo}' existe, mas não está marcado como template. ` +
      `Marque a caixinha "Template repository" em https://github.com/${templateRepo}/settings ` +
      `e salve de novo — sem isso o GitHub recusa a criação do repositório de cada aluno.`
    );
  }

  if (data.archived) {
    return `O repositório '${templateRepo}' está arquivado e não pode gerar novos repositórios.`;
  }

  return null;
}

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
      aluno_teste: m.usuario.aluno_teste,
    }));

    return reply.send(linhas);
  });

  fastify.get('/prof/alunos/:id', {
    schema: {
      tags: ['professores'], summary: 'Detalha um aluno e todas as suas matrículas',
      security: AUTH_SECURITY, params: docSchema(alunoIdParamsSchema),
    },
  }, async (request, reply) => {
    const { id } = alunoIdParamsSchema.parse(request.params);
    const aluno = await prisma.usuario.findFirst({
      where: { id, papel: 'ALUNO' },
      include: { matriculas: { include: { turma: { include: { disciplina: true } } } } },
    });
    if (!aluno) return reply.status(404).send({ error: 'Aluno not found' });
    return reply.send(serializeBigInt(aluno));
  });

  fastify.patch('/prof/alunos/:id/teste', {
    schema: {
      tags: ['professores'], summary: 'Marca ou desmarca um aluno como conta de teste sem GitHub obrigatório',
      security: AUTH_SECURITY, params: docSchema(alunoIdParamsSchema), body: docSchema(alunoTesteBodySchema),
    },
  }, async (request, reply) => {
    const { id } = alunoIdParamsSchema.parse(request.params);
    const { aluno_teste } = alunoTesteBodySchema.parse(request.body);
    const aluno = await prisma.usuario.findFirst({ where: { id, papel: 'ALUNO' } });
    if (!aluno) return reply.status(404).send({ error: 'Aluno not found' });
    const atualizado = await prisma.usuario.update({ where: { id }, data: { aluno_teste } });
    return reply.send(serializeBigInt(atualizado));
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

    const problemaNoTemplate = await checarTemplateNoGithub(parsed.template_repo);
    if (problemaNoTemplate) {
      reply.status(400).send({ error: problemaNoTemplate });
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

  fastify.patch('/prof/trabalhos/:id', {
    schema: {
      tags: ['professores'],
      summary: 'Edita um trabalho já criado (campos parciais)',
      security: AUTH_SECURITY,
      params: docSchema(trabalhoIdParamsSchema),
      body: docSchema(atualizarTrabalhoBodySchema),
    },
  }, async (request, reply) => {
    const { id: trabalhoId } = trabalhoIdParamsSchema.parse(request.params);
    const parsed = atualizarTrabalhoBodySchema.parse(request.body);

    const trabalho = await prisma.trabalho.findUnique({ where: { id: trabalhoId } });
    if (!trabalho) {
      reply.status(404).send({ error: 'Trabalho not found' });
      return;
    }

    // A janela é um par: um PATCH que mexe só numa ponta ainda pode inverter a ordem.
    const janelaInicio = parsed.janela_inicio ?? trabalho.janela_inicio;
    const deadline = parsed.deadline ?? trabalho.deadline;
    if (deadline <= janelaInicio) {
      reply.status(400).send({ error: 'deadline must be after janela_inicio' });
      return;
    }

    // Mesmo caso do par janela/deadline: min/max de integrantes são checados
    // juntos contra o valor salvo, já que o PATCH pode mexer só numa ponta.
    const minIntegrantes = parsed.min_integrantes_equipe ?? trabalho.min_integrantes_equipe;
    const maxIntegrantes = parsed.max_integrantes_equipe ?? trabalho.max_integrantes_equipe;
    if (minIntegrantes > maxIntegrantes) {
      reply.status(400).send({ error: 'min_integrantes_equipe must not exceed max_integrantes_equipe' });
      return;
    }

    // Trocar o tipo com repositórios criados deixaria repos ALUNO num trabalho de
    // EQUIPE (e vice-versa) — o aluno perderia o acesso ao que já entregou.
    if (parsed.tipo && parsed.tipo !== trabalho.tipo) {
      const reposExistentes = await prisma.repositorio.count({ where: { trabalho_id: trabalhoId } });
      if (reposExistentes > 0) {
        reply.status(400).send({
          error: `Cannot change tipo: ${reposExistentes} repository(ies) already created for this trabalho`,
        });
        return;
      }
    }

    // Mesma validação da criação, só quando o template muda.
    if (parsed.template_repo && parsed.template_repo !== trabalho.template_repo) {
      const problemaNoTemplate = await checarTemplateNoGithub(parsed.template_repo);
      if (problemaNoTemplate) {
        reply.status(400).send({ error: problemaNoTemplate });
        return;
      }
    }

    try {
      const updated = await prisma.trabalho.update({
        where: { id: trabalhoId },
        data: parsed,
      });
      return reply.send(updated);
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
        // O vínculo pode ser removido pelo reset de acesso enquanto o repositório
        // continua existindo. Nunca envie null: a UI usa estes valores em avatares.
        membros = [r.usuario.github_login ?? r.usuario.matricula ?? '(sem login)'];
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
  // 6b. PATCH /prof/repositorios/:id/avaliacao
  // ==========================================

  fastify.patch('/prof/repositorios/:id/avaliacao', {
    schema: {
      tags: ['professores'],
      summary: 'Lança ou atualiza a nota e o comentário da entrega de um repositório',
      security: AUTH_SECURITY,
      params: docSchema(repositorioIdParamsSchema),
      body: docSchema(avaliacaoBodySchema),
    },
  }, async (request, reply) => {
    const { id: repoId } = repositorioIdParamsSchema.parse(request.params);

    const bodyParse = avaliacaoBodySchema.safeParse(request.body);
    if (!bodyParse.success) {
      reply.status(400).send({ error: bodyParse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    const { nota, comentario } = bodyParse.data;

    const repo = await prisma.repositorio.findUnique({ where: { id: repoId } });
    if (!repo) {
      reply.status(404).send({ error: 'Repository not found' });
      return;
    }

    const avaliacao = await prisma.avaliacao.upsert({
      where: { repositorio_id: repoId },
      create: { repositorio_id: repoId, nota, comentario, avaliado_por: request.user!.id },
      update: { nota, comentario, avaliado_por: request.user!.id },
    });

    return reply.send(serializeBigInt(avaliacao));
  });

  fastify.delete('/prof/repositorios/:id', {
    schema: {
      tags: ['professores'],
      summary: 'Exclui um repositório no GitHub e todos os seus dados no Crivo',
      security: AUTH_SECURITY,
      params: docSchema(repositorioIdParamsSchema),
    },
  }, async (request, reply) => {
    const { id: repoId } = repositorioIdParamsSchema.parse(request.params);
    const repositorio = await prisma.repositorio.findUnique({ where: { id: repoId } });

    if (!repositorio) {
      reply.status(404).send({ error: 'Repositório not found' });
      return;
    }

    const [owner, repo] = repositorio.nome_completo.split('/');
    if (!owner || !repo) {
      reply.status(500).send({ error: 'Nome completo do repositório inválido' });
      return;
    }

    const octokit = await getInstallationOctokit();
    try {
      await withGithubRetry(() => octokit.rest.repos.delete({ owner, repo }));
    } catch (error: any) {
      // Permite concluir uma exclusão interrompida entre o GitHub e o banco.
      if (error?.status !== 404) throw error;
    }

    // As relações do Repositorio usam onDelete: Cascade para pushes, commits,
    // entregas e sinalizações. Matrícula, aluno/equipe e trabalho permanecem.
    await prisma.repositorio.delete({ where: { id: repoId } });
    return reply.status(204).send();
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

  // ==========================================
  // 9. CRUD /prof/trabalhos/:id/entregas-agendadas
  // ==========================================
  //
  // Marcos de entrega além do deadline único do trabalho (que estas rotas
  // nunca tocam). Cada marco gera, quando congelado, uma Entrega normal
  // (mesma tag entrega-N por repositório) com entrega_agendada_id apontando
  // para ele. `data_hora` no passado + POST .../congelar é como se cria uma
  // entrega retroativa: ver `congelarUmMarco` em src/jobs/congelador.ts.

  fastify.get('/prof/trabalhos/:id/entregas-agendadas', {
    schema: {
      tags: ['professores'],
      summary: 'Lista os marcos de entrega agendados de um trabalho',
      security: AUTH_SECURITY,
      params: docSchema(trabalhoIdParamsSchema),
    },
  }, async (request, reply) => {
    const { id: trabalhoId } = trabalhoIdParamsSchema.parse(request.params);

    const trabalho = await prisma.trabalho.findUnique({ where: { id: trabalhoId } });
    if (!trabalho) {
      reply.status(404).send({ error: 'Trabalho not found' });
      return;
    }

    const marcos = await prisma.entregaAgendada.findMany({
      where: { trabalho_id: trabalhoId },
      include: { entregas: true },
      orderBy: { data_hora: 'asc' },
    });

    return reply.send(
      marcos.map(({ entregas, ...marco }) => ({
        ...marco,
        repositorios_congelados: entregas.length,
      }))
    );
  });

  fastify.post('/prof/trabalhos/:id/entregas-agendadas', {
    schema: {
      tags: ['professores'],
      summary: 'Cria um marco de entrega agendado (data pode ser retroativa)',
      security: AUTH_SECURITY,
      params: docSchema(trabalhoIdParamsSchema),
      body: docSchema(criarEntregaAgendadaBodySchema),
    },
  }, async (request, reply) => {
    const { id: trabalhoId } = trabalhoIdParamsSchema.parse(request.params);
    const parsed = criarEntregaAgendadaBodySchema.parse(request.body);

    const trabalho = await prisma.trabalho.findUnique({ where: { id: trabalhoId } });
    if (!trabalho) {
      reply.status(404).send({ error: 'Trabalho not found' });
      return;
    }

    try {
      const criado = await prisma.entregaAgendada.create({
        data: { trabalho_id: trabalhoId, ...parsed },
      });
      return reply.status(201).send(criado);
    } catch (err: any) {
      if (err.code === 'P2002') {
        reply.status(409).send({ error: 'Já existe um marco com este nome neste trabalho' });
      } else {
        throw err;
      }
    }
  });

  fastify.patch('/prof/trabalhos/:id/entregas-agendadas/:entregaAgendadaId', {
    schema: {
      tags: ['professores'],
      summary: 'Edita um marco de entrega agendado (campos parciais)',
      security: AUTH_SECURITY,
      params: docSchema(entregaAgendadaParamsSchema),
      body: docSchema(atualizarEntregaAgendadaBodySchema),
    },
  }, async (request, reply) => {
    const { id: trabalhoId, entregaAgendadaId } = entregaAgendadaParamsSchema.parse(request.params);
    const parsed = atualizarEntregaAgendadaBodySchema.parse(request.body);

    const marco = await prisma.entregaAgendada.findFirst({
      where: { id: entregaAgendadaId, trabalho_id: trabalhoId },
    });
    if (!marco) {
      reply.status(404).send({ error: 'Marco de entrega not found' });
      return;
    }

    try {
      const atualizado = await prisma.entregaAgendada.update({
        where: { id: entregaAgendadaId },
        data: parsed,
      });
      return reply.send(atualizado);
    } catch (err: any) {
      if (err.code === 'P2002') {
        reply.status(409).send({ error: 'Já existe um marco com este nome neste trabalho' });
      } else {
        throw err;
      }
    }
  });

  fastify.delete('/prof/trabalhos/:id/entregas-agendadas/:entregaAgendadaId', {
    schema: {
      tags: ['professores'],
      summary: 'Exclui um marco de entrega agendado que ainda não gerou nenhuma entrega',
      security: AUTH_SECURITY,
      params: docSchema(entregaAgendadaParamsSchema),
    },
  }, async (request, reply) => {
    const { id: trabalhoId, entregaAgendadaId } = entregaAgendadaParamsSchema.parse(request.params);

    const marco = await prisma.entregaAgendada.findFirst({
      where: { id: entregaAgendadaId, trabalho_id: trabalhoId },
      include: { entregas: true },
    });
    if (!marco) {
      reply.status(404).send({ error: 'Marco de entrega not found' });
      return;
    }

    // Um marco que já congelou algum repositório carrega evidência — excluir
    // apagaria o vínculo, não o registro (onDelete: SetNull), mas escondê-lo
    // da lista confundiria mais do que ajudaria. Bloqueado, como a exclusão
    // de sinalizações decididas.
    if (marco.entregas.length > 0) {
      reply.status(409).send({
        error: `Este marco já gerou ${marco.entregas.length} entrega(s) — não pode ser excluído`,
      });
      return;
    }

    await prisma.entregaAgendada.delete({ where: { id: entregaAgendadaId } });
    return reply.status(204).send();
  });

  fastify.post('/prof/trabalhos/:id/entregas-agendadas/:entregaAgendadaId/congelar', {
    schema: {
      tags: ['professores'],
      summary: 'Congela agora os repositórios deste marco (pode ser retroativo)',
      security: AUTH_SECURITY,
      params: docSchema(entregaAgendadaParamsSchema),
      querystring: docSchema(congelarQuerySchema),
    },
  }, async (request, reply) => {
    const { id: trabalhoId, entregaAgendadaId } = entregaAgendadaParamsSchema.parse(request.params);
    const { force } = congelarQuerySchema.parse(request.query);

    const marco = await prisma.entregaAgendada.findFirst({
      where: { id: entregaAgendadaId, trabalho_id: trabalhoId },
    });
    if (!marco) {
      reply.status(404).send({ error: 'Marco de entrega not found' });
      return;
    }

    await runCongelador({ entregaAgendadaId, force });

    return reply.send({ success: true, message: 'Freezing routine executed for this marco' });
  });

  // ==========================================
  // 10. GET /prof/trabalhos/:id/entregas/download
  // ==========================================

  fastify.get('/prof/trabalhos/:id/entregas/download', {
    schema: {
      tags: ['professores'],
      summary: 'Baixa um .zip com o código de todos os repositórios de uma entrega',
      security: AUTH_SECURITY,
      params: docSchema(trabalhoIdParamsSchema),
      querystring: docSchema(downloadEntregasQuerySchema),
    },
  }, async (request, reply) => {
    const { id: trabalhoId } = trabalhoIdParamsSchema.parse(request.params);
    const { entrega_agendada_id: entregaAgendadaId } = downloadEntregasQuerySchema.parse(request.query);

    const trabalho = await prisma.trabalho.findUnique({ where: { id: trabalhoId } });
    if (!trabalho) {
      reply.status(404).send({ error: 'Trabalho not found' });
      return;
    }

    let rotuloEntrega = 'entrega';
    if (entregaAgendadaId) {
      const marco = await prisma.entregaAgendada.findFirst({
        where: { id: entregaAgendadaId, trabalho_id: trabalhoId },
      });
      if (!marco) {
        reply.status(404).send({ error: 'Marco de entrega not found' });
        return;
      }
      rotuloEntrega = marco.nome;
    }

    const entregas = await prisma.entrega.findMany({
      where: { trabalho_id: trabalhoId, entrega_agendada_id: entregaAgendadaId ?? null },
      include: {
        repositorio: { include: { usuario: true, equipe: true } },
      },
    });

    if (entregas.length === 0) {
      reply.status(404).send({ error: 'Nenhuma entrega congelada encontrada para este momento' });
      return;
    }

    const octokit = await getInstallationOctokit();
    const nomeArquivo = `${slugParaArquivo(trabalho.slug)}-${slugParaArquivo(rotuloEntrega)}.zip`;

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', (err: Error) => {
      logger.error({ err: err.message, trabalhoId, entregaAgendadaId }, 'Error streaming entregas zip');
      archive.destroy(err);
    });

    // Entrega o stream pelo Fastify, em vez de escrever diretamente em
    // reply.raw. Assim os hooks (principalmente o @fastify/cors) conseguem
    // anexar seus headers antes de a resposta começar.
    reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${nomeArquivo}"`)
      .send(archive);

    for (const entrega of entregas) {
      const repo = entrega.repositorio;
      const [owner, repoName] = repo.nome_completo.split('/');
      const nomeDono = repo.dono_tipo === 'EQUIPE'
        ? (repo.equipe?.nome ?? repoName)
        : (repo.usuario?.nome ?? repoName);
      const nomeCurto = slugParaArquivo(nomeDono);

      try {
        const { data } = await withGithubRetry(() =>
          octokit.rest.repos.downloadZipballArchive({ owner, repo: repoName, ref: entrega.sha_congelado })
        );
        archive.append(Buffer.from(data as ArrayBuffer), { name: `${nomeCurto}.zip` });
      } catch (err: any) {
        // Um repositório com falha (ex.: excluído do GitHub depois de congelado)
        // não deve interromper o zip inteiro — o professor vê o motivo dentro dele.
        logger.error({ err: err.message, repoName: repo.nome_completo }, 'Failed to download repo zipball for entregas bundle');
        archive.append(
          `Não foi possível baixar ${repo.nome_completo} no commit ${entrega.sha_congelado}: ${err.message}`,
          { name: `ERRO-${nomeCurto}.txt` }
        );
      }
    }

    await archive.finalize();
    return reply;
  });
}
export default professorRoutes;

/** Nome de arquivo seguro a partir de um texto livre (nome de aluno/equipe, título de trabalho). */
function slugParaArquivo(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sem-nome';
}
