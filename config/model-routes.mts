/**
 * Codex model lanes and provider routes for the sample.
 */
export const modelRoutes = {
  codex: {
    lanes: ["astra", "sol", "terra", "luna"],
    nonForkAliases: ["gpt-6-sol", "gpt-5.6-sol"],
    hiddenModels: ["gpt-5.5"],
    standaloneContextOverrides: ["codex-auto-review", "gpt-5.5"]
  },
  glm: [
    {
      marker: "zai-models",
      name: "glm-5.4",
      slug: "zai/glm-5.4",
      displayName: "GLM-5.4 (Z.AI Coding Plan)"
    },
    {
      marker: "zhipuai-models",
      name: "glm-5.4",
      slug: "zhipuai-coding-plan/glm-5.4",
      displayName: "GLM-5.4 (Zhipu AI Coding Plan)"
    },
    {
      marker: "zai-models",
      name: "glm-5.3-flash",
      slug: "glm-5.3-flash",
      additionalAliases: ["zai/glm-5.3-flash"],
      displayName: "GLM 5.3 Flash",
      promoteSupportedEfforts: true
    }
  ]
};
