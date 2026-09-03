/**
 * Shell-completion generation for the `ydb-orm` binary.
 * Scripts are assembled from strings, without external dependencies.
 */

/** CLI command with a description (used in completion scripts). */
interface CliCommand {
  name: string;
  description: string;
}

/** All CLI commands participating in completion. */
export const CLI_COMMANDS: CliCommand[] = [
  { name: 'migration:create', description: 'Create an empty migration' },
  {
    name: 'migration:generate',
    description: 'Generate migration from entity/DB diff',
  },
  { name: 'migration:run', description: 'Apply all pending migrations' },
  { name: 'migration:revert', description: 'Revert the last migration' },
  { name: 'migration:show', description: 'Show migration status' },
  { name: 'migration:status', description: 'Alias of migration:show' },
  {
    name: 'migration:check',
    description: 'CI readiness check (non-zero exit if not ready)',
  },
  {
    name: 'migration:repair',
    description:
      'Resolve an interrupted migration (--as-applied/--as-reverted)',
  },
  { name: 'schema:verify', description: 'Verify DB schema against entities' },
  {
    name: 'metadata:dump',
    description: 'Dump entity metadata as deterministic JSON (no DB)',
  },
  {
    name: 'entity:diagram',
    description: 'Render Mermaid ER diagram from entity metadata (no DB)',
  },
  { name: 'entity:create', description: 'Create an entity' },
  { name: 'completion', description: 'Print shell completion script' },
];

/** Flags the CLI parses (see parseArgs in args.ts). */
export const CLI_FLAGS = [
  '--config',
  '--dir',
  '--output',
  '--json',
  '--as-applied',
  '--as-reverted',
  '--verbose',
];

/** Supported shells. */
export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** Narrowing guard: whether the string names a supported completion shell. */
export function isCompletionShell(shell: string): shell is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(shell);
}

function commandNames(): string {
  return CLI_COMMANDS.map((c) => c.name).join(' ');
}

/** Bash completion script. */
function renderBash(): string {
  return `# bash completion for ydb-orm
_ydb_orm() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commandNames()}" -- "\${cur}") )
    return 0
  fi

  case "\${prev}" in
    --config|--dir)
      COMPREPLY=( $(compgen -f -- "\${cur}") )
      return 0
      ;;
    completion)
      COMPREPLY=( $(compgen -W "${COMPLETION_SHELLS.join(' ')}" -- "\${cur}") )
      return 0
      ;;
  esac

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "${CLI_FLAGS.join(' ')}" -- "\${cur}") )
  fi
  return 0
}
complete -F _ydb_orm ydb-orm
`;
}

/** Zsh completion script. */
function renderZsh(): string {
  const commands = CLI_COMMANDS.map(
    (c) => `    '${c.name}:${c.description}'`,
  ).join('\n');
  return `#compdef ydb-orm
# zsh completion for ydb-orm

_ydb_orm() {
  local -a commands
  commands=(
${commands}
  )

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe 'ydb-orm command' commands
      ;;
    args)
      case $line[1] in
        completion)
          _values 'shell' ${COMPLETION_SHELLS.join(' ')}
          ;;
        *)
          _arguments \\
            '--config[Path to CLI config]:file:_files' \\
            '--dir[Migrations/entities directory]:directory:_files -/' \\
            '--output[Output file for entity:diagram]:file:_files' \\
            '--json[JSON output]' \\
            '--as-applied[Repair: mark migration as applied]' \\
            '--as-reverted[Repair: remove bookkeeping record]' \\
            '--verbose[Full error stack and cause chain]'
          ;;
      esac
      ;;
  esac
}

_ydb_orm "$@"
`;
}

/** Fish completion script. */
function renderFish(): string {
  const lines: string[] = ['# fish completion for ydb-orm', ''];
  lines.push(
    'function __fish_ydb_orm_needs_command',
    '  set -l cmd (commandline -opc)',
    '  if test (count $cmd) -eq 1',
    '    return 0',
    '  end',
    '  return 1',
    'end',
    '',
  );
  for (const c of CLI_COMMANDS) {
    lines.push(
      `complete -c ydb-orm -n '__fish_ydb_orm_needs_command' -a '${c.name}' -d '${c.description}'`,
    );
  }
  lines.push('');
  lines.push(
    `complete -c ydb-orm -n '__fish_seen_subcommand_from completion' -a '${COMPLETION_SHELLS.join(' ')}'`,
  );
  lines.push('');
  lines.push(
    "complete -c ydb-orm -l config -r -F -d 'Path to CLI config'",
    "complete -c ydb-orm -l dir -r -F -d 'Migrations/entities directory'",
    "complete -c ydb-orm -l output -r -F -d 'Output file for entity:diagram'",
    "complete -c ydb-orm -l json -d 'JSON output'",
    "complete -c ydb-orm -l as-applied -d 'Repair: mark migration as applied'",
    "complete -c ydb-orm -l as-reverted -d 'Repair: remove bookkeeping record'",
    "complete -c ydb-orm -l verbose -d 'Full error stack and cause chain'",
  );
  return lines.join('\n') + '\n';
}

/**
 * Returns the completion script for the given shell.
 * Throws an Error with a clear message for an unknown shell.
 */
export function renderCompletionScript(shell: string): string {
  switch (shell) {
    case 'bash':
      return renderBash();
    case 'zsh':
      return renderZsh();
    case 'fish':
      return renderFish();
    default:
      throw new Error(
        `Unknown shell: ${shell || '(none)'}. ` +
          `Supported shells: ${COMPLETION_SHELLS.join(', ')}`,
      );
  }
}
