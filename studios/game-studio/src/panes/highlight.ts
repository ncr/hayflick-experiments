export type Token = { kind: TokenKind; text: string };

type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "builtin"
  | "punct"
  | "operator"
  | "regex"
  | "ident";

const KEYWORDS = new Set([
  "abstract","as","async","await","break","case","catch","class","const","continue",
  "debugger","default","delete","do","else","enum","export","extends","false","finally",
  "for","from","function","get","if","implements","import","in","instanceof","interface",
  "is","keyof","let","new","null","of","override","package","private","protected","public",
  "readonly","return","satisfies","set","static","super","switch","this","throw","true",
  "try","type","typeof","undefined","var","void","while","with","yield","namespace","module",
  "declare","infer","never","unknown","any"
]);

const BUILTINS = new Set([
  "console","window","document","Math","JSON","Object","Array","String","Number","Boolean",
  "Promise","Map","Set","WeakMap","WeakSet","Symbol","Date","RegExp","Error","performance",
  "requestAnimationFrame","cancelAnimationFrame","setTimeout","setInterval","clearTimeout",
  "clearInterval","globalThis","Infinity","NaN"
]);

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  let prevSignificant: Token | null = null;

  const push = (kind: TokenKind, text: string) => {
    if (!text) return;
    out.push({ kind, text });
    if (kind !== "plain") prevSignificant = { kind, text };
  };

  const canStartRegex = (): boolean => {
    if (!prevSignificant) return true;
    if (prevSignificant.kind === "operator" || prevSignificant.kind === "punct") {
      const t = prevSignificant.text;
      if (t === ")" || t === "]") return false;
      return true;
    }
    if (prevSignificant.kind === "keyword") {
      const t = prevSignificant.text;
      return t === "return" || t === "typeof" || t === "in" || t === "of" || t === "instanceof"
        || t === "new" || t === "delete" || t === "void" || t === "throw" || t === "yield" || t === "await";
    }
    return false;
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "/" && next === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      push("comment", src.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < n - 1 && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      push("comment", src.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        const c = src[j];
        if (c === "\\") { j += 2; continue; }
        if (c === quote) { j++; break; }
        if (quote === "`" && c === "$" && src[j + 1] === "{") {
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (src[j] === "{") depth++;
            else if (src[j] === "}") depth--;
            j++;
          }
          continue;
        }
        j++;
      }
      push("string", src.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "/" && canStartRegex()) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const c = src[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) { j++; break; }
        else if (c === "\n") break;
        j++;
      }
      while (j < n && /[gimsuy]/.test(src[j])) j++;
      push("regex", src.slice(i, j));
      i = j;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < n && /[0-9_xXobBeE.+\-a-fA-F]/.test(src[j])) {
        const c = src[j];
        if ((c === "+" || c === "-") && !(src[j - 1] === "e" || src[j - 1] === "E")) break;
        j++;
      }
      push("number", src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let kind: TokenKind = "ident";
      if (KEYWORDS.has(word)) kind = "keyword";
      else if (BUILTINS.has(word)) kind = "builtin";
      else if (/^[A-Z]/.test(word)) kind = "type";
      push(kind, word);
      i = j;
      continue;
    }
    if (/[{}()[\];,.:]/.test(ch)) {
      push("punct", ch);
      i++;
      continue;
    }
    if (/[+\-*/%=<>!&|^~?]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[+\-*/%=<>!&|^~?]/.test(src[j])) j++;
      push("operator", src.slice(i, j));
      i = j;
      continue;
    }
    push("plain", ch);
    i++;
  }

  return out;
}
