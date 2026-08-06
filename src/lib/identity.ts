/**
 * Bots do GitHub — a GitHub App que gera os repositórios a partir do template
 * (`crivo-faminas[bot]`), Actions, etc. — têm login no formato `<nome>[bot]`.
 * Nomes de usuário reais não podem conter `[` nem `]`, então esse sufixo
 * identifica um bot com segurança, sem depender de configuração.
 *
 * Por que importa: o commit inicial de todo repositório é o scaffold criado
 * pelo bot ao gerar do template. Isso NÃO é atividade do aluno — tratá-lo como
 * tal dispara falsos-positivos em TODO repositório (divergência pusher × autor,
 * porque o bot ≠ dono; e autor não reconhecido, porque o e-mail do bot não está
 * vinculado a nenhum `Usuario`). Bots são infraestrutura, não integridade
 * acadêmica: sua atividade é ignorada na ingestão e nos detectores.
 */
export function isBotLogin(login: string | null | undefined): boolean {
  return typeof login === 'string' && login.endsWith('[bot]');
}
