export function isGatewayGenerationId(id) {
  return typeof id === 'string' && id.length === 30 && /^gen_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)
}

export function gatewayGenerationIdFromSearch(search) {
  const id = search.startsWith('?id=') ? search.slice(4) : undefined
  return isGatewayGenerationId(id) ? id : undefined
}
