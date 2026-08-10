import { hasRecommendedWork } from "./board";
import { MAX_INSTANCE_AGE_MINUTES } from "./constants";
import { decide } from "./decide";
import { env } from "./env";
import {
  liveSupervisors,
  runSupervisor,
  terminateSupervisors,
} from "./helpers/ec2";

export async function handler(): Promise<void> {
  const instances = await liveSupervisors();
  // The board read is the only slow call, and a live supervisor suppresses the
  // spawn regardless of its answer — so skip it entirely in that case.
  const hasWork =
    instances.length === 0 &&
    (await hasRecommendedWork(env.BOARD_SECRET_ARN, env.AGENTJIRA_PROJECT_ID));

  const { terminate, spawn } = decide(
    instances,
    new Date(),
    MAX_INSTANCE_AGE_MINUTES,
    hasWork,
  );
  if (terminate.length > 0) await terminateSupervisors(terminate);
  if (spawn) await runSupervisor();
}
