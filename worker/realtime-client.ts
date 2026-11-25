function room(env: Env) {
  return env.REALTIME.get(env.REALTIME.idFromName('site'));
}

export function connectRealtime(req: Request, env: Env) {
  return room(env).fetch(req);
}

export async function publish(env: Env, event: { Type: 1 | 2; Data: number }) {
  const result = await room(env).fetch('https://room.internal/events', { method: 'POST', body: JSON.stringify(event) });
  if (!result.ok) throw new Error('Realtime notification failed: ' + result.status);
}
