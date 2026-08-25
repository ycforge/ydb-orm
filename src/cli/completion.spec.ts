import {
  CLI_COMMANDS,
  CLI_FLAGS,
  COMPLETION_SHELLS,
  isCompletionShell,
  renderCompletionScript,
} from './completion.js';

/**
 * Спеки генерации shell-автодополнения (#109): раньше completion.ts не имел
 * собственных тестов — регрессия (потеря команды/шелла, битый скрипт) была бы
 * замечена только пользователем в терминале.
 */

describe('renderCompletionScript', () => {
  it.each([...COMPLETION_SHELLS])('генерирует скрипт для %s', (shell) => {
    const script = renderCompletionScript(shell);

    expect(script.length).toBeGreaterThan(0);
    // Все команды CLI присутствуют в скрипте
    for (const command of CLI_COMMANDS) {
      expect(script).toContain(command.name);
    }
    // Поддерживаемые шеллы перечислены (аргументы completion)
    expect(script).toContain(COMPLETION_SHELLS.join(' '));
  });

  it('bash-скрипт использует compgen и complete -F', () => {
    const script = renderCompletionScript('bash');
    expect(script).toContain('_yorm()');
    expect(script).toContain('compgen -W');
    expect(script).toContain('complete -F _yorm yorm');
  });

  it('zsh-скрипт объявляет команды с описаниями', () => {
    const script = renderCompletionScript('zsh');
    expect(script).toContain('#compdef yorm');
    for (const command of CLI_COMMANDS) {
      expect(script).toContain(`'${command.name}:${command.description}'`);
    }
  });

  it('fish-скрипт регистрирует complete -c yorm на каждую команду', () => {
    const script = renderCompletionScript('fish');
    expect(script.match(/complete -c yorm/g)?.length).toBeGreaterThanOrEqual(
      CLI_COMMANDS.length + 1,
    );
    // Флаги со значениями помечены как требующие файл (-r -F)
    expect(script).toContain('-l config -r -F');
    expect(script).toContain('-l dir -r -F');
  });

  it('неизвестный шелл даёт понятную ошибку с перечнем поддерживаемых', () => {
    expect(() => renderCompletionScript('powershell')).toThrow(
      /Unknown shell: powershell\. Supported shells: bash, zsh, fish/,
    );
    expect(() => renderCompletionScript('')).toThrow(/Unknown shell: \(none\)/);
  });
});

describe('isCompletionShell / константы согласованы', () => {
  it('распознаёт поддерживаемые шеллы и отклоняет остальные', () => {
    for (const shell of COMPLETION_SHELLS) {
      expect(isCompletionShell(shell)).toBe(true);
    }
    expect(isCompletionShell('pwsh')).toBe(false);
  });

  it('все флаги из CLI_FLAGS упомянуты в каждом скрипте', () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletionScript(shell);
      for (const flag of CLI_FLAGS) {
        // fish использует длинную форму без дефисов: -l/--config → config
        if (shell === 'fish') {
          expect(script).toContain(flag.replace(/^--/, ''));
        } else {
          expect(script).toContain(flag);
        }
      }
    }
  });

  it('имена команд уникальны', () => {
    const names = CLI_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
