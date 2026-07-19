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
