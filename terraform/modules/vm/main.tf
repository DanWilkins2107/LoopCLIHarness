resource "aws_security_group" "vm" {
  name        = "${var.name}-vm"
  description = "Base VM security group: no ingress, egress limited to SSM"
  vpc_id      = var.vpc_id

  egress {
    description = "SSM endpoints"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "DNS to VPC resolver"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = [var.dns_resolver_cidr]
  }

  # RFC 7766: a resolver retries over TCP when a UDP answer comes back truncated.
  # Without this rule that retry is dropped and large answers fail to resolve.
  egress {
    description = "DNS to VPC resolver (TCP)"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = [var.dns_resolver_cidr]
  }

  tags = { Name = "${var.name}-vm" }
}

data "aws_iam_policy_document" "vm_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "vm" {
  name               = "${var.name}-vm"
  assume_role_policy = data.aws_iam_policy_document.vm_assume.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.vm.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "vm" {
  name = "${var.name}-vm"
  role = aws_iam_role.vm.name
}

data "aws_ami" "ubuntu" {
  most_recent = true

  # Canonical's AWS account. Pinning the owner is what stops a look-alike name
  # from a third-party account matching the filter below.
  # https://documentation.ubuntu.com/aws/aws-how-to/instances/find-ubuntu-images/
  owners = ["099720109477"]

  # Canonical's published AMI name format. The hvm-ssd* glob covers both the
  # older hvm-ssd and the current hvm-ssd-gp3 image families.
  # https://cloud-images.ubuntu.com/locator/ec2/
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*"]
  }
}

resource "aws_launch_template" "vm" {
  name          = "${var.name}-vm"
  image_id      = data.aws_ami.ubuntu.id
  instance_type = var.instance_type

  instance_initiated_shutdown_behavior = "terminate"
  vpc_security_group_ids               = [aws_security_group.vm.id]

  iam_instance_profile {
    arn = aws_iam_instance_profile.vm.arn
  }

  # Overrides the AMI's own root volume rather than adding a disk: device_name
  # must match the AMI's root device (/dev/sda1 on Canonical's Ubuntu images),
  # or EC2 attaches a second volume and the root stays on the AMI defaults.
  block_device_mappings {
    device_name = "/dev/sda1"

    ebs {
      volume_type           = "gp3"
      volume_size           = var.root_volume_size
      encrypted             = true
      delete_on_termination = true
    }
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }
}
