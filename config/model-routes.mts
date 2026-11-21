/**
 * Stable Codex aliases and provider routes for the sample.
 */
export const modelRoutes = {
  codex: {
    aliases: [
      { alias: "gpt-6-astra", fork: true },
      { alias: "gpt-6.1-sol", fork: true },
      { alias: "gpt-6-sol" },
      { alias: "gpt-5.6-sol" },
      { alias: "gpt-5.6-terra", fork: true },
      { alias: "gpt-5.6-luna", fork: true }
    ],
    standaloneContextOverrides: ["codex-auto-review", "gpt-5.5"]
  },
  zai: {
    models: [
      { slug: "glm-5.3", displayName: "GLM 5.3" },
      { slug: "glm-5.3-flash", displayName: "GLM 5.3 Flash" }
    ]
  }
};
