import { decodeRegion, prepareRegion } from "./prepare.js";
let catalogPromise;
const regions = new Map();
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      catalogPromise = (data.catalog ? Promise.resolve(data.catalog) : fetch(data.catalogURL).then((r) => r.json()))
        .then((catalog) => {
          catalog.fragmentReach = Math.max(
            0,
            ...catalog.models.flatMap((m) =>
              (m.fragments || []).flatMap((p) => p.offset.map(Math.abs)),
            ),
          );
          return catalog;
        });
      await catalogPromise;
      postMessage({ type: "initialized" });
      return;
    }
    if (data.type === "textures") {
      const previous = await catalogPromise;
      const catalog = { ...data.catalog, fragmentReach: previous.fragmentReach };
      catalogPromise = Promise.resolve(catalog);
      const results = data.regions.map(({ x, z }) =>
        prepareRegion({ x, z, regions, catalog, objects: data.objects }),
      );
      postMessage({ type: "textures", results }, results.flatMap((r) =>
        [r.words.buffer, r.headers.buffer, r.relocations.buffer],
      ));
      return;
    }
    if (data.type === "put") {
      regions.set(data.key, decodeRegion(data.buffer));
      postMessage({ type: "stored", key: data.key, request: data.request });
      return;
    }
    if (data.type === "drop") {
      for (const key of data.keys) regions.delete(key);
      return;
    }
    if (data.type === "prepare") {
      const catalog = await catalogPromise,
        result = prepareRegion({ ...data, regions, catalog });
      postMessage({ type: "prepared", request: data.request, result }, [
        result.words.buffer,
        result.headers.buffer,
        result.relocations.buffer,
      ]);
    }
  } catch (error) {
    postMessage({
      type: "error",
      request: data.request,
      key: data.key,
      error: String(error.stack || error),
    });
  }
};
