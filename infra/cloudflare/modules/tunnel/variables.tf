variable "account_id" {
  description = "The account the tunnels live in."
  type        = string
}

variable "zone_id" {
  description = "The zone of every origin record."
  type        = string
}

variable "service" {
  description = "Where each tunnel sends its project's hostname, on the machine."
  type        = string
  default     = "http://localhost:8787"
}

variable "tunnels" {
  description = "Project label -> its machine's tunnel name, origin hostname and public hostname."
  type = map(object({
    name        = string
    origin      = string
    public_host = string
  }))
  default = {}
}
