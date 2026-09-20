mock_provider "digitalocean" {}

run "private_disposable_host" {
  command = plan
  variables {
    run_id              = "0123456789abcdef01234567"
    created             = 1700000000
    expires             = 1700086400
    region              = "ams3"
    size                = "s-2vcpu-4gb"
    ssh_key_fingerprint = "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff"
    bootstrap           = "#cloud-config\n"
  }
  assert {
    condition     = length(digitalocean_firewall.pilot.inbound_rule) == 0
    error_message = "The pilot must have no cloud inbound rules."
  }
  assert {
    condition     = length(digitalocean_droplet.pilot.ssh_keys) == 1 && contains(digitalocean_droplet.pilot.ssh_keys, var.ssh_key_fingerprint) && !digitalocean_droplet.pilot.backups
    error_message = "The pilot must attach the selected operator key and not create backups."
  }
  assert {
    condition     = length(digitalocean_droplet.pilot.tags) == 4 && length(digitalocean_tag.markers) == 4
    error_message = "All four ownership markers must belong to the disposable host."
  }
}
