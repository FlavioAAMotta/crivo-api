/**
 * A janela do trabalho tem duas pontas e as duas são travas, não decoração:
 *
 * - `janela_inicio` é o instante em que o trabalho **abre** para o aluno. Antes
 *   dele o aluno sabe apenas que o trabalho existe (título, tipo e quando abre);
 *   o enunciado e a criação do repositório ficam indisponíveis. É o que permite
 *   marcar um trabalho com antecedência sem entregá-lo antes da hora.
 * - `deadline` é o congelamento (ver `src/jobs/congelador.ts`).
 *
 * A única coisa liberada antes da abertura é **formar equipe**: equipes são por
 * trabalho (`Equipe.trabalho_id`), então montar o grupo é justamente o preparo
 * que faz sentido acontecer antes de ver o enunciado. Ver `docs/DECISOES.md` D15.
 */

/** `true` quando o trabalho já abriu para o aluno. */
export function trabalhoLiberado(janelaInicio: Date | string, agora: Date = new Date()): boolean {
  const inicio = janelaInicio instanceof Date ? janelaInicio : new Date(janelaInicio);
  return agora.getTime() >= inicio.getTime();
}

/**
 * Erro de trabalho ainda fechado. Carrega o 403 para o handler não ter que
 * adivinhar — e a mensagem **não** formata a data de propósito: o servidor não
 * conhece o fuso do aluno, e o front já recebe `janela_inicio` para escrever
 * "abre hoje às 19:00" no horário local.
 */
export class TrabalhoNaoLiberadoError extends Error {
  statusCode = 403;
  janela_inicio: Date;

  constructor(janelaInicio: Date) {
    super('Este trabalho ainda não foi liberado — só a formação de equipes está aberta até lá.');
    this.name = 'TrabalhoNaoLiberadoError';
    this.janela_inicio = janelaInicio;
  }
}

/** Barra a ação quando o trabalho ainda não abriu. */
export function exigirTrabalhoLiberado(janelaInicio: Date, agora: Date = new Date()): void {
  if (!trabalhoLiberado(janelaInicio, agora)) {
    throw new TrabalhoNaoLiberadoError(janelaInicio);
  }
}
