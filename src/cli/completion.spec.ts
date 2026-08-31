import {
  CLI_COMMANDS,
  CLI_FLAGS,
  COMPLETION_SHELLS,
  isCompletionShell,
  renderCompletionScript,
} from './completion.js';

/**
 * Specs for shell-completion generation (#109): completion.ts used to have
 * no tests of its own — a regression (a lost command/shell, a broken script)
 * would only be noticed by a user in the terminal.
 */

describe('renderCompletionScript', () => {
  it.each([...COMPLETION_SHELLS])('generates script for %s', (shell) => {
    const script = renderCompletionScript(shell);

    expect(script.length).toBeGreaterThan(0);
    // Every CLI command is present in the script
    for (const command of CLI_COMMANDS) {
      expect(script).toContain(command.name);
    }
    // Supported shells are listed (completion arguments)
    expect(script).toContain(COMPLETION_SHELLS.join(' '));
  });

  it('bash script uses compgen and complete -F', () => {
    const script = renderCompletionScript('bash');
    expect(script).toContain('_ydb_orm()');
    expect(script).toContain('compgen -W');
    expect(script).toContain('complete -F _ydb_orm ydb-orm');
  });

  it('zsh script declares commands with descriptions', () => {
    const script = renderCompletionScript('zsh');
    expect(script).toContain('#compdef ydb-orm');
    for (const command of CLI_COMMANDS) {
      expect(script).toContain(`'${command.name}:${command.description}'`);
    }
  });

  it('fish script registers complete -c ydb-orm for each command', () => {
    const script = renderCompletionScript('fish');
    expect(script.match(/complete -c ydb-orm/g)?.length).toBeGreaterThanOrEqual(
      CLI_COMMANDS.length + 1,
    );
    // Value flags are marked as requiring a file (-r -F)
    expect(script).toContain('-l config -r -F');
    expect(script).toContain('-l dir -r -F');
  });

  it('unknown shell gives clear error listing supported shells', () => {
    expect(() => renderCompletionScript('powershell')).toThrow(
      /Unknown shell: powershell\. Supported shells: bash, zsh, fish/,
    );
    expect(() => renderCompletionScript('')).toThrow(/Unknown shell: \(none\)/);
  });
});

describe('isCompletionShell / constants aligned', () => {
  it('recognizes supported shells and rejects others', () => {
    for (const shell of COMPLETION_SHELLS) {
      expect(isCompletionShell(shell)).toBe(true);
    }
    expect(isCompletionShell('pwsh')).toBe(false);
  });

  it('all flags from CLI_FLAGS mentioned in each script', () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletionScript(shell);
      for (const flag of CLI_FLAGS) {
        // fish uses the long form without dashes: -l/--config → config
        if (shell === 'fish') {
          expect(script).toContain(flag.replace(/^--/, ''));
        } else {
          expect(script).toContain(flag);
        }
      }
    }
  });

  it('command names are unique', () => {
    const names = CLI_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
