locals {
  vpc_cidr     = "10.0.0.0/16"
  subnet_cidr  = "10.0.0.0/24"
  dns_resolver = "10.0.0.2/32"
}

resource "aws_vpc" "this" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = var.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.subnet_cidr
  map_public_ip_on_launch = true

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# No ingress: access is SSM Session Manager only. Egress is what the SSM agent
# needs; default-deny + proxy is owned by a later node.
resource "aws_security_group" "vm" {
  name        = "${var.name}-vm"
  description = "Base VM security group: no ingress, egress limited to SSM"
  vpc_id      = aws_vpc.this.id

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
    cidr_blocks = [local.dns_resolver]
  }

  egress {
    description = "DNS to VPC resolver (TCP fallback)"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = [local.dns_resolver]
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
  owners      = ["099720109477"]

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
