// Copyright-protection extension point (intentionally a no-op during beta).
//
// Every ingest path (upload + local scan) awaits beforeIngest(). If this ever goes public, implement here:
//   - upload attestation / ToS acceptance recorded in the `audit` table
//   - content fingerprint / hash blocklist check (return { allow:false, reason })
//   - per-user quotas and share-rate limits (see `shares` + `audit`)
//   - DMCA takedown workflow: lookup media by id, removeMediaFiles(), audit('takedown')
//   - restrict sharing to known groups only (already the case: no public links exist)
export async function beforeIngest(/* { userId, filename, source: 'upload'|'local' } */) {
  return { allow: true };
}
