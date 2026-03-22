###############################################################################
# Inforganizer — Terraform infrastructure
#
# Provisions two EC2 c7i-flex.large instances (master + worker),
# inside a dedicated VPC with a public subnet.
#
# Usage:
#   cp terraform.tfvars.example terraform.tfvars   # fill in your values
#   terraform init
#   terraform plan
#   terraform apply
###############################################################################

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

# ─── Provider ─────────────────────────────────────────────────────────────────
provider "aws" {
  region = var.aws_region
}

# ─── Variables ────────────────────────────────────────────────────────────────
variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "eu-west-3"   # Paris — change to your nearest region
}

variable "key_name" {
  description = "Name of an existing EC2 key pair for SSH access"
  type        = string
}

variable "allowed_cidr" {
  description = "Your IP CIDR for SSH access (e.g. 203.0.113.5/32)"
  type        = string
}

# ─── VPC ──────────────────────────────────────────────────────────────────────
resource "aws_vpc" "inforganizer" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  tags = { Name = "inforganizer-vpc" }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.inforganizer.id
  tags   = { Name = "inforganizer-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.inforganizer.id
  cidr_block              = "10.0.1.0/24"
  map_public_ip_on_launch = true
  availability_zone       = "${var.aws_region}a"
  tags = { Name = "inforganizer-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.inforganizer.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
  tags = { Name = "inforganizer-rt" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# ─── Security Group ───────────────────────────────────────────────────────────
resource "aws_security_group" "k8s" {
  name        = "inforganizer-k8s"
  description = "Kubernetes cluster + app ports"
  vpc_id      = aws_vpc.inforganizer.id

  # SSH — restrict to your IP
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }
  # App (NodePort)
  ingress {
    from_port   = 30080
    to_port     = 30080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  # k3s API server
  ingress {
    from_port   = 6443
    to_port     = 6443
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }
  # Internal cluster communication
  ingress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    self      = true
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "inforganizer-sg" }
}

# ─── Latest Ubuntu 22.04 LTS AMI ──────────────────────────────────────────────
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]   # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ─── EC2 instances ────────────────────────────────────────────────────────────
resource "aws_instance" "master" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = "c7i-flex.large"
  key_name               = var.key_name
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.k8s.id]

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  tags = { Name = "inforganizer-master", Role = "master" }
}

resource "aws_instance" "worker" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = "c7i-flex.large"
  key_name               = var.key_name
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.k8s.id]

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  tags = { Name = "inforganizer-worker", Role = "worker" }
}

# ─── Outputs ──────────────────────────────────────────────────────────────────
output "master_public_ip" {
  description = "Public IP of the k3s master node"
  value       = aws_instance.master.public_ip
}

output "worker_public_ip" {
  description = "Public IP of the k3s worker node"
  value       = aws_instance.worker.public_ip
}

output "app_url" {
  description = "URL to access Inforganizer after deployment"
  value       = "http://${aws_instance.master.public_ip}:30080"
}

# ─── Ansible inventory (auto-generated) ───────────────────────────────────────
# local_file can fail with "Provider produced inconsistent final plan" when
# instance public IPs become known during apply; this approach is stable.
resource "null_resource" "ansible_inventory" {
  triggers = {
    master_ip = aws_instance.master.public_ip
    worker_ip = aws_instance.worker.public_ip
    key_name  = var.key_name
  }

  provisioner "local-exec" {
    command = <<-EOT
      cat > "${path.module}/../ansible/inventory.ini" <<'EOF'
      [master]
      ${self.triggers.master_ip} ansible_user=ubuntu ansible_ssh_private_key_file=~/.ssh/${self.triggers.key_name}.pem

      [workers]
      ${self.triggers.worker_ip} ansible_user=ubuntu ansible_ssh_private_key_file=~/.ssh/${self.triggers.key_name}.pem

      [all:vars]
      ansible_ssh_common_args='-o StrictHostKeyChecking=no'
      EOF
    EOT
  }
}
