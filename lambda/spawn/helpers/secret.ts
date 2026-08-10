import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";

// Same keys as the `aj` CLI's config.json.
const BoardSecretSchema = z.object({
  url: z.url(),
  anon_key: z.string().min(1),
  email: z.email(),
  password: z.string().min(1),
});

export type BoardCredentials = z.infer<typeof BoardSecretSchema>;

export async function loadBoardCredentials(
  secretArn: string,
): Promise<BoardCredentials> {
  const secrets = new SecretsManagerClient({});
  const { SecretString } = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!SecretString) throw new Error("board secret has no SecretString");
  return BoardSecretSchema.parse(JSON.parse(SecretString));
}
