export interface SupervisorInstance {
  id: string;
  launchedAt: Date;
}

export interface Decision {
  terminate: string[];
  spawn: boolean;
}

export function decide(
  instances: SupervisorInstance[],
  now: Date,
  ttlMinutes: number,
  hasWork: boolean,
): Decision {
  const cutoff = now.getTime() - ttlMinutes * 60_000;
  return {
    terminate: instances
      .filter((i) => i.launchedAt.getTime() <= cutoff)
      .map((i) => i.id),
    // A just-reaped instance is still shutting down and still holds the board's
    // claims, so any live instance at all suppresses the spawn for this tick.
    spawn: instances.length === 0 && hasWork,
  };
}
