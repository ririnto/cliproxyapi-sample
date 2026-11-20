/**
 * Model routes, proxy display names, and effort remaps for the sample.
 */
export const modelRoutes = {
  codex: {
    aliases: [
      { name: "gpt-6.2-astra", alias: "gpt-6-astra", fork: true },
      { name: "gpt-6.2-sol", alias: "gpt-6.1-sol", fork: true },
      { name: "gpt-6.2-sol", alias: "gpt-6-sol" },
      { name: "gpt-6.2-sol", alias: "gpt-5.6-sol" },
      { name: "gpt-6.1-terra", alias: "gpt-5.6-terra", fork: true },
      { name: "gpt-6-luna", alias: "gpt-5.6-luna", fork: true }
    ],
    contextOverrides: [
      "gpt-6.2-astra",
      "gpt-6.2-sol",
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6.1-terra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "codex-auto-review",
      "gpt-5.5"
    ]
  },
  zai: {
    models: [
      { slug: "glm-5.3", displayName: "GLM 5.3" },
      { slug: "glm-5.3-flash", displayName: "GLM 5.3 Flash" }
    ],
    effortRemaps: [
      { requested: "xhigh", forwarded: "max" },
      { requested: "medium", forwarded: "high" },
      { requested: "minimal", forwarded: "low" }
    ]
  }
};
