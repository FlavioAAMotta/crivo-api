import { describe, expect, it } from 'vitest';
import { idsTurmasDoTrabalho, alunoParticipaDoTrabalho } from '../src/lib/subturmas.js';

describe('participação por trabalho', () => {
  const trabalho = { turma_id: 1, turmas_vinculadas: [{ turma_id: 1 }, { turma_id: 2 }] };

  it('inclui a subturma principal e a adicional sem duplicar', () => {
    expect(idsTurmasDoTrabalho(trabalho)).toEqual([1, 2]);
  });

  it('mantém acesso de trabalhos antigos sem vínculos carregados', () => {
    expect(idsTurmasDoTrabalho({ turma_id: 1 })).toEqual([1]);
  });

  it('admite aluno de qualquer subturma vinculada e isola as outras', () => {
    expect(alunoParticipaDoTrabalho(trabalho, [{ usuario_id: 8, turma_id: 2 }], 8)).toBe(true);
    expect(alunoParticipaDoTrabalho(trabalho, [{ usuario_id: 8, turma_id: 3 }], 8)).toBe(false);
  });
});
