terraform {
  required_version = "= 1.14.7"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "= 2.101.0"
    }
  }
}

provider "digitalocean" {}

variable "run_id" { type = string }
variable "created" { type = number }
variable "expires" { type = number }
variable "region" { type = string }
variable "size" { type = string }
variable "bootstrap" {
  type      = string
  sensitive = true
}

locals {
  name = "rcp-${var.run_id}"
  markers = [
    local.name, "${local.name}-v1",
    "${local.name}-created-${var.created}", "${local.name}-expires-${var.expires}"
  ]
}

resource "digitalocean_tag" "markers" {
  for_each = toset(local.markers)
  name     = each.value
}

resource "digitalocean_project" "pilot" {
  name        = local.name
  description = join(" ", local.markers)
  purpose     = "Operational / Developer tooling"
  environment = "Development"
}

# Create the deny-inbound firewall before the tagged host can boot.
resource "digitalocean_firewall" "pilot" {
  name = local.name
  tags = [digitalocean_tag.markers[local.name].name]
  dynamic "outbound_rule" {
    for_each = { https = ["tcp", "443"], http = ["tcp", "80"], dns_tcp = ["tcp", "53"], dns_udp = ["udp", "53"], ntp = ["udp", "123"], stun = ["udp", "3478"] }
    content {
      protocol              = outbound_rule.value[0]
      port_range            = outbound_rule.value[1]
      destination_addresses = ["0.0.0.0/0", "::/0"]
    }
  }
}

resource "digitalocean_droplet" "pilot" {
  name          = local.name
  image         = "ubuntu-24-04-x64"
  region        = var.region
  size          = var.size
  tags          = [for tag in digitalocean_tag.markers : tag.name]
  backups       = false
  monitoring    = false
  ssh_keys      = []
  user_data     = var.bootstrap
  droplet_agent = true
  depends_on    = [digitalocean_firewall.pilot]
}

resource "digitalocean_project_resources" "pilot" {
  project   = digitalocean_project.pilot.id
  resources = [digitalocean_droplet.pilot.urn]
}
