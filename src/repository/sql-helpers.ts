/** Escapes LIKE / ILIKE wildcards so user input is matched literally. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');
