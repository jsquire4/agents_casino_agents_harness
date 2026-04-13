import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentMessage } from '../types.js';

export interface AgentProcess {
  profileId: string;
  roomId: string;
  buyIn: number;
  process: ChildProcess;
  pid: number;
}

type MessageHandler = (profileId: string, msg: AgentMessage) => void;
type ExitHandler = (profileId: string, code: number | null) => void;

export class ProcessManager {
  private agents = new Map<string, AgentProcess>();
  private onMessage: MessageHandler;
  private onExit: ExitHandler;

  constructor(onMessage: MessageHandler, onExit: ExitHandler) {
    this.onMessage = onMessage;
    this.onExit = onExit;
  }

  launch(profileId: string, roomId: string, buyIn: number, pollMs?: number, warrantRetries?: number): void {
    if (this.agents.has(profileId)) {
      throw new Error(`Agent ${profileId} is already running`);
    }

    const args = ['tsx', 'src/agent.ts', '--profile', profileId, '--room', roomId, '--buy-in', String(buyIn)];
    if (pollMs) args.push('--poll', String(pollMs));
    if (warrantRetries !== undefined) args.push('--warrant-retries', String(warrantRetries));

    const child = spawn('npx', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const agent: AgentProcess = {
      profileId,
      roomId,
      buyIn,
      process: child,
      pid: child.pid!,
    };
    this.agents.set(profileId, agent);

    // Parse JSON lines from stdout
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as AgentMessage;
        this.onMessage(profileId, msg);
      } catch {
        // Non-JSON output — emit as log
        this.onMessage(profileId, {
          type: 'log',
          agentId: profileId,
          level: 'info',
          message: line,
          timestamp: Date.now(),
        });
      }
    });

    // Capture stderr
    const errRl = createInterface({ input: child.stderr! });
    errRl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as AgentMessage;
        this.onMessage(profileId, msg);
      } catch {
        this.onMessage(profileId, {
          type: 'log',
          agentId: profileId,
          level: 'error',
          message: line,
          timestamp: Date.now(),
        });
      }
    });

    child.on('exit', (code) => {
      this.agents.delete(profileId);
      this.onExit(profileId, code);
    });
  }

  kill(profileId: string): boolean {
    const agent = this.agents.get(profileId);
    if (!agent) return false;
    agent.process.kill('SIGTERM');
    return true;
  }

  killAll(): void {
    for (const [id] of this.agents) {
      this.kill(id);
    }
  }

  getRunning(): Map<string, AgentProcess> {
    return this.agents;
  }

  isRunning(profileId: string): boolean {
    return this.agents.has(profileId);
  }
}
