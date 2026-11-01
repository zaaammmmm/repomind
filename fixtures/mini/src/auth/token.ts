export function signToken(payload: { sub: string }): string {
  return JSON.stringify(payload);
}
