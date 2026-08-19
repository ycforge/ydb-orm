/**
 * Загружает опциональную peer-зависимость динамическим импортом.
 *
 * Имя пакета передаётся строковым аргументом (а не литералом в import()),
 * чтобы сборка не требовала установленный пакет.
 *
 * @param name имя пакета (например, 'class-validator')
 * @param hint где пакет нужен (например, 'ClassValidatorProvider')
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
