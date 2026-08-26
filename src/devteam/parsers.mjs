import path from "node:path";

// T1.2 — the graph that answers "what else does this touch?" used to understand JavaScript and
// TypeScript and nothing else. Every other ecosystem — Python, Go, Rust, SQL, notebooks, prose, data
// — got an empty graph, which is exactly the mechanism that stops agents from breaking each other's
// work. A non-software project lost it entirely.
//
// A parser is: { id, language, extensions, parse(source, filePath), resolve(specifier, fromPath) }
//
//   parse   -> { imports, exports }  — imports are raw specifiers as written; exports are the names
//              (or headings, or table names) this file offers to the rest of the project.
//   resolve -> candidate project-relative paths, in preference order, for one import specifier.
//              The graph keeps the first candidate that actually exists, so a parser may guess
//              freely; guessing wrong costs an edge, never a wrong edge.
//
// Everything here is deliberately a bounded regex rather than a real parser. A real parser per
// language is a dependency per language, and this graph's job is orientation ("what else should I
// look at?"), not compilation. Import-like text inside a comment or a string may be mis-detected;
// that has always been true of the JS parser and is an acceptable cost for zero dependencies.

export const MAX_IMPORTS = 100;
export const MAX_EXPORTS = 100;
export const MAX_SPECIFIER_LENGTH = 500;
export const MAX_SYMBOL_LENGTH = 120;

const uniqueSorted = (values, limit = Infinity) => [...new Set(values)].sort().slice(0, limit);
const posix = (value) => String(value || "").replace(/\\/g, "/");

// Collect bounded, de-duplicated imports/exports without every parser repeating the guards.
function collector(clean) {
  const imports = [];
  const exports = [];
  return {
    addImport(specifier) {
      const value = clean(specifier, MAX_SPECIFIER_LENGTH);
      if (value && imports.length < MAX_IMPORTS) imports.push(value);
    },
    addExport(symbol) {
      const value = clean(symbol, MAX_SYMBOL_LENGTH);
      if (value && exports.length < MAX_EXPORTS) exports.push(value);
    },
    done() {
      return { imports: uniqueSorted(imports, MAX_IMPORTS), exports: uniqueSorted(exports, MAX_EXPORTS) };
    },
  };
}

// Relative specifiers only. A bare specifier is a dependency on something outside the project, which
// the graph records as a dependency rather than resolving to a file.
const relativeBase = (specifier, fromPath) => {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  if (!base || base === ".." || base.startsWith("../") || base.startsWith("/")) return null;
  return base;
};

const JS_LEAF = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const JS_INDEX = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs", "/index.cjs"];

export function javascriptParser(clean) {
  return {
    id: "javascript",
    extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"],
    language: (file) => ({
      ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
      ".ts": "typescript", ".jsx": "jsx", ".tsx": "tsx",
    })[path.extname(file).toLowerCase()] || "javascript",
    parse(source) {
      const out = collector(clean);
      for (const pattern of [
        /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"'\r\n]+)["']/g,
        /\bimport\s*\(\s*["']([^"'\r\n]+)["']\s*\)/g,
        /\brequire\s*\(\s*["']([^"'\r\n]+)["']\s*\)/g,
      ]) {
        for (const match of source.matchAll(pattern)) out.addImport(match[1]);
      }
      for (const match of source.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) out.addExport(match[1]);
      if (/\bexport\s+default\b/.test(source)) out.addExport("default");
      for (const match of source.matchAll(/\bexport\s*\{([^}]{0,4000})\}/g)) {
        for (const item of match[1].split(",").slice(0, MAX_EXPORTS)) {
          const value = item.trim().replace(/^type\s+/, "");
          if (!value) continue;
          const parts = value.split(/\s+as\s+/i).map((part) => part.trim());
          out.addExport(parts[1] || parts[0]);
        }
      }
      for (const match of source.matchAll(/\b(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)\s*=/g)) out.addExport(match[1]);
      for (const match of source.matchAll(/\bmodule\.exports\s*=\s*\{([^}]{0,4000})\}/g)) {
        for (const item of match[1].split(",").slice(0, MAX_EXPORTS)) {
          const symbol = item.trim().split(/\s*:\s*/)[0]?.trim();
          if (/^[A-Za-z_$][\w$]*$/.test(symbol || "")) out.addExport(symbol);
        }
      }
      return out.done();
    },
    external: (specifier) => !specifier.startsWith("./") && !specifier.startsWith("../"),
    resolve(specifier, fromPath) {
      const base = relativeBase(specifier, fromPath);
      if (!base) return [];
      return [...JS_LEAF, ...JS_INDEX].map((suffix) => path.posix.normalize(`${base}${suffix}`));
    },
  };
}

export function pythonParser(clean) {
  return {
    id: "python",
    extensions: [".py", ".pyi"],
    language: () => "python",
    parse(source) {
      const out = collector(clean);
      // `import a.b.c`, `import a as b`, and `from .x.y import z` (including explicit relative dots).
      for (const match of source.matchAll(/^[ \t]*import[ \t]+([A-Za-z_][\w.]*(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*)*)/gm)) {
        for (const part of match[1].split(",")) out.addImport(part.trim().split(/\s+as\s+/i)[0]);
      }
      for (const match of source.matchAll(/^[ \t]*from[ \t]+(\.*[A-Za-z_][\w.]*|\.+)[ \t]+import\b/gm)) out.addImport(match[1].trim());
      // Top-level definitions are what this module offers. Indented ones are methods and locals.
      for (const match of source.matchAll(/^(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gm)) out.addExport(match[1]);
      for (const match of source.matchAll(/^class[ \t]+([A-Za-z_]\w*)/gm)) out.addExport(match[1]);
      // An explicit __all__ is the module's own statement about its surface, so it wins attention.
      for (const match of source.matchAll(/__all__\s*=\s*[[(]([^\])]{0,4000})[\])]/g)) {
        for (const item of match[1].split(",").slice(0, MAX_EXPORTS)) {
          const symbol = item.trim().replace(/^["']|["']$/g, "");
          if (/^[A-Za-z_]\w*$/.test(symbol)) out.addExport(symbol);
        }
      }
      return out.done();
    },
    // A leading dot is always intra-package. Anything else may be either a third-party package or
    // this project's own top-level package, and only resolution can tell — so it is listed as a
    // dependency *and* offered for resolution. A name that turns out to be both is honestly both.
    external: (specifier) => !specifier.startsWith("."),
    resolve(specifier, fromPath) {
      const directory = path.posix.dirname(fromPath);
      // Explicit relative import: leading dots are "up one package" each, after the first.
      const relative = specifier.match(/^(\.+)(.*)$/);
      const candidates = [];
      const asPath = (base) => {
        if (!base || base.startsWith("/") || base.startsWith("..")) return;
        candidates.push(`${base}.py`, `${base}.pyi`, `${base}/__init__.py`);
      };
      if (relative) {
        const up = relative[1].length - 1;
        const tail = relative[2].replace(/\./g, "/");
        let base = directory;
        for (let step = 0; step < up; step += 1) base = path.posix.dirname(base);
        asPath(path.posix.normalize(path.posix.join(base === "." ? "" : base, tail)));
      } else {
        // An absolute-looking import may still be intra-project: `from mypkg.util import x` in a
        // repo whose package lives at mypkg/. Try it from the project root and beside the importer.
        const asDirs = specifier.replace(/\./g, "/");
        asPath(asDirs);
        asPath(path.posix.normalize(path.posix.join(directory === "." ? "" : directory, asDirs)));
      }
      return candidates.filter(Boolean);
    },
  };
}

export function markdownParser(clean) {
  return {
    id: "markdown",
    extensions: [".md", ".markdown", ".mdx"],
    language: () => "markdown",
    parse(source) {
      const out = collector(clean);
      // Inline links to files in the repo. External URLs and anchors are not project edges.
      for (const match of source.matchAll(/\[[^\]]{0,200}\]\(([^)\s]{1,400})(?:\s+"[^"]{0,200}")?\)/g)) {
        const target = match[1].split("#")[0].trim();
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
        out.addImport(target.startsWith("./") || target.startsWith("../") ? target : `./${target}`);
      }
      // Obsidian-style wikilinks, which is how the knowledge vault itself is written.
      for (const match of source.matchAll(/\[\[([^\]|]{1,200})(?:\|[^\]]{0,200})?\]\]/g)) {
        const target = match[1].trim();
        if (target) out.addImport(`./${target}`);
      }
      // Headings are a prose document's public surface: they are what another document links to and
      // what a reader is looking for, which is exactly the role exports play for code.
      for (const match of source.matchAll(/^#{1,3}[ \t]+(.{1,120}?)[ \t]*#*$/gm)) out.addExport(match[1].trim());
      return out.done();
    },
    external: () => false,
    resolve(specifier, fromPath) {
      const base = relativeBase(specifier, fromPath);
      if (!base) return [];
      return [base, `${base}.md`, `${base}.markdown`, `${base}.mdx`, `${base}/README.md`, `${base}/index.md`];
    },
  };
}

// Everything else that is text. This is what makes the graph useful for a project DevTeam has never
// heard of: a filename mentioned inside a file is a real relationship, whatever the file is. It only
// ever produces an edge when the mentioned path actually exists in the project, so a false positive
// costs nothing and a stray word can never invent a module.
export function referenceParser(clean) {
  return {
    id: "reference",
    extensions: [],           // the fallback: consulted for any text file no other parser claims
    language: (file) => path.extname(file).toLowerCase().replace(".", "") || "text",
    parse(source) {
      const out = collector(clean);
      for (const match of source.matchAll(/\[\[([^\]|]{1,200})(?:\|[^\]]{0,200})?\]\]/g)) {
        const target = match[1].trim();
        if (target) out.addImport(`./${target}`);
      }
      // A project-relative-looking path with an extension, in quotes or bare. Bounded hard: this
      // runs over arbitrary text, so it must never become a scan of every word in the file.
      for (const match of source.matchAll(/(?:^|["'`(\s])((?:\.{1,2}\/)?(?:[\w.-]+\/){0,6}[\w.-]+\.[A-Za-z0-9]{1,8})(?=["'`)\s,;:.!?]|$)/gm)) {
        const target = match[1];
        if (!target || target.startsWith("//") || /^\d+\.\d+$/.test(target)) continue;
        out.addImport(target.startsWith("./") || target.startsWith("../") ? target : `./${target}`);
      }
      return out.done();
    },
    external: () => false,
    resolve(specifier, fromPath) {
      const base = relativeBase(specifier, fromPath);
      const candidates = base ? [base] : [];
      // Also try the specifier as a project-root-relative path, because prose routinely writes
      // `src/thing.py` meaning the one in the repo rather than one beside the current file.
      const bare = specifier.replace(/^\.\//, "");
      if (bare && !bare.startsWith("..") && !bare.startsWith("/")) candidates.push(posix(bare));
      return candidates;
    },
  };
}

// Data and config files: recorded as nodes so other files can point at them, but nothing is parsed
// out of them. A JSON file's "imports" are not meaningful, and inventing some would add noise.
export function opaqueParser() {
  return {
    id: "opaque",
    extensions: [".json", ".yaml", ".yml", ".toml", ".ini", ".csv", ".tsv", ".sql", ".ipynb"],
    language: (file) => path.extname(file).toLowerCase().replace(".", "") || "data",
    parse() { return { imports: [], exports: [] }; },
    external: () => false,
    resolve() { return []; },
  };
}

// Text formats with no parser of their own still get the reference fallback, so a `.txt` spec that
// names three files is a node with three edges rather than an invisible file.
export const FALLBACK_EXTENSIONS = [
  ".txt", ".rst", ".adoc", ".org", ".tex",
  ".go", ".rs", ".rb", ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php",
  ".sh", ".bash", ".ps1", ".r", ".jl", ".scala", ".ex", ".exs", ".lua", ".pl", ".vue", ".svelte",
];

export function buildParserRegistry(clean) {
  const parsers = [javascriptParser(clean), pythonParser(clean), markdownParser(clean), opaqueParser()];
  const fallback = referenceParser(clean);
  const byExtension = new Map();
  for (const parser of parsers) {
    for (const extension of parser.extensions) byExtension.set(extension, parser);
  }
  for (const extension of FALLBACK_EXTENSIONS) byExtension.set(extension, fallback);
  return {
    parsers: [...parsers, fallback],
    extensions: new Set(byExtension.keys()),
    // The parser for a file, or null when DevTeam does not handle this type at all. Callers treat
    // null as "not an artifact", which is what keeps binaries and archives out of the graph.
    for(file) {
      return byExtension.get(path.extname(file).toLowerCase()) || null;
    },
  };
}
