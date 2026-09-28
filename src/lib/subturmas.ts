/** A turma principal continua sendo a âncora dos trabalhos antigos. */
export function idsTurmasDoTrabalho(trabalho: {
  turma_id: number;
  turmas_vinculadas?: { turma_id: number }[];
}): number[] {
  return [...new Set([trabalho.turma_id, ...(trabalho.turmas_vinculadas ?? []).map(v => v.turma_id)])];
}

export function alunoParticipaDoTrabalho(
  trabalho: { turma_id: number; turmas_vinculadas?: { turma_id: number }[] },
  matriculas: { usuario_id: number; turma_id: number }[],
  usuarioId: number,
): boolean {
  const turmas = new Set(idsTurmasDoTrabalho(trabalho));
  return matriculas.some(m => m.usuario_id === usuarioId && turmas.has(m.turma_id));
}

/** Inclui matrículas vindas das relações Prisma da turma principal e adicionais. */
export function matriculasDoTrabalho(trabalho: {
  turma_id: number;
  turma?: { matriculas: { usuario_id: number }[] };
  turmas_vinculadas?: { turma_id: number; turma?: { matriculas: { usuario_id: number }[] } }[];
}): { usuario_id: number; turma_id: number }[] {
  return [
    ...(trabalho.turma?.matriculas ?? []).map(m => ({ ...m, turma_id: trabalho.turma_id })),
    ...(trabalho.turmas_vinculadas ?? []).flatMap(v =>
      (v.turma?.matriculas ?? []).map(m => ({ ...m, turma_id: v.turma_id }))),
  ];
}
