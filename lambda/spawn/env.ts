import { z } from "zod";

const EnvSchema = z.object({
  AGENTJIRA_PROJECT_ID: z.uuid(),
  BOARD_SECRET_ARN: z.string().min(1),
  LAUNCH_TEMPLATE_ID: z.string().min(1),
  SUBNET_ID: z.string().min(1),
  MAX_INSTANCE_AGE_MINUTES: z.coerce.number().int().positive().default(720),
});

export const env = EnvSchema.parse(process.env);
