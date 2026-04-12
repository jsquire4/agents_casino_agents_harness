import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersonalityProfile } from '../types.js';

const PROFILES_DIR = join(process.cwd(), 'profiles');

export async function ensureProfilesDir(): Promise<void> {
  await mkdir(PROFILES_DIR, { recursive: true });
}

export async function saveProfile(agentId: string, profile: PersonalityProfile): Promise<void> {
  await ensureProfilesDir();
  const path = join(PROFILES_DIR, `${agentId}.json`);
  await writeFile(path, JSON.stringify(profile, null, 2));
}

export async function loadProfile(agentId: string): Promise<PersonalityProfile> {
  const path = join(PROFILES_DIR, `${agentId}.json`);
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as PersonalityProfile;
}

export async function listProfiles(): Promise<string[]> {
  await ensureProfilesDir();
  const files = await readdir(PROFILES_DIR);
  return files
    .filter(f => f.endsWith('.json') && !f.endsWith('.creds.json'))
    .map(f => f.replace('.json', ''));
}

// Credential storage (agentId + secretKey)

export interface AgentCredentials {
  agentId: string;
  secretKey: string;
}

export async function saveCredentials(agentId: string, creds: AgentCredentials): Promise<void> {
  await ensureProfilesDir();
  const path = join(PROFILES_DIR, `${agentId}.creds.json`);
  await writeFile(path, JSON.stringify(creds, null, 2));
}

export async function loadCredentials(agentId: string): Promise<AgentCredentials | null> {
  try {
    const path = join(PROFILES_DIR, `${agentId}.creds.json`);
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as AgentCredentials;
  } catch {
    return null;
  }
}
