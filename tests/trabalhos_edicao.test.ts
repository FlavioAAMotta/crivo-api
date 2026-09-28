import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { getInstallationOctokit } from '../src/lib/octokit.js';
import { signToken } from '../src/lib/auth.js';

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); },
  Worker: class { on = vi.fn(); },
}));

vi.mock('../src/lib/octokit.js', () => ({
  getInstallationOctokit: vi.fn(),
  withGithubRetry: (fn: any) => fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    turma: { findUnique: vi.fn(), findMany: vi.fn() },
    matricula: { findMany: vi.fn() },
    equipeMembro: { count: vi.fn() },
    solicitacaoEquipe: { count: vi.fn() },
    trabalho: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    repositorio: {
      count: vi.fn(),
    },
  },
}));

const PROFESSOR = { id: 1, github_id: '1', github_login: 'mtavares', papel: 'PROFESSOR' as const };
const ALUNO = { id: 2, github_id: '2', github_login: 'joaopsilva', papel: 'ALUNO' as const };

function auth(user: typeof PROFESSOR | typeof ALUNO) {
  return { authorization: `Bearer ${signToken(user)}` };
}

const TRABALHO = {
  id: 7,
  turma_id: 3,
  titulo: 'Trabalho 2',
  descricao_md: '## Objetivo',
  slug: 'trabalho-2',
  tipo: 'EQUIPE',
  template_repo: 'faminas-ads/template-errado',
  janela_inicio: new Date('2026-03-01T12:00:00Z'),
  deadline: new Date('2026-04-01T12:00:00Z'),
  congelamento_automatico: true,
};

describe('PATCH /prof/trabalhos/:id', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({ ...TRABALHO } as any);
    vi.mocked(prisma.trabalho.update).mockImplementation((async ({ data }: any) => ({
      ...TRABALHO,
      ...data,
    })) as any);
    vi.mocked(getInstallationOctokit).mockResolvedValue({
      rest: { repos: { get: vi.fn().mockResolvedValue({ data: { is_template: true } }) } },
    } as any);
  });

  it('recusa aluno', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/trabalhos/7',
      headers: auth(ALUNO),
      payload: { template_repo: 'faminas-ads/template-certo' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('corrige o template validando o novo repositório no GitHub', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/trabalhos/7',
      headers: auth(PROFESSOR),
      payload: { template_repo: 'faminas-ads/template-certo' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).template_repo).toBe('faminas-ads/template-certo');
    // Só o campo enviado vai para o update — PATCH não zera o resto.
    expect(vi.mocked(prisma.trabalho.update).mock.calls[0][0].data).toEqual({
      template_repo: 'faminas-ads/template-certo',
    });
  });

  it('rejeita template inexistente no GitHub sem tocar no banco', async () => {
    vi.mocked(getInstallationOctokit).mockResolvedValue({
      rest: { repos: { get: vi.fn().mockRejectedValue(new Error('Not Found')) } },
    } as any);

    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/trabalhos/7',
      headers: auth(PROFESSOR),
      payload: { template_repo: 'faminas-ads/nao-existe' },
    });

    expect(response.statusCode).toBe(400);
    expect(prisma.trabalho.update).not.toHaveBeenCalled();
  });

  it('rejeita repositório que existe mas não é template, dizendo onde marcar', async () => {
    vi.mocked(getInstallationOctokit).mockResolvedValue({
      rest: { repos: { get: vi.fn().mockResolvedValue({ data: { is_template: false } }) } },
    } as any);

    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/trabalhos/7',
      headers: auth(PROFESSOR),
      payload: { template_repo: 'faminas-ads/repo-comum' },
    });

    expect(response.statusCode).toBe(400);
    // O professor precisa saber o que fazer, não só que falhou.
    expect(JSON.parse(response.body).error).toContain('Template repository');
    expect(JSON.parse(response.body).error).toContain('/settings');
    expect(prisma.trabalho.update).not.toHaveBeenCalled();
  });

  it('rejeita template arquivado', async () => {
    vi.mocked(getInstallationOctokit).mockResolvedValue({
      rest: {
        repos: { get: vi.fn().mockResolvedValue({ data: { is_template: true, archived: true } }) },
      },
    } as any);

    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/trabalhos/7',
      headers: auth(PROFESSOR),
      payload: { template_repo: 'faminas-ads/template-velho' },
    });

    expect(response.statusCode).toBe(400);
    expect(prisma.trabalho.update).not.toHaveBeenCalled();
  });

  it('não consulta o GitHub quando o template não mudou', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/trabalhos/7',
      headers: auth(PROFESSOR),
      payload: { titulo: 'Trabalho 2 — Consultas', template_repo: TRABALHO.template_repo },
    });

    expect(response.statusCode).toBe(200);
    expect(getInstallationOctokit).not.toHaveBeenCalled();
  });

  it('bloqueia troca de tipo quando já existem repositórios', async () => {
    vi.mocked(prisma.repositorio.count).mockResolvedValue(4);

    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/trabalhos/7',
      headers: auth(PROFESSOR),
      payload: { tipo: 'INDIVIDUAL' },
    });

    expect(response.statusCode).toBe(400);
    expect(prisma.trabalho.update).not.toHaveBeenCalled();
  });

  it('permite trocar o tipo enquanto nenhum repositório foi criado', async () => {
    vi.mocked(prisma.repositorio.count).mockResolvedValue(0);

    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/trabalhos/7',
      headers: auth(PROFESSOR),
      payload: { tipo: 'INDIVIDUAL' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).tipo).toBe('INDIVIDUAL');
  });

  it('permite configurar min_integrantes_equipe = 1 num trabalho já existente', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/trabalhos/7',
      headers: auth(PROFESSOR),
      payload: { min_integrantes_equipe: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).min_integrantes_equipe).toBe(1);
    // Só o campo enviado vai para o update — equipes/repos já criados não são tocados.
    expect(vi.mocked(prisma.trabalho.update).mock.calls[0][0].data).toEqual({
      min_integrantes_equipe: 1,
    });
  });

  it('rejeita min_integrantes_equipe menor que 1', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/trabalhos/7',
      headers: auth(PROFESSOR),
      payload: { min_integrantes_equipe: 0 },
    });

    expect(response.statusCode).toBe(400);
    expect(prisma.trabalho.update).not.toHaveBeenCalled();
  });

  it('rejeita prazo anterior ao início da janela guardado no banco', async () => {
    // Só o deadline vem no corpo; a outra ponta do par é a do trabalho existente.
    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/trabalhos/7',
      headers: auth(PROFESSOR),
      payload: { deadline: '2026-02-01T12:00:00.000Z' },
    });

    expect(response.statusCode).toBe(400);
    expect(prisma.trabalho.update).not.toHaveBeenCalled();
  });

  it('404 em trabalho inexistente', async () => {
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue(null as any);

    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/trabalhos/999',
      headers: auth(PROFESSOR),
      payload: { titulo: 'Qualquer coisa' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('409 quando o slug já pertence a outro trabalho', async () => {
    vi.mocked(prisma.trabalho.update).mockRejectedValue(
      Object.assign(new Error('Unique constraint'), { code: 'P2002' }),
    );

    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/trabalhos/7',
      headers: auth(PROFESSOR),
      payload: { slug: 'trabalho-1' },
    });

    expect(response.statusCode).toBe(409);
  });

  it('bloqueia remoção de subturma quando aluno perderia equipe', async () => {
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({ ...TRABALHO,
      turmas_vinculadas: [{ turma_id: 3 }, { turma_id: 4 }] } as any);
    vi.mocked(prisma.turma.findUnique).mockResolvedValue({ id: 3, disciplina_id: 1, periodo: '2026.1' } as any);
    vi.mocked(prisma.turma.findMany).mockResolvedValue([{ id: 3, disciplina_id: 1, periodo: '2026.1' }] as any);
    vi.mocked(prisma.matricula.findMany).mockResolvedValue([{ usuario_id: 20 }] as any);
    vi.mocked(prisma.equipeMembro.count).mockResolvedValue(1);
    vi.mocked(prisma.repositorio.count).mockResolvedValue(0);
    const response = await app.inject({ method: 'PATCH', url: '/prof/trabalhos/7', headers: auth(PROFESSOR),
      payload: { turma_ids: [3] } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('equipe ou repositório');
    expect(prisma.trabalho.update).not.toHaveBeenCalled();
  });

  it('bloqueia remoção de subturma quando aluno perderia repositório individual', async () => {
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({ ...TRABALHO,
      turmas_vinculadas: [{ turma_id: 3 }, { turma_id: 4 }] } as any);
    vi.mocked(prisma.turma.findUnique).mockResolvedValue({ id: 3, disciplina_id: 1, periodo: '2026.1' } as any);
    vi.mocked(prisma.turma.findMany).mockResolvedValue([{ id: 3, disciplina_id: 1, periodo: '2026.1' }] as any);
    vi.mocked(prisma.matricula.findMany).mockResolvedValue([{ usuario_id: 20 }] as any);
    vi.mocked(prisma.equipeMembro.count).mockResolvedValue(0);
    vi.mocked(prisma.repositorio.count).mockResolvedValue(1);
    const response = await app.inject({ method: 'PATCH', url: '/prof/trabalhos/7', headers: auth(PROFESSOR),
      payload: { turma_ids: [3] } });
    expect(response.statusCode).toBe(409);
    expect(prisma.trabalho.update).not.toHaveBeenCalled();
  });

  it('bloqueia remoção de subturma com solicitação de entrada pendente', async () => {
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({ ...TRABALHO,
      turmas_vinculadas: [{ turma_id: 3 }, { turma_id: 4 }] } as any);
    vi.mocked(prisma.turma.findUnique).mockResolvedValue({ id: 3, disciplina_id: 1, periodo: '2026.1' } as any);
    vi.mocked(prisma.turma.findMany).mockResolvedValue([{ id: 3, disciplina_id: 1, periodo: '2026.1' }] as any);
    vi.mocked(prisma.matricula.findMany).mockResolvedValue([{ usuario_id: 20 }] as any);
    vi.mocked(prisma.equipeMembro.count).mockResolvedValue(0);
    vi.mocked(prisma.repositorio.count).mockResolvedValue(0);
    vi.mocked(prisma.solicitacaoEquipe.count).mockResolvedValue(1);

    const response = await app.inject({ method: 'PATCH', url: '/prof/trabalhos/7', headers: auth(PROFESSOR),
      payload: { turma_ids: [3] } });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('solicitação');
    expect(prisma.trabalho.update).not.toHaveBeenCalled();
  });

  it('rejeita turma_ids vazio com HTTP 400 ao editar', async () => {
    const response = await app.inject({ method: 'PATCH', url: '/prof/trabalhos/7', headers: auth(PROFESSOR),
      payload: { turma_ids: [] } });

    expect(response.statusCode).toBe(400);
    expect(prisma.trabalho.update).not.toHaveBeenCalled();
  });

  it('permite remover subturma sem órfãos e mantém a turma principal', async () => {
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({ ...TRABALHO,
      turmas_vinculadas: [{ turma_id: 3 }, { turma_id: 4 }] } as any);
    vi.mocked(prisma.turma.findUnique).mockResolvedValue({ id: 3, disciplina_id: 1, periodo: '2026.1' } as any);
    vi.mocked(prisma.turma.findMany).mockResolvedValue([{ id: 3, disciplina_id: 1, periodo: '2026.1' }] as any);
    vi.mocked(prisma.matricula.findMany).mockResolvedValue([] as any);
    const response = await app.inject({ method: 'PATCH', url: '/prof/trabalhos/7', headers: auth(PROFESSOR),
      payload: { turma_ids: [3] } });
    expect(response.statusCode).toBe(200);
    expect(vi.mocked(prisma.trabalho.update).mock.calls[0][0].data).toMatchObject({
      turmas_vinculadas: { deleteMany: { turma_id: { in: [4] } } },
    });
  });

  it('nunca remove a turma principal', async () => {
    const response = await app.inject({ method: 'PATCH', url: '/prof/trabalhos/7', headers: auth(PROFESSOR),
      payload: { turma_ids: [4] } });
    expect(response.statusCode).toBe(400);
    expect(prisma.trabalho.update).not.toHaveBeenCalled();
  });
});

describe('POST /prof/trabalhos — checagem do template', () => {
  const app = buildApp();

  const corpo = {
    turma_id: 3,
    titulo: 'Trabalho 3',
    descricao_md: '',
    slug: 'trabalho-3',
    tipo: 'EQUIPE',
    template_repo: 'faminas-ads/template',
    janela_inicio: '2026-03-01T12:00:00.000Z',
    deadline: '2026-04-01T12:00:00.000Z',
    congelamento_automatico: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.trabalho.create).mockResolvedValue({ id: 9, ...corpo } as any);
    vi.mocked(prisma.turma.findUnique).mockResolvedValue({ id: 3, disciplina_id: 1, periodo: '2026.1' } as any);
    vi.mocked(prisma.turma.findMany).mockResolvedValue([{ id: 3, disciplina_id: 1, periodo: '2026.1' }] as any);
  });

  it('cria quando o repositório é template', async () => {
    vi.mocked(getInstallationOctokit).mockResolvedValue({
      rest: { repos: { get: vi.fn().mockResolvedValue({ data: { is_template: true } }) } },
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/trabalhos',
      headers: auth(PROFESSOR),
      payload: corpo,
    });

    expect(response.statusCode).toBe(201);
  });

  it('grava um trabalho único para duas subturmas compatíveis', async () => {
    vi.mocked(prisma.turma.findMany).mockResolvedValue([
      { id: 3, disciplina_id: 1, periodo: '2026.1' },
      { id: 4, disciplina_id: 1, periodo: '2026.1' },
    ] as any);
    vi.mocked(getInstallationOctokit).mockResolvedValue({
      rest: { repos: { get: vi.fn().mockResolvedValue({ data: { is_template: true } }) } },
    } as any);
    const response = await app.inject({ method: 'POST', url: '/prof/trabalhos', headers: auth(PROFESSOR),
      payload: { ...corpo, turma_ids: [3, 4] } });
    expect(response.statusCode).toBe(201);
    expect(prisma.trabalho.create).toHaveBeenCalledOnce();
    expect(vi.mocked(prisma.trabalho.create).mock.calls[0][0].data).toMatchObject({
      turma_id: 3, turmas_vinculadas: { create: [{ turma_id: 3 }, { turma_id: 4 }] },
    });
  });

  it('rejeita turma_ids vazio com HTTP 400 ao criar', async () => {
    const response = await app.inject({ method: 'POST', url: '/prof/trabalhos', headers: auth(PROFESSOR),
      payload: { ...corpo, turma_ids: [] } });

    expect(response.statusCode).toBe(400);
    expect(prisma.trabalho.create).not.toHaveBeenCalled();
  });

  it('recusa antes de gravar quando falta a marcação de template', async () => {
    vi.mocked(getInstallationOctokit).mockResolvedValue({
      rest: { repos: { get: vi.fn().mockResolvedValue({ data: { is_template: false } }) } },
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/trabalhos',
      headers: auth(PROFESSOR),
      payload: corpo,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain('Template repository');
    // O trabalho não nasce quebrado: o erro apareceria só no primeiro aluno.
    expect(prisma.trabalho.create).not.toHaveBeenCalled();
  });
});
