import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { enqueueStatsJob, enqueueDetectorJob } from '../jobs/queues.js';

/**
 * Validates GitHub HMAC SHA256 signatures.
 */
function verifySignature(payloadBuffer: Buffer, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader) return false;
  
  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') return false;
  
  const expectedSignature = parts[1];
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payloadBuffer);
  const actualSignature = hmac.digest('hex');
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(actualSignature, 'hex')
    );
  } catch {
    return false;
  }
}

export async function webhookRoutes(fastify: FastifyInstance) {
  
  // Register custom JSON-as-buffer parser for raw body capture on this plugin's routes
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, payload, done) => {
    (request as any).rawBody = payload;
    try {
      const json = JSON.parse(payload.toString('utf-8'));
      done(null, json);
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  fastify.post('/webhooks/github', {
    schema: {
      tags: ['webhooks'],
      summary: 'Recebe eventos de webhook do GitHub (push, ping)',
      description: 'Requer o header `X-Hub-Signature-256` com a assinatura HMAC-SHA256 do payload, validada contra GITHUB_WEBHOOK_SECRET.',
    },
  }, async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'] as string;
    const rawBody = (request as any).rawBody as Buffer;
    
    // Verify HMAC-SHA256 signature
    if (!verifySignature(rawBody, signature, config.GITHUB_WEBHOOK_SECRET)) {
      logger.warn('Received webhook with invalid HMAC signature');
      reply.status(401).send({ error: 'Invalid webhook signature' });
      return;
    }
    
    const event = request.headers['x-github-event'] as string;
    const deliveryId = request.headers['x-github-delivery'] as string;
    
    if (event === 'ping') {
      logger.info('Received ping event from GitHub');
      return reply.send({ ok: true });
    }
    
    if (event === 'push') {
      const payload = request.body as any;
      const githubRepoId = payload.repository?.id;
      
      if (!githubRepoId) {
        reply.status(400).send({ error: 'Missing repository ID in payload' });
        return;
      }
      
      // 1. Fetch Repository from db
      const repo = await prisma.repositorio.findUnique({
        where: { github_repo_id: BigInt(githubRepoId) },
      });
      
      if (!repo) {
        logger.debug({ githubRepoId }, 'Webhook ignored: repository not tracked in Crivo');
        return reply.send({ message: 'Repository not tracked' });
      }
      
      // 2. Check Idempotency: Has this delivery been processed?
      const existingPush = await prisma.push.findUnique({
        where: { github_delivery_id: deliveryId },
      });
      
      if (existingPush) {
        logger.info({ deliveryId }, 'Webhook duplicate: push delivery already processed');
        return reply.send({ message: 'Push already processed' });
      }
      
      // 3. Process push and commits in a single transaction
      try {
        const result = await prisma.$transaction(async (tx) => {
          const createdPush = await tx.push.create({
            data: {
              repositorio_id: repo.id,
              pusher_github_id: BigInt(payload.sender.id),
              pusher_login: payload.sender.login,
              forced: !!payload.forced,
              ref: payload.ref,
              github_delivery_id: deliveryId,
            },
          });
          
          const newCommits = [];
          for (const c of payload.commits || []) {
            // Unique per repo: check if commit already exists
            const exists = await tx.commit.findUnique({
              where: {
                repositorio_id_sha: {
                  repositorio_id: repo.id,
                  sha: c.id,
                },
              },
            });
            
            if (!exists) {
              // Resolve author email to database user if exists
              const emailRecord = await tx.emailCommit.findUnique({
                where: { email: c.author.email.toLowerCase() },
              });
              
              const commit = await tx.commit.create({
                data: {
                  push_id: createdPush.id,
                  repositorio_id: repo.id,
                  sha: c.id,
                  mensagem: c.message,
                  autor_nome: c.author.name,
                  autor_email: c.author.email.toLowerCase(),
                  autor_usuario_id: emailRecord ? emailRecord.usuario_id : null,
                  committed_em: new Date(c.timestamp),
                  stats_status: 'PENDENTE',
                },
              });
              newCommits.push(commit);
            }
          }
          
          return { createdPush, newCommits };
        });
        
        logger.info({ pushId: result.createdPush.id, commitsCount: result.newCommits.length }, 'Webhook push persisted successfully');
        
        // 4. Enqueue background jobs asynchronously
        // stats-commit queue for each commit
        for (const commit of result.newCommits) {
          await enqueueStatsJob(commit.id, repo.nome_completo, commit.sha);
        }
        
        // detector queue for this repository (triggered by push)
        // Note: COMMIT_GIGANTE is only ran inside stats-commit worker when additions/deletions are updated
        await enqueueDetectorJob(repo.id, 'push');
        
        return reply.send({ success: true });
      } catch (error) {
        logger.error({ error, deliveryId }, 'Failed to persist webhook push payload');
        reply.status(500).send({ error: 'Internal database processing failure' });
      }
    } else {
      logger.debug({ event }, 'Ignored unhandled GitHub event');
      return reply.send({ message: 'Event ignored' });
    }
  });
}
export default webhookRoutes;
