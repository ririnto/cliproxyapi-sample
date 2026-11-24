import type { Rule } from "markdownlint";

const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const hasLetters = /\p{L}/u;

const rule: Rule = {
  description: "Use one prose sentence per Markdown source line",
  function: (params, onError) => {
    for (const token of params.parsers.markdownit.tokens) {
      if (
        token.type === "inline" &&
        token.children !== null &&
        token.map !== null
      ) {
        const proseByLine = new Map<number, string>();
        for (const index of token.children.keys()) {
          const child = token.children[index];
          if (child?.type === "text" || child?.type === "code_inline") {
            proseByLine.set(
              child.lineNumber,
              `${proseByLine.get(child.lineNumber) ?? ""}${child.type === "text" ? child.content : "Code"}`
            );
          }
        }
        for (const [lineNumber, prose] of proseByLine) {
          if (
            [...segmenter.segment(prose)].filter(({ segment }) =>
              hasLetters.test(segment)
            ).length > 1
          ) {
            onError({ lineNumber });
          }
        }
      }
    }
  },
  names: ["docs/one-sentence-per-line"],
  parser: "markdownit",
  tags: ["docs", "prose"]
};

export { rule as "module.exports" };

export default rule;
