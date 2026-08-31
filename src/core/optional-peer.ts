/**
 * Loads an optional peer dependency via dynamic import.
 *
 * The package name is passed as a string argument (not a literal in import())
 * so the build doesn't require the package to be installed.
 *
 * @param name package name (e.g., 'class-validator')
 * @param hint where the package is needed (e.g., 'ClassValidatorProvider')
 */
export async function loadOptionalPeer<T = unknown>(
  name: string,
  hint: string,
): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch {
    throw new Error(
      `${name} must be installed to use ${hint}: npm install ${name}`,
    );
  }
}
