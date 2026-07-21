import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config();

// Helper to parse comma-separated values into a lowercase array
function parseCsv(val?: string): string[] {
  if (!val) return [];
  return val.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

export const config = {
  // App Config
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  APP_BASE_URL: process.env.APP_BASE_URL || 'http://localhost:3000',
  JWT_SECRET: process.env.JWT_SECRET || 'mock_super_secret_jwt_key',
  
  // Database & Redis
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/crivo?schema=public',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  
  // Predefined Professors (comma-separated logins, stored in lowercase)
  PROFESSOR_LOGINS: parseCsv(process.env.PROFESSOR_LOGINS),

  // GitHub App Credentials
  GITHUB_APP_ID: process.env.GITHUB_APP_ID || '123456',
  // Format private key correctly to replace double-quoted newlines if they are passed as raw \n
  GITHUB_PRIVATE_KEY: (process.env.GITHUB_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || 'mock_webhook_secret',
  GITHUB_ORG: process.env.GITHUB_ORG || 'faminas-ads',
  
  // GitHub App OAuth
  GITHUB_OAUTH_CLIENT_ID: process.env.GITHUB_OAUTH_CLIENT_ID || 'mock_client_id',
  GITHUB_OAUTH_CLIENT_SECRET: process.env.GITHUB_OAUTH_CLIENT_SECRET || 'mock_client_secret',

  // Congelador (repeatable job registrado no processo do worker)
  congelador: {
    intervalMs: process.env.CONGELADOR_INTERVAL_MS
      ? parseInt(process.env.CONGELADOR_INTERVAL_MS, 10)
      : 60_000,
  },

  // Sequência pós-criação de repositório (colaboradores + branch protection)
  repoSetup: {
    attempts: 5,
    backoffMs: 10_000,
    // Polling pela branch main dentro de cada tentativa
    pollAttempts: 10,
    pollIntervalMs: 2000,
  },

  // Detector Thresholds
  detectors: {
    divergenciaEquipe: {
      thresholdPushPercent: 0.70, // 70%
      minCommits: 10,
      minAuthors: 3,
    },
    semAtividade: {
      defaultDays: 5,
    },
    commitGigante: {
      linePercent: 0.50, // 50%
      hoursBeforeDeadline: 24,
    }
  }
};
