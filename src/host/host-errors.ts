export const formatHostError = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  return e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message;
};
