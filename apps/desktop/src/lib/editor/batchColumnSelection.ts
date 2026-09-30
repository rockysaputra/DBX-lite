export type BatchColumnSelectionMode = "select" | "insert";

export function batchColumnSelectionColumnList(candidates: string[], mode: BatchColumnSelectionMode, qualifier?: string): string {
  return candidates.map((candidate, index) => (mode === "select" && qualifier && index > 0 ? `${qualifier}.${candidate}` : candidate)).join(", ");
}

export function shouldResolveSqlColumnCompletion(options: { suggestColumns: boolean; hasReferencedTables: boolean; prefix: string; typedActivation: boolean; selectListColumnContext: boolean }): boolean {
  return options.suggestColumns && options.hasReferencedTables && (options.prefix.length > 0 || options.typedActivation || options.selectListColumnContext);
}

/**
 * The INSERT batch action writes its own closing parenthesis before VALUES.
 * Consume an existing one (normally inserted by CodeMirror's auto-close
 * brackets extension) so the resulting statement has exactly one `)`.
 */
export function batchColumnSelectionReplaceTo(options: { to: number; mode: BatchColumnSelectionMode; nextCharacter: string; replaceClosingQuote?: string }): number {
  const { to, mode, nextCharacter, replaceClosingQuote } = options;
  return replaceClosingQuote === nextCharacter || (mode === "insert" && nextCharacter === ")") ? to + 1 : to;
}

const IDENTIFIER_CLOSING_QUOTES: Readonly<Record<string, string>> = { '"': '"', "`": "`", "[": "]" };
const IDENTIFIER_PART = /[\p{L}\p{N}_$]/u;
// Clauses that give an INSERT column list its rows once the list is closed.
const INSERT_SOURCE_WORDS = new Set(["values", "value", "select", "with", "default", "overriding", "table"]);
// A line starting with one of these after an unclosed list is the next statement, not a column.
const STATEMENT_START_WORDS = new Set(["select", "with", "insert", "update", "delete", "merge", "replace", "create", "alter", "drop", "truncate", "call", "exec", "execute", "explain", "show", "set", "use", "grant", "revoke", "begin", "commit", "rollback", "declare"]);
// The list tail is scanned only this far; column lists are short.
const INSERT_COLUMN_LIST_SCAN_LIMIT = 8192;
// The identifier being edited is looked at only this far past the cursor, on its own line.
const INSERT_COLUMN_IDENTIFIER_SCAN_LIMIT = 256;

/**
 * End of the INSERT column identifier being completed from `from`: through the
 * closing quote of a quoted name (a doubled quote is an escape) or over the
 * rest of an unquoted name the cursor sits inside. A name that does not end
 * within the small scan bound is left alone (only the typed part is replaced).
 */
export function insertColumnIdentifierEnd(text: string, from: number, to: number): number {
  if (from >= to) return to;
  const closingQuote = IDENTIFIER_CLOSING_QUOTES[text[from] ?? ""];
  const limit = Math.min(text.length, to + INSERT_COLUMN_IDENTIFIER_SCAN_LIMIT);
  if (!closingQuote) {
    let end = to;
    while (end < limit && IDENTIFIER_PART.test(text[end]!)) end += 1;
    return end >= limit && limit < text.length ? to : end;
  }
  // The typed part may already contain the closing quote (`"name"|`).
  for (let index = from + 1; index < to; index += 1) {
    if (text[index] !== closingQuote) continue;
    if (text[index + 1] !== closingQuote) return to;
    index += 1;
  }
  for (let index = to; index < limit && text[index] !== "\n"; index += 1) {
    if (text[index] !== closingQuote) continue;
    if (text[index + 1] !== closingQuote) return index + 1;
    index += 1;
  }
  return to;
}

// The scan helpers never read at or past `limit`. `truncated` means the bound was
// hit while text remained, i.e. what follows was not inspected.
function skipQuoted(text: string, start: number, closingQuote: string, limit: number): { index: number; truncated: boolean } {
  for (let index = start + 1; index < limit; index += 1) {
    if (text[index] !== closingQuote) continue;
    if (text[index + 1] !== closingQuote) return { index: index + 1, truncated: false };
    index += 1;
  }
  return { index: limit, truncated: limit < text.length };
}

function skipTrivia(text: string, start: number, limit: number): { index: number; sawComment: boolean; newline: boolean; truncated: boolean } {
  let index = start;
  let sawComment = false;
  let newline = false;
  let truncated = false;
  while (index < limit && !truncated) {
    const character = text[index]!;
    if (character === "\n") newline = true;
    if (/\s/.test(character)) {
      index += 1;
    } else if (character === "-" && text[index + 1] === "-") {
      sawComment = true;
      while (index < limit && text[index] !== "\n") index += 1;
    } else if (character === "/" && text[index + 1] === "*") {
      sawComment = true;
      let end = index + 2;
      while (end + 1 < limit && !(text[end] === "*" && text[end + 1] === "/")) end += 1;
      if (end + 1 < limit) index = end + 2;
      else {
        index = Math.min(text.length, limit);
        // An unterminated comment at the end of the text is fully inspected.
        truncated = limit < text.length;
      }
    } else {
      break;
    }
  }
  return { index, sawComment, newline, truncated: truncated || (index >= limit && limit < text.length) };
}

function wordAt(text: string, index: number, limit: number): { word: string; truncated: boolean } {
  let end = index;
  while (end < limit && IDENTIFIER_PART.test(text[end]!)) end += 1;
  return { word: text.slice(index, end), truncated: end >= limit && limit < text.length };
}

/**
 * Classify what follows the completed identifier inside an INSERT column list
 * without touching it: existing columns, the closing parenthesis (and whether a
 * row source follows it), a VALUES clause of an unclosed list, or the end of
 * the statement. Comments and quoted text are skipped, never interpreted. When
 * the scan bound is reached first the result is `truncated`: nothing is known
 * about the rest.
 */
function scanInsertColumnListTail(text: string, start: number) {
  const limit = Math.min(text.length, start + INSERT_COLUMN_LIST_SCAN_LIMIT);
  let index = start;
  let depth = 0;
  let sawComment = false;
  let firstSignificant: string | undefined;
  let atLineStart = false;
  while (index < limit) {
    const trivia = skipTrivia(text, index, limit);
    sawComment ||= trivia.sawComment;
    atLineStart ||= trivia.newline;
    index = trivia.index;
    if (trivia.truncated) return { kind: "truncated" as const, at: index, firstSignificant, sawComment };
    if (index >= limit) break;
    const character = text[index]!;
    if (depth === 0 && character === ")") {
      const afterLimit = Math.min(text.length, index + 1 + INSERT_COLUMN_LIST_SCAN_LIMIT);
      const after = skipTrivia(text, index + 1, afterLimit);
      const next = after.truncated ? undefined : wordAt(text, after.index, afterLimit);
      // Unknown (bound reached) counts as a row source: the `)` is then left as it is.
      const hasSource = !next || next.truncated || text[after.index] === "(" || INSERT_SOURCE_WORDS.has(next.word.toLowerCase());
      return { kind: "closed" as const, at: index, firstSignificant, sawComment, hasSource };
    }
    if (depth === 0 && character === ";") return { kind: "end" as const, at: index, firstSignificant, sawComment };
    if (IDENTIFIER_PART.test(character)) {
      const { word, truncated } = wordAt(text, index, limit);
      const normalized = word.toLowerCase();
      if (depth === 0 && (normalized === "values" || normalized === "value")) return { kind: "values" as const, at: index, firstSignificant, sawComment };
      if (depth === 0 && atLineStart && STATEMENT_START_WORDS.has(normalized)) return { kind: "end" as const, at: index, firstSignificant, sawComment };
      firstSignificant ??= character;
      index += word.length;
      if (truncated) return { kind: "truncated" as const, at: index, firstSignificant, sawComment };
    } else {
      firstSignificant ??= character;
      const closingQuote = character === "'" ? "'" : IDENTIFIER_CLOSING_QUOTES[character];
      if (closingQuote) {
        const quoted = skipQuoted(text, index, closingQuote, limit);
        index = quoted.index;
        if (quoted.truncated) return { kind: "truncated" as const, at: index, firstSignificant, sawComment };
      } else {
        if (character === "(") depth += 1;
        else if (character === ")") depth -= 1;
        index += 1;
      }
    }
    atLineStart = false;
  }
  return limit < text.length ? { kind: "truncated" as const, at: index, firstSignificant, sawComment } : { kind: "end" as const, at: index, firstSignificant, sawComment };
}

/**
 * Replacement for the INSERT batch action, applied from the completion `from`.
 * Picked columns replace the identifier being completed; everything after it
 * (existing columns, comments, the closing parenthesis, a row source and any
 * following statement) is preserved. `) VALUES (...)` is only written when the
 * statement has no row source yet.
 */
export function batchColumnSelectionInsertReplacement(options: { document: string; from: number; to: number; columns: string; valuesKeyword: "values" | "VALUES"; valueCount: number }): { replaceTo: number; insert: string } {
  const { document, columns } = options;
  const identifierEnd = insertColumnIdentifierEnd(document, options.from, options.to);
  const tail = scanInsertColumnListTail(document, identifierEnd);
  const values = Array.from({ length: options.valueCount }, (_, index) => `\${${index + 1}:value}`).join(", ");
  const withValues = `${columns}) ${options.valuesKeyword} (${values})`;

  // Existing columns follow: splice the picked ones in front of them.
  if (tail.firstSignificant !== undefined) return { replaceTo: identifierEnd, insert: tail.firstSignificant === "," ? columns : `${columns}, ` };
  if (tail.kind === "closed") {
    if (tail.hasSource || tail.sawComment) return { replaceTo: identifierEnd, insert: columns };
    // Only whitespace up to `)` and no row source: rewrite `)` with a VALUES clause.
    return { replaceTo: tail.at + 1, insert: withValues };
  }
  if (tail.kind === "values") return { replaceTo: identifierEnd, insert: `${columns})${/\s/.test(document[identifierEnd] ?? "") ? "" : " "}` };
  // The scan bound was reached: keep the uninspected suffix as it is, only replace the identifier.
  if (tail.kind === "truncated") return { replaceTo: identifierEnd, insert: columns };
  // Unclosed list at the end of its statement (a following statement is left alone).
  return { replaceTo: identifierEnd, insert: withValues };
}

export function isBatchColumnSelectionCompletionActive(status: "active" | "pending" | null): boolean {
  return status === "active";
}
