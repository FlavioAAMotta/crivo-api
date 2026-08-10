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
    trabalho: {
      findUnique: vi.fn(),
      update: vi.fn(),
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
      rest: { repos: { get: vi.fn().mockResolvedValue({ data: {} }) } },
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
});
