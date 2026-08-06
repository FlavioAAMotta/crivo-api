import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { getInstallationOctokit } from '../src/lib/octokit.js';
import { configureRepository } from '../src/services/repo.js';

// withGithubRetry como passthrough: o retry em si não é o que este teste checa.
vi.mock('../src/lib/octokit.js', () => ({
  getInstallationOctokit: vi.fn(),
  withGithubRetry: (fn: any) => fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    repositorio: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../src/jobs/queues.js', () => ({
  enqueueRepoSetupJob: vi.fn(),
}));

/** Repo individual de um aluno, com a main já materializada. */
function octokitBase() {
  return {
    rest: {
      repos: {
        getBranch: vi.fn().mockResolvedValue({}), // main existe já na 1ª tentativa
        addCollaborator: vi.fn().mockResolvedValue({}),
        getRepoRulesets: vi.fn().mockResolvedValue({ data: [] }),
        createRepoRuleset: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

/** Erro que o GitHub devolve para ruleset em repo privado de org no plano Free. */
function planLimitationError() {
  return Object.assign(
    new Error('Upgrade to GitHub Pro or make this repository public to enable this feature'),
    { status: 403 },
  );
}

describe('configureRepository — proteção da main é best-effort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue({
      id: 1,
      nome_completo: 'faminas-ads/repo-aluno',
      dono_tipo: 'ALUNO',
      usuario: { github_login: 'aluno-dono' },
      equipe: null,
    } as any);
    vi.mocked(prisma.repositorio.update).mockResolvedValue({} as any);
  });

  it('marca CONFIGURADO quando tudo dá certo', async () => {
    vi.mocked(getInstallationOctokit).mockResolvedValue(octokitBase() as any);

    await configureRepository(1);

    expect(prisma.repositorio.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ setup_status: 'CONFIGURADO', setup_erro: null }),
      }),
    );
  });

  it('marca CONFIGURADO mesmo quando o ruleset falha por limitação de plano', async () => {
    const octokit = octokitBase();
    octokit.rest.repos.createRepoRuleset.mockRejectedValue(planLimitationError());
    vi.mocked(getInstallationOctokit).mockResolvedValue(octokit as any);

    // O ponto do bug: o repo funciona (colaborador foi adicionado); não pode virar ERRO.
    await expect(configureRepository(1)).resolves.toBeUndefined();

    expect(octokit.rest.repos.addCollaborator).toHaveBeenCalled();
    expect(prisma.repositorio.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ setup_status: 'CONFIGURADO', setup_erro: null }),
      }),
    );
  });

  it('marca CONFIGURADO mesmo quando o ruleset falha por erro inesperado (repo continua utilizável)', async () => {
    const octokit = octokitBase();
    octokit.rest.repos.createRepoRuleset.mockRejectedValue(
      Object.assign(new Error('kaboom'), { status: 500 }),
    );
    vi.mocked(getInstallationOctokit).mockResolvedValue(octokit as any);

    await expect(configureRepository(1)).resolves.toBeUndefined();
    expect(prisma.repositorio.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ setup_status: 'CONFIGURADO' }),
      }),
    );
  });

  it('PROPAGA o erro quando o passo essencial (colaborador) falha — aí o setup deve retry/ERRO', async () => {
    const octokit = octokitBase();
    octokit.rest.repos.addCollaborator.mockRejectedValue(
      Object.assign(new Error('permission denied'), { status: 403 }),
    );
    vi.mocked(getInstallationOctokit).mockResolvedValue(octokit as any);

    // Sem acesso do aluno, o repo NÃO está utilizável: não pode marcar CONFIGURADO.
    await expect(configureRepository(1)).rejects.toThrow();
    expect(prisma.repositorio.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ setup_status: 'CONFIGURADO' }),
      }),
    );
  });
});
