import { catalogIdFor, type CatalogModel } from './model-catalog'

/**
 * Whether Mikka knows a model a connection listed (#2938, Figma 1381:4660): its id, as the provider names it,
 * corresponds to an entry of the LiteLLM catalogue Mikka reads (`modelCatalog`). Known models are enabled when a
 * key is connected or re-read; a listed model Mikka does not know is offered to add by its own id. Nothing here
 * calls a model: the ids come from the provider's free model list and the catalogue's metadata.
 */
export function knownModels(ids: readonly string[], catalogue: readonly Pick<CatalogModel, 'id'>[]): Set<string> {
  const catalogueIds = new Set(catalogue.map(model => model.id))
  return new Set(ids.filter(id => {
    const catalogId = catalogIdFor(id)
    return catalogId !== null && catalogueIds.has(catalogId)
  }))
}

/** The catalogue `knownModels` reads: the LiteLLM one on the server, its snapshot when LiteLLM cannot be reached. */
export async function knownModelCatalogue(): Promise<readonly Pick<CatalogModel, 'id'>[]> {
  return (await import('./model-catalog-server')).modelCatalog()
}
