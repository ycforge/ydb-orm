import { describe, expect, it } from '@jest/globals';
import {
  CLI_COMMANDS,
  CLI_FLAGS,
  COMPLETION_SHELLS,
  renderCompletionScript,
} from '../../src/cli/completion.js';

describe('completion command', () => {
  it('renders a script for every supported shell', () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletionScript(shell);
      expect(typeof script).toBe('string');
      expect(script.length).toBeGreaterThan(0);
    }
  });

  it.each([...COMPLETION_SHELLS])(
    '%s script contains all commands and flags',
    (shell) => {
      const script = renderCompletionScript(shell);
      for (const command of CLI_COMMANDS) {
        expect(script).toContain(command.name);
      }
      for (const flag of CLI_FLAGS) {
        // fish использует формат `-l config`, bash/zsh — полное имя флага
        const longName = flag.replace(/^--/, '');
        expect(script.includes(flag) || script.includes(`-l ${longName}`)).toBe(
          true,
        );
      }
    },
  );

  it('fish script lists shells for the completion command', () => {
    const script = renderCompletionScript('fish');
    expect(script).toContain("'bash zsh fish'");
  });

  it('throws a clear error for an unknown shell', () => {
    expect(() => renderCompletionScript('powershell')).toThrow(
      /Unknown shell: powershell.*bash, zsh, fish/,
    );
  });

  it('throws a clear error when shell is not given', () => {
    expect(() => renderCompletionScript('')).toThrow(/Unknown shell/);
  });
});
