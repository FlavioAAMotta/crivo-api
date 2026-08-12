import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

/**
 * Discriminadores de namespace de token. Os dois tipos de JWT (sessão e
 * pré-ativação) são assinados com o MESMO `JWT_SECRET`, então a assinatura
 * sozinha não distingue um do outro: sem o campo `typ`, um token de
 * pré-ativação (payload `{usuario_id, etapa}`) passa por `jwt.verify` e vira
 * um `request.user` com `id === undefined` — e `undefined` num `where` do
 * Prisma significa "sem filtro", ou seja, vazamento de base inteira.
 * `typ` é o que torna os dois namespaces estruturalmente incompatíveis.
 */
export const TOKEN_TYPE_SESSAO = 'sessao' as const;
export const TOKEN_TYPE_PREAUTH = 'preauth' as const;

export interface UserPayload {
  id: number;
  github_id: string | null; // Serialized BigInt as string
  github_login: string | null;
  papel: 'ALUNO' | 'PROFESSOR';
  typ: typeof TOKEN_TYPE_SESSAO;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserPayload;
  }
}

/**
 * Signs a user payload into a JWT token.
 * Ensures the github_id BigInt is serialized to string.
 */
export function signToken(payload: { id: number; github_id: bigint | string | null; github_login: string | null; papel: 'ALUNO' | 'PROFESSOR' }): string {
  const tokenPayload: UserPayload = {
    id: payload.id,
    github_id: payload.github_id?.toString() ?? null,
    github_login: payload.github_login,
    papel: payload.papel,
    // Carimbado aqui, num lugar só: quem chama signToken não precisa saber.
    typ: TOKEN_TYPE_SESSAO,
  };
  return jwt.sign(tokenPayload, config.JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Verifies a JWT token.
 *
 * Além da assinatura, exige `typ === 'sessao'` e o formato mínimo de sessão.
 * Um token de pré-ativação (mesmo secret, payload diferente) é rejeitado aqui
 * — é este check que impede que ele vire uma sessão com `id` indefinido.
 */
export function verifyToken(token: string): UserPayload {
  const decoded = jwt.verify(token, config.JWT_SECRET) as any;
  if (decoded?.typ !== TOKEN_TYPE_SESSAO) {
    throw new Error('Token de sessão inválido: namespace incorreto');
  }
  if (typeof decoded.id !== 'number' || (decoded.papel !== 'ALUNO' && decoded.papel !== 'PROFESSOR')) {
    throw new Error('Token de sessão inválido: payload malformado');
  }
  return {
    id: decoded.id,
    github_id: decoded.github_id,
    github_login: decoded.github_login,
    papel: decoded.papel,
    typ: TOKEN_TYPE_SESSAO,
  };
}

export interface PreAuthPayload {
  usuario_id: number;
  etapa: 'redefinir_senha' | 'vincular_github';
}

/**
 * Token de pré-ativação: namespace de JWT separado da sessão normal. Nunca é
 * aceito por requireAuth/requireProfessor — só serve para as duas etapas de
 * ativação (trocar senha, vincular GitHub), com vida curta.
 */
export function signPreAuthToken(payload: PreAuthPayload): string {
  return jwt.sign(
    { ...payload, typ: TOKEN_TYPE_PREAUTH },
    config.JWT_SECRET,
    { expiresIn: '15m' },
  );
}

export function verifyPreAuthToken(token: string): PreAuthPayload {
  const decoded = jwt.verify(token, config.JWT_SECRET) as any;
  // Simétrico ao verifyToken: um token de sessão não vale como pré-ativação.
  if (decoded?.typ !== TOKEN_TYPE_PREAUTH) {
    throw new Error('Token de pré-ativação inválido: namespace incorreto');
  }
  if (
    typeof decoded.usuario_id !== 'number' ||
    (decoded.etapa !== 'redefinir_senha' && decoded.etapa !== 'vincular_github')
  ) {
    throw new Error('Token de pré-ativação inválido');
  }
  return { usuario_id: decoded.usuario_id, etapa: decoded.etapa };
}

declare module 'fastify' {
  interface FastifyRequest {
    preAuth?: PreAuthPayload;
  }
}

/**
 * Middleware: exige um token de pré-ativação na etapa esperada. Rejeita se a
 * etapa não bater — impede pular a troca de senha indo direto pro vínculo.
 */
export function requirePreAuth(etapaEsperada: PreAuthPayload['etapa']) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token) {
      reply.status(401).send({ error: 'Token de pré-ativação ausente' });
      return;
    }
    try {
      const payload = verifyPreAuthToken(token);
      if (payload.etapa !== etapaEsperada) {
        reply.status(400).send({ error: `Etapa incorreta: esperado '${etapaEsperada}'` });
        return;
      }
      request.preAuth = payload;
    } catch {
      reply.status(401).send({ error: 'Token de pré-ativação inválido ou expirado' });
    }
  };
}

/**
 * Middleware: Requires the user to be authenticated.
 * Extracts token from httpOnly cookie or Authorization header.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    let token = request.cookies.token;
    
    // Fallback to Authorization Header
    if (!token && request.headers.authorization) {
      const parts = request.headers.authorization.split(' ');
      if (parts[0] === 'Bearer') {
        token = parts[1];
      }
    }
    
    if (!token) {
      reply.status(401).send({ error: 'Authentication required' });
      return;
    }
    
    const decoded = verifyToken(token);
    request.user = decoded;
  } catch (error) {
    reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

/**
 * Middleware: Requires the user to have the PROFESSOR role.
 */
export async function requireProfessor(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  if (reply.sent) return;

  if (request.user?.papel !== 'PROFESSOR') {
    reply.status(403).send({ error: 'Forbidden: Requires professor role' });
  }
}
