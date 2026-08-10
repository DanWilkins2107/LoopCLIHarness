import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type Instance,
} from "@aws-sdk/client-ec2";
import type { SupervisorInstance } from "../decide";
import { env } from "../env";

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

export async function liveSupervisors(): Promise<SupervisorInstance[]> {
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

export async function terminateSupervisors(ids: string[]): Promise<void> {
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
}

export async function runSupervisor(): Promise<void> {
  await ec2.send(
    new RunInstancesCommand({
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
    }),
  );
}
