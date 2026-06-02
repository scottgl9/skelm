import { describe, expect, it } from 'vitest'
import { isMetadataAddress } from '../src/net-classify.js'

describe('isMetadataAddress', () => {
  it('flags the IPv4 link-local / cloud-metadata range', () => {
    expect(isMetadataAddress('169.254.169.254')).toBe(true)
    expect(isMetadataAddress('169.254.0.1')).toBe(true)
    expect(isMetadataAddress('169.254.255.255')).toBe(true)
  })

  it('flags the AWS IMDS IPv6 address (bracketed or bare)', () => {
    expect(isMetadataAddress('fd00:ec2::254')).toBe(true)
    expect(isMetadataAddress('[fd00:ec2::254]')).toBe(true)
  })

  it('flags IPv4-mapped IPv6 forms of the metadata address', () => {
    expect(isMetadataAddress('::ffff:169.254.169.254')).toBe(true)
    // hex-encoded mapped form of 169.254.169.254 (a9fe:a9fe)
    expect(isMetadataAddress('::ffff:a9fe:a9fe')).toBe(true)
  })

  it('does not flag loopback, private, or public addresses', () => {
    expect(isMetadataAddress('127.0.0.1')).toBe(false)
    expect(isMetadataAddress('10.0.0.1')).toBe(false)
    expect(isMetadataAddress('192.168.1.1')).toBe(false)
    expect(isMetadataAddress('8.8.8.8')).toBe(false)
    expect(isMetadataAddress('::1')).toBe(false)
    expect(isMetadataAddress('fd00::1')).toBe(false)
  })

  it('returns false for hostnames (classified after DNS resolution, not here)', () => {
    expect(isMetadataAddress('example.com')).toBe(false)
    expect(isMetadataAddress('metadata.google.internal')).toBe(false)
    expect(isMetadataAddress('')).toBe(false)
  })
})
