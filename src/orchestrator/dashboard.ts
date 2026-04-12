import blessed from 'blessed';
import type { AgentMessage, AgentTurnMessage } from '../types.js';

export type CommandHandler = (input: string) => void;

interface AgentPane {
  box: blessed.Widgets.BoxElement;
  log: blessed.Widgets.Log;
}

export class Dashboard {
  private screen: blessed.Widgets.Screen;
  private paneContainer: blessed.Widgets.BoxElement;
  private commandBar: blessed.Widgets.BoxElement;
  private commandInput: blessed.Widgets.TextboxElement;
  private commandOutput: blessed.Widgets.Log;
  private panes = new Map<string, AgentPane>();
  private onCommand: CommandHandler;

  constructor(onCommand: CommandHandler) {
    this.onCommand = onCommand;

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Agent Casino — Orchestrator',
    });

    // Main pane container (top ~80%)
    this.paneContainer = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '80%',
    });

    // Command area (bottom ~20%)
    this.commandBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: '20%',
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      label: ' Orchestrator ',
    });

    // Help line — always visible at top of command bar
    blessed.text({
      parent: this.commandBar,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: { fg: 'gray' },
      content: ' {green-fg}add{/green-fg} <id|N> [room] [buy-in] | {red-fg}kill{/red-fg} <id> | {red-fg}kill-all{/red-fg} | {yellow-fg}create{/yellow-fg} | {cyan-fg}list{/cyan-fg} | {cyan-fg}profiles{/cyan-fg} | {magenta-fg}quit{/magenta-fg} | {bold}Tab{/bold}=focus',
    });

    // Command output log
    this.commandOutput = blessed.log({
      parent: this.commandBar,
      top: 1,
      left: 0,
      width: '100%',
      height: '100%-4',
      scrollable: true,
      alwaysScroll: true,
      tags: true,
      style: { fg: 'white' },
    });

    // Prompt indicator
    blessed.text({
      parent: this.commandBar,
      bottom: 0,
      left: 0,
      width: 2,
      height: 1,
      style: { fg: 'cyan', bg: 'black' },
      content: '> ',
    });

    // Command input (offset past the prompt indicator)
    this.commandInput = blessed.textbox({
      parent: this.commandBar,
      bottom: 0,
      left: 2,
      width: '100%-4',
      height: 1,
      style: {
        fg: 'white',
        bg: 'black',
      },
      inputOnFocus: true,
    });

    // Handle command submission
    this.commandInput.on('submit', (value: string) => {
      this.commandInput.clearValue();
      this.commandInput.focus();
      this.screen.render();
      if (value.trim()) {
        this.commandOutput.log(`{cyan-fg}>{/cyan-fg} ${value}`);
        this.onCommand(value.trim());
      }
    });

    // Global keys
    this.screen.key(['escape', 'C-c'], () => {
      this.onCommand('quit');
    });

    // Tab to focus command input
    this.screen.key(['tab'], () => {
      this.commandInput.focus();
      this.screen.render();
    });

    // Start with input focused
    this.commandInput.focus();
  }

  start(): void {
    this.screen.render();
    this.logCommand('Agent Casino Orchestrator started');
    this.logCommand('Commands: {green-fg}add{/green-fg} <profile|N> [room] [buy-in] | {red-fg}kill{/red-fg} <profile> | {yellow-fg}create{/yellow-fg} | {cyan-fg}list{/cyan-fg} | {magenta-fg}quit{/magenta-fg}');
    this.logCommand('Press {bold}Tab{/bold} to focus command input');
  }

  destroy(): void {
    this.screen.destroy();
  }

  logCommand(text: string): void {
    this.commandOutput.log(text);
    this.screen.render();
  }

  // ── Agent pane management ────────────────────────────────────────────────

  addPane(profileId: string, nickname: string): void {
    const box = blessed.box({
      parent: this.paneContainer,
      border: { type: 'line' },
      label: ` ${nickname} (${profileId}) `,
      style: {
        border: { fg: 'green' },
        label: { fg: 'green', bold: true },
      },
    });

    const log = blessed.log({
      parent: box,
      top: 0,
      left: 0,
      width: '100%-2',
      height: '100%-2',
      scrollable: true,
      alwaysScroll: true,
      tags: true,
      mouse: true,
      style: { fg: 'white' },
    });

    this.panes.set(profileId, { box, log });
    this.layoutPanes();
  }

  removePane(profileId: string): void {
    const pane = this.panes.get(profileId);
    if (!pane) return;
    pane.box.destroy();
    this.panes.delete(profileId);
    this.layoutPanes();
  }

  appendToPane(profileId: string, text: string): void {
    const pane = this.panes.get(profileId);
    if (!pane) return;
    pane.log.log(text);
    this.screen.render();
  }

  updatePaneLabel(profileId: string, label: string): void {
    const pane = this.panes.get(profileId);
    if (!pane) return;
    pane.box.setLabel(` ${label} `);
    this.screen.render();
  }

  // ── Message formatting ─────────────────────────────────────────────────

  formatMessage(msg: AgentMessage): string {
    switch (msg.type) {
      case 'turn':
        return this.formatTurn(msg);
      case 'chat_received':
        return `{cyan-fg}[chat]{/cyan-fg} ${msg.from}: "${msg.message}"`;
      case 'status':
        return `{blue-fg}[${msg.status}]{/blue-fg} chips: ${msg.chips} | hands: ${msg.handsPlayed}`;
      case 'log':
        return this.formatLog(msg);
      default:
        return JSON.stringify(msg);
    }
  }

  private formatTurn(msg: AgentTurnMessage): string {
    const lines: string[] = [];

    // Move line
    const moveColor = msg.move === 'fold' ? 'red' : msg.move === 'raise' || msg.move === 'all_in' ? 'green' : 'yellow';
    const amountStr = msg.amount ? ` ${msg.amount}` : '';
    lines.push(`{${moveColor}-fg}[${msg.phase}] ${msg.move.toUpperCase()}${amountStr}{/${moveColor}-fg}  cards: ${msg.holeCards}${msg.board ? ' | board: ' + msg.board : ''}`);

    // Stats line
    const equityStr = msg.equity !== null ? `eq: ${(msg.equity * 100).toFixed(0)}%` : 'eq: ?';
    lines.push(`  pot: ${msg.pot} | ${equityStr} | stack: ${msg.chips}`);

    // Reasoning
    lines.push(`  {magenta-fg}think:{/magenta-fg} ${msg.reasoning}`);

    // Chat
    if (msg.chatMessage && msg.chatMessage !== '...') {
      lines.push(`  {cyan-fg}says:{/cyan-fg} "${msg.chatMessage}"`);
    }

    return lines.join('\n');
  }

  private formatLog(msg: { level: string; message: string }): string {
    const color = msg.level === 'error' ? 'red' : msg.level === 'warn' ? 'yellow' : 'gray';
    return `{${color}-fg}${msg.message}{/${color}-fg}`;
  }

  // ── Layout engine ──────────────────────────────────────────────────────

  private layoutPanes(): void {
    const ids = [...this.panes.keys()];
    const count = ids.length;
    if (count === 0) {
      this.screen.render();
      return;
    }

    // Calculate grid: cols x rows
    const cols = count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
    const rows = Math.ceil(count / cols);

    const colWidth = Math.floor(100 / cols);
    const rowHeight = Math.floor(100 / rows);

    ids.forEach((id, i) => {
      const pane = this.panes.get(id)!;
      const col = i % cols;
      const row = Math.floor(i / cols);

      pane.box.left = `${col * colWidth}%`;
      pane.box.top = `${row * rowHeight}%`;
      pane.box.width = col === cols - 1 ? `${100 - col * colWidth}%` : `${colWidth}%`;
      pane.box.height = row === rows - 1 ? `${100 - row * rowHeight}%` : `${rowHeight}%`;
    });

    this.screen.render();
  }
}
