import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

export interface UserPayload {
  id: number;
  github_id: string; // Serialized BigInt as string
  github_login: string;
  papel: 'ALUNO' | 'PROFESSOR';
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
export function signToken(payload: { id: number; github_id: bigint | string; github_login: string; papel: 'ALUNO' | 'PROFESSOR' }): string {
  const tokenPayload: UserPayload = {
    id: payload.id,
    github_id: payload.github_id.toString(),
    github_login: payload.github_login,
    papel: payload.papel,
  };
  return jwt.sign(tokenPayload, config.JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Verifies a JWT token.
 */
export function verifyToken(token: string): UserPayload {
  return jwt.verify(token, config.JWT_SECRET) as UserPayload;
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
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: '15m' });
}

export function verifyPreAuthToken(token: string): PreAuthPayload {
  const decoded = jwt.verify(token, config.JWT_SECRET) as any;
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
