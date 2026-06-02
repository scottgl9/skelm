import { BlockList, isIP } from 'node:net'

// Cloud instance-metadata endpoints. Reaching these from a workflow's egress is
// the canonical SSRF->credential-theft path (e.g. GET 169.254.169.254/.../iam/...
// on AWS/GCP/Azure/DO/Oracle, or the AWS IMDS IPv6 address). The whole IPv4
// link-local /16 is non-routable and exists only for this and ARP-less autoconf,
// so blocking the range — not just the single .254 — is the standard defense.
const METADATA_BLOCK = new BlockList()
METADATA_BLOCK.addSubnet('169.254.0.0', 16, 'ipv4')
METADATA_BLOCK.addAddress('fd00:ec2::254', 'ipv6')

// Extract the embedded IPv4 of an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or
// its hex form `::ffff:a9fe:a9fe`), so a mapped metadata address can't slip past
// the IPv4 subnet check. Returns undefined for any other IPv6 address.
function ipv4MappedToV4(host: string): string | undefined {
  const dotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
  if (dotted?.[1] !== undefined) return dotted[1]
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const hi = Number.parseInt(hex[1], 16)
    const lo = Number.parseInt(hex[2], 16)
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }
  return undefined
}

/**
 * True when `host` is a literal IP address belonging to a cloud
 * instance-metadata range (IPv4 link-local `169.254.0.0/16`, its IPv4-mapped
 * IPv6 form, or the AWS IMDS IPv6 address `fd00:ec2::254`). Hostnames return
 * `false` — they cannot be classified without DNS resolution, which the caller
 * performs before dialing so a name that resolves to metadata is still blocked.
 *
 * The IPv4 `169.254.0.0/16` block covers metadata over IPv4 for every major
 * cloud (AWS/GCP/Azure/Oracle/DO all expose it at `169.254.169.254`). The IPv6
 * coverage is AWS-only (`fd00:ec2::254`); other clouds' IPv6 IMDS addresses
 * (e.g. Azure) are not yet enumerated. Extend `METADATA_BLOCK` if multi-cloud
 * IPv6 metadata enters scope.
 */
export function isMetadataAddress(host: string): boolean {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const family = isIP(h)
  if (family === 0) return false
  if (family === 4) return METADATA_BLOCK.check(h, 'ipv4')
  const mapped = ipv4MappedToV4(h)
  if (mapped !== undefined) return METADATA_BLOCK.check(mapped, 'ipv4')
  return METADATA_BLOCK.check(h, 'ipv6')
}
