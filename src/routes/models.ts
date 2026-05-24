import { Hono } from "hono";
import type { Env, Variables } from "../types/env";
import type { ModelList } from "../types/openai";
import { getModels } from "../utils/model-discovery";

const models = new Hono<{ Bindings: Env; Variables: Variables }>();

models.get("/v1/models", async (c) => {
  const registry = await getModels(c.env);
  const created = Math.floor(Date.now() / 1000);
  const list: ModelList = {
    object: "list",
    data: registry.map((m) => ({
      id: m.id,
      object: "model",
      created,
      owned_by: m.provider,
    })),
  };
  return c.json(list);
});

export default models;
