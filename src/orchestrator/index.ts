import { Dashboard } from './dashboard.js';
import { ProcessManager } from './process-manager.js';
import { listProfiles, loadProfile } from '../personality/store.js';
import { createPersonality } from '../personality/creator.js';
import type { AgentMessage } from '../types.js';

// Track nickname → profileId for display
const nicknames = new Map<string, string>();

function handleMessage(profileId: string, msg: AgentMessage, dashboard: Dashboard) {
  const formatted = dashboard.formatMessage(msg);
  dashboard.appendToPane(profileId, formatted);

  // Update pane label with latest status
  if (msg.type === 'status') {
    nicknames.set(profileId, msg.nickname);
    const statusIcon =
      msg.status === 'my_turn' ? '🎯' :
      msg.status === 'playing' ? '🃏' :
      msg.status === 'waiting' ? '⏳' :
      msg.status === 'exiting' ? '👋' : '•';
    dashboard.updatePaneLabel(profileId, `${msg.nickname} ${statusIcon} ${msg.chips} chips | ${msg.handsPlayed} hands`);
  }
}

function handleExit(profileId: string, code: number | null, dashboard: Dashboard) {
  const nick = nicknames.get(profileId) || profileId;
  dashboard.appendToPane(profileId, `{red-fg}--- Process exited (code ${code}) ---{/red-fg}`);
  dashboard.logCommand(`{red-fg}${nick}{/red-fg} exited (code ${code}). Use {green-fg}add ${profileId}{/green-fg} to relaunch.`);
}

async function handleCommand(
  input: string,
  pm: ProcessManager,
  dashboard: Dashboard,
): Promise<void> {
  const parts = input.split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
    case 'add': {
      // Parse --poll flag from anywhere in the args
      const pollIdx = parts.indexOf('--poll');
      let pollMs: number | undefined;
      if (pollIdx !== -1 && parts[pollIdx + 1]) {
        pollMs = parseInt(parts[pollIdx + 1], 10);
        parts.splice(pollIdx, 2);
      }

      const arg = parts[1];
      const roomId = parts[2] || 'casino_low_1';
      const buyIn = parseInt(parts[3] || '20000', 10);

      if (!arg) {
        dashboard.logCommand('{red-fg}Usage: add <profile_id|number> [room_id] [buy_in] [--poll ms]{/red-fg}');
        dashboard.logCommand('{gray-fg}  add ice_queen                    — launch one agent{/gray-fg}');
        dashboard.logCommand('{gray-fg}  add 5 casino_low_1 20000         — launch 5 random agents{/gray-fg}');
        dashboard.logCommand('{gray-fg}  add 3 casino_low_1 20000 --poll 500  — launch 3 with 500ms polling{/gray-fg}');
        return;
      }

      // If arg is a number, launch that many random agents
      const count = parseInt(arg, 10);
      if (!isNaN(count) && String(count) === arg) {
        const allProfiles = await listProfiles();
        const available = allProfiles.filter(p => !pm.isRunning(p));

        if (available.length === 0) {
          dashboard.logCommand('{red-fg}No available profiles (all running or none exist){/red-fg}');
          return;
        }

        const toAdd = Math.min(count, available.length);
        if (toAdd < count) {
          dashboard.logCommand(`{yellow-fg}Only ${available.length} profiles available, launching ${toAdd}{/yellow-fg}`);
        }

        // Fisher-Yates shuffle and pick
        for (let i = available.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [available[i], available[j]] = [available[j], available[i]];
        }
        const shuffled = available.slice(0, toAdd);
        dashboard.logCommand(`Launching {green-fg}${toAdd}{/green-fg} agents at ${roomId}...`);

        for (const id of shuffled) {
          try {
            const profile = await loadProfile(id);
            dashboard.addPane(id, profile.nickname);
            pm.launch(id, roomId, buyIn, pollMs);
            dashboard.logCommand(`  + {green-fg}${profile.nickname}{/green-fg} (${id})`);
            // Stagger to avoid API rate limits
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (err) {
            dashboard.logCommand(`  {red-fg}Failed: ${id} — ${(err as Error).message}{/red-fg}`);
          }
        }
        return;
      }

      // Otherwise treat as profile ID
      const profileId = arg;
      if (pm.isRunning(profileId)) {
        dashboard.logCommand(`{yellow-fg}${profileId} is already running{/yellow-fg}`);
        return;
      }

      try {
        const profile = await loadProfile(profileId);
        dashboard.addPane(profileId, profile.nickname);
        dashboard.logCommand(`Launching {green-fg}${profile.nickname}{/green-fg} at ${roomId} (buy-in: ${buyIn})...`);
        pm.launch(profileId, roomId, buyIn, pollMs);
      } catch (err) {
        dashboard.logCommand(`{red-fg}Failed to load profile "${profileId}": ${(err as Error).message}{/red-fg}`);
        dashboard.logCommand(`Available profiles: ${(await listProfiles()).join(', ') || '(none)'}`);
      }
      return;
    }

    case 'kill':
    case 'stop': {
      const profileId = parts[1];
      if (!profileId) {
        dashboard.logCommand('{red-fg}Usage: kill <profile_id>{/red-fg}');
        return;
      }
      if (pm.kill(profileId)) {
        const nick = nicknames.get(profileId) || profileId;
        dashboard.logCommand(`Stopping {yellow-fg}${nick}{/yellow-fg}...`);
      } else {
        dashboard.logCommand(`{red-fg}${profileId} is not running{/red-fg}`);
      }
      return;
    }

    case 'list':
    case 'ls': {
      const running = pm.getRunning();
      if (running.size === 0) {
        dashboard.logCommand('No agents running');
      } else {
        dashboard.logCommand(`{bold}Running agents:{/bold}`);
        for (const [id, agent] of running) {
          const nick = nicknames.get(id) || id;
          dashboard.logCommand(`  ${nick} (${id}) — room: ${agent.roomId}, pid: ${agent.pid}`);
        }
      }

      const profiles = await listProfiles();
      const notRunning = profiles.filter(p => !running.has(p));
      if (notRunning.length > 0) {
        dashboard.logCommand(`{gray-fg}Available profiles: ${notRunning.join(', ')}{/gray-fg}`);
      }
      return;
    }

    case 'create': {
      dashboard.logCommand('Starting personality creator... (interactive — check your terminal)');
      dashboard.destroy();

      try {
        const { agentId, profile } = await createPersonality();
        dashboard.logCommand(`Created {green-fg}${profile.nickname}{/green-fg} (${agentId})`);
        dashboard.logCommand(`Launch with: {green-fg}add ${agentId}{/green-fg}`);
      } catch (err) {
        dashboard.logCommand(`{red-fg}Creation failed: ${(err as Error).message}{/red-fg}`);
      }

      // Restart the dashboard
      dashboard.start();
      return;
    }

    case 'profiles': {
      const profiles = await listProfiles();
      if (profiles.length === 0) {
        dashboard.logCommand('No profiles found. Use {yellow-fg}create{/yellow-fg} to make one.');
      } else {
        dashboard.logCommand(`{bold}Profiles:{/bold}`);
        for (const id of profiles) {
          try {
            const p = await loadProfile(id);
            dashboard.logCommand(`  ${id}: ${p.nickname} the ${p.archetype} — ${p.generated.one_liner}`);
          } catch {
            dashboard.logCommand(`  ${id}: (unreadable)`);
          }
        }
      }
      return;
    }

    case 'addall':
    case 'add-all': {
      const roomId = parts[1] || 'casino_low_1';
      const buyIn = parseInt(parts[2] || '20000', 10);
      const profiles = await listProfiles();
      const toAdd = profiles.filter(p => !pm.isRunning(p));

      if (toAdd.length === 0) {
        dashboard.logCommand('All profiles are already running (or no profiles exist)');
        return;
      }

      dashboard.logCommand(`Launching {green-fg}${toAdd.length}{/green-fg} agents at ${roomId}...`);
      for (const id of toAdd) {
        try {
          const profile = await loadProfile(id);
          dashboard.addPane(id, profile.nickname);
          pm.launch(id, roomId, buyIn);
          // Stagger launches by 500ms to avoid API rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (err) {
          dashboard.logCommand(`{red-fg}Failed to launch ${id}: ${(err as Error).message}{/red-fg}`);
        }
      }
      return;
    }

    case 'killall':
    case 'kill-all': {
      const running = pm.getRunning();
      if (running.size === 0) {
        dashboard.logCommand('No agents running');
        return;
      }
      dashboard.logCommand(`Stopping {red-fg}${running.size}{/red-fg} agents...`);
      pm.killAll();
      return;
    }

    case 'quit':
    case 'exit':
    case 'q': {
      dashboard.logCommand('Shutting down all agents...');
      pm.killAll();
      // Wait a moment for graceful shutdown
      setTimeout(() => {
        dashboard.destroy();
        process.exit(0);
      }, 2000);
      return;
    }

    case 'help':
    case '?': {
      dashboard.logCommand('{bold}Commands:{/bold}');
      dashboard.logCommand('  {green-fg}add{/green-fg} <profile> [room] [buy-in]  — Launch one agent');
      dashboard.logCommand('  {green-fg}add{/green-fg} <N> [room] [buy-in]       — Launch N random agents');
      dashboard.logCommand('  {green-fg}add-all{/green-fg} [room] [buy-in]        — Launch all profiles');
      dashboard.logCommand('  {red-fg}kill{/red-fg} <profile>                  — Stop an agent');
      dashboard.logCommand('  {red-fg}kill-all{/red-fg}                        — Stop all agents');
      dashboard.logCommand('  {yellow-fg}create{/yellow-fg}                         — Create a new personality');
      dashboard.logCommand('  {cyan-fg}list{/cyan-fg}                           — Show running agents + profiles');
      dashboard.logCommand('  {cyan-fg}profiles{/cyan-fg}                       — Show all profiles');
      dashboard.logCommand('  {magenta-fg}quit{/magenta-fg}                           — Shut down everything');
      return;
    }

    default:
      dashboard.logCommand(`{red-fg}Unknown command: ${cmd}. Type {bold}help{/bold} for commands.{/red-fg}`);
  }
}

async function main() {
  let dashboard: Dashboard;
  let pm: ProcessManager;

  pm = new ProcessManager(
    (profileId, msg) => handleMessage(profileId, msg, dashboard),
    (profileId, code) => handleExit(profileId, code, dashboard),
  );

  dashboard = new Dashboard((input) => {
    handleCommand(input, pm, dashboard).catch((err) => {
      dashboard.logCommand(`{red-fg}Error: ${(err as Error).message}{/red-fg}`);
    });
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    pm.killAll();
    setTimeout(() => {
      dashboard.destroy();
      process.exit(0);
    }, 2000);
  });

  dashboard.start();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
