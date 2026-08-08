import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type Instance,
} from "@aws-sdk/client-ec2";
import { hasRecommendedWork } from "./board";
import { decide, type SupervisorInstance } from "./decide";
import { env } from "./env";

const PROJECT_TAG = "loopcliharness";
const ROLE_TAG = "supervisor";
const INSTANCE_NAME = `${PROJECT_TAG}-${ROLE_TAG}`;
const LIVE_STATES = ["pending", "running", "stopping", "shutting-down"];

const ec2 = new EC2Client({});

function toSupervisor(i: Instance): SupervisorInstance {
  if (!i.InstanceId || !i.LaunchTime)
    throw new Error(
      "DescribeInstances returned an instance without id or launch time",
    );
  return { id: i.InstanceId, launchedAt: i.LaunchTime };
}

async function liveSupervisors(): Promise<SupervisorInstance[]> {
  const res = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Role", Values: [ROLE_TAG] },
        { Name: "tag:Project", Values: [PROJECT_TAG] },
        { Name: "instance-state-name", Values: LIVE_STATES },
      ],
    }),
  );
  return (res.Reservations ?? [])
    .flatMap((r) => r.Instances ?? [])
    .map(toSupervisor);
}

function spawnCommand(): RunInstancesCommand {
  return new RunInstancesCommand({
    LaunchTemplate: { LaunchTemplateId: env.LAUNCH_TEMPLATE_ID },
    SubnetId: env.SUBNET_ID,
    MinCount: 1,
    MaxCount: 1,
    TagSpecifications: [
      {
        ResourceType: "instance",
        Tags: [
          { Key: "Name", Value: INSTANCE_NAME },
          { Key: "Role", Value: ROLE_TAG },
          { Key: "Project", Value: PROJECT_TAG },
        ],
      },
    ],
  });
}

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
    env.MAX_INSTANCE_AGE_MINUTES,
    hasWork,
  );
  if (terminate.length > 0)
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: terminate }));
  if (spawn) await ec2.send(spawnCommand());
}
