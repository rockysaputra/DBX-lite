import * as langSql from "@codemirror/lang-sql";
import { snippetCompletion } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { batchColumnSelectionColumnList, batchColumnSelectionInsertReplacement, batchColumnSelectionReplaceTo, insertColumnIdentifierEnd, isBatchColumnSelectionCompletionActive, shouldResolveSqlColumnCompletion } from "@/lib/editor/batchColumnSelection";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { buildSqlCompletionItemsFromContext, getSqlCompletionContext, prepareSqlCompletionReplacement, type SqlCompletionColumn } from "@/lib/sql/sqlCompletion";
import { sqlCompletionContextFromSemantic } from "@/lib/sql/semantic/completion";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";

describe("batchColumnSelectionColumnList", () => {
  it("keeps a typed qualifier on every projection after the first", () => {
    expect(batchColumnSelectionColumnList(["method", "path", "remark"], "select", "ap")).toBe("method, ap.path, ap.remark");
  });

  it("does not add a qualifier to INSERT target columns", () => {
    expect(batchColumnSelectionColumnList(["id", "name"], "insert", "users")).toBe("id, name");
  });
});

describe("batchColumnSelectionReplaceTo", () => {
  it("consumes the auto-inserted INSERT closing parenthesis", () => {
    expect(batchColumnSelectionReplaceTo({ to: 20, mode: "insert", nextCharacter: ")" })).toBe(21);
  });

  it("keeps the replacement boundary when INSERT has no closing parenthesis", () => {
    expect(batchColumnSelectionReplaceTo({ to: 20, mode: "insert", nextCharacter: "" })).toBe(20);
  });

  it("continues consuming a matching closing identifier quote", () => {
    expect(batchColumnSelectionReplaceTo({ to: 20, mode: "select", nextCharacter: '"', replaceClosingQuote: '"' })).toBe(21);
  });
});

describe("batchColumnSelectionInsertReplacement", () => {
  it("consumes whitespace before an existing closing parenthesis", () => {
    const document = "INSERT INTO users (id   )";
    const to = "INSERT INTO users (id".length;
    expect(batchColumnSelectionInsertReplacement({ document, from: to - "id".length, to, columns: "id, name", valuesKeyword: "VALUES", valueCount: 2 })).toEqual({
      replaceTo: document.length,
      insert: "id, name) VALUES (${1:value}, ${2:value})",
    });
  });

  it("does not duplicate an existing VALUES clause", () => {
    const to = "INSERT INTO users (id".length;
    // The existing `)` and VALUES clause are left in place instead of being rewritten.
    expect(batchColumnSelectionInsertReplacement({ document: "INSERT INTO users (id)  VALUES (1)", from: to - "id".length, to, columns: "id, name", valuesKeyword: "VALUES", valueCount: 2 })).toEqual({ replaceTo: to, insert: "id, name" });
  });
});

describe("insertColumnIdentifierEnd", () => {
  it.each<[string, string, number]>([
    ["unquoted name continues after the cursor", "(organi|zation_id, x)", "(organization_id".length],
    ["cursor at the end of an unquoted name", "(organization_id|, x)", "(organization_id".length],
    ["nothing typed yet", "(|abc)", "(".length],
    ["quoted name continues after the cursor", '("Us|er Name", x)', '("User Name"'.length],
    ["doubled quote inside a quoted name", '("a|""b", x)', '("a""b"'.length],
    ["typed part already closed", '("User Name"|, "qty")', '("User Name"'.length],
    ["unterminated quoted name stays on its line", '("Us|\n") VALUES', '("Us'.length],
    ["backtick name", "(`us|er name`, x)", "(`user name`".length],
    ["non-ASCII unquoted name", "(名|称, x)", "(名称".length],
  ])("%s", (_name, marked, expected) => {
    const to = marked.indexOf("|");
    const text = marked.slice(0, to) + marked.slice(to + 1);
    const from = marked.startsWith("(|") ? to : 1;
    expect(insertColumnIdentifierEnd(text, from, to)).toBe(expected);
  });
});

describe("INSERT batch acceptance through the completion pipeline and a CodeMirror snippet", () => {
  type Engine = "postgres" | "mysql";
  const metadata: Record<Engine, Map<string, SqlCompletionColumn[]>> = {
    postgres: new Map([
      ["public.organization_user", ["organization_id", "user_id", "role"].map((name) => ({ name, table: "organization_user", schema: "public" }))],
      ["public.Order Details", ["User Name", "qty"].map((name) => ({ name, table: "Order Details", schema: "public" }))],
    ]),
    mysql: new Map([
      ["organization_user", ["organization_id", "user_id", "role"].map((name) => ({ name, table: "organization_user" }))],
      ["shop.order details", ["user name", "qty"].map((name) => ({ name, table: "order details", schema: "shop" }))],
    ]),
  };

  /**
   * Accepts the batch action the way QueryEditor does: `from` and the candidates
   * come from the real completion context of a live editor state, and the
   * replacement is applied through CodeMirror's snippet completion.
   */
  function acceptBatch(marked: string, engine: Engine, picks: string[]): string {
    const to = marked.indexOf("|");
    const sql = marked.slice(0, to) + marked.slice(to + 1);
    let state = EditorState.create({ doc: sql, extensions: [langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, engine, engine) })] });
    ensureSyntaxTree(state, sql.length, 5_000);
    const options = { databaseType: engine, dialect: engine, editorState: state } as const;
    const context = sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, to, options), getSqlCompletionContext(sql, to, options));
    const items = buildSqlCompletionItemsFromContext(context, { tables: [], objects: [], columnsByTable: metadata[engine], schemas: [], dialect: engine, databaseType: engine });
    const replacement = prepareSqlCompletionReplacement(sql, to, context, items);
    const candidates = replacement.items.filter((item) => item.type === "column" && item.batchSelectionMode === "insert");
    const columns = batchColumnSelectionColumnList(
      picks.map((label) => {
        const candidate = candidates.find((item) => item.label === label);
        expect(candidate, `${label} offered`).toBeDefined();
        return candidate!.apply!;
      }),
      "insert",
    );
    const { replaceTo, insert } = batchColumnSelectionInsertReplacement({ document: sql, from: replacement.from, to, columns, valuesKeyword: "VALUES", valueCount: picks.length });
    const completion = snippetCompletion(insert, { label: "batch" });
    const editor = {
      get state() {
        return state;
      },
      dispatch: (transaction: Transaction) => {
        state = transaction.state;
      },
    };
    (completion.apply as (editor: unknown, completion: unknown, from: number, to: number) => void)(editor, completion, replacement.from, replaceTo);
    return state.doc.toString();
  }

  it.each<[string, Engine, string, string[], string]>([
    ["empty list keeps VALUES", "postgres", "INSERT INTO organization_user (|) VALUES (1, 2)", ["organization_id", "user_id"], "INSERT INTO organization_user (organization_id, user_id) VALUES (1, 2)"],
    ["after a comma", "postgres", "INSERT INTO organization_user (organization_id,|) VALUES (1, 2)", ["user_id"], "INSERT INTO organization_user (organization_id,user_id) VALUES (1, 2)"],
    ["before an existing column", "postgres", "INSERT INTO organization_user (|role) VALUES (1)", ["organization_id"], "INSERT INTO organization_user (organization_id, role) VALUES (1)"],
    ["earlier position before a comma", "postgres", "INSERT INTO organization_user (|, user_id) VALUES (1, 2)", ["organization_id"], "INSERT INTO organization_user (organization_id, user_id) VALUES (1, 2)"],
    ["inside an unquoted identifier", "postgres", "INSERT INTO organization_user (organi|zation_id, user_id) VALUES (1, 2)", ["organization_id"], "INSERT INTO organization_user (organization_id, user_id) VALUES (1, 2)"],
    ["at the end of an identifier", "postgres", "INSERT INTO organization_user (organization_id, us|) VALUES (1, 2)", ["user_id"], "INSERT INTO organization_user (organization_id, user_id) VALUES (1, 2)"],
    ["unfinished list at the end", "postgres", "INSERT INTO organization_user (|", ["organization_id", "user_id"], "INSERT INTO organization_user (organization_id, user_id) VALUES (value, value)"],
    ["unclosed list before VALUES", "postgres", "INSERT INTO organization_user (|\nVALUES (1, 2)", ["organization_id", "user_id"], "INSERT INTO organization_user (organization_id, user_id)\nVALUES (1, 2)"],
    ["PG closing quote after the cursor", "postgres", 'INSERT INTO "public"."Order Details" ("Us|") VALUES (1)', ["User Name"], 'INSERT INTO "public"."Order Details" ("User Name") VALUES (1)'],
    ["PG cursor inside a quoted identifier", "postgres", 'INSERT INTO "public"."Order Details" ("Us|er Name", qty) VALUES (1, 2)', ["User Name"], 'INSERT INTO "public"."Order Details" ("User Name", qty) VALUES (1, 2)'],
    ["MySQL closing backtick after the cursor", "mysql", "INSERT INTO `shop`.`order details` (qty, `us|`) VALUES (1, 2)", ["user name"], "INSERT INTO `shop`.`order details` (qty, `user name`) VALUES (1, 2)"],
    ["MySQL cursor inside a backtick identifier", "mysql", "INSERT INTO `shop`.`order details` (`us|er name`, qty) VALUES (1, 2)", ["user name"], "INSERT INTO `shop`.`order details` (`user name`, qty) VALUES (1, 2)"],
    ["closed list followed by SELECT", "postgres", "INSERT INTO organization_user (|) SELECT id, email FROM users", ["organization_id", "user_id"], "INSERT INTO organization_user (organization_id, user_id) SELECT id, email FROM users"],
    ["closed list followed by WITH", "postgres", "INSERT INTO organization_user (|)\nWITH s AS (SELECT 1 AS id) SELECT id FROM s", ["organization_id"], "INSERT INTO organization_user (organization_id)\nWITH s AS (SELECT 1 AS id) SELECT id FROM s"],
    ["closed list followed by DEFAULT VALUES", "postgres", "INSERT INTO organization_user (|) DEFAULT VALUES", ["organization_id"], "INSERT INTO organization_user (organization_id) DEFAULT VALUES"],
    ["MySQL singular VALUE", "mysql", "INSERT INTO organization_user (|) VALUE (1, 2)", ["organization_id", "user_id"], "INSERT INTO organization_user (organization_id, user_id) VALUE (1, 2)"],
    ["comment before the closing parenthesis", "postgres", "INSERT INTO organization_user (| /* pick */) VALUES (1)", ["organization_id"], "INSERT INTO organization_user (organization_id /* pick */) VALUES (1)"],
    ["comment between the list and its source", "postgres", "INSERT INTO organization_user (|) /* rows */ SELECT 1", ["organization_id"], "INSERT INTO organization_user (organization_id) /* rows */ SELECT 1"],
    ["line comment between the list and VALUES", "mysql", "INSERT INTO organization_user (|) -- rows\nVALUES (1)", ["organization_id"], "INSERT INTO organization_user (organization_id) -- rows\nVALUES (1)"],
    ["closed list at the end of its statement", "postgres", "INSERT INTO organization_user (|);\nSELECT 2", ["role"], "INSERT INTO organization_user (role) VALUES (value);\nSELECT 2"],
    ["following statement untouched", "postgres", "INSERT INTO organization_user (|) VALUES (1);\nSELECT (2)", ["role"], "INSERT INTO organization_user (role) VALUES (1);\nSELECT (2)"],
    ["unclosed list before a separate UPDATE", "postgres", "INSERT INTO organization_user (|\nUPDATE users SET email = 'x'", ["role"], "INSERT INTO organization_user (role) VALUES (value)\nUPDATE users SET email = 'x'"],
    ["unclosed list before a separate INSERT", "postgres", "INSERT INTO organization_user (|\nINSERT INTO users (id) VALUES (1);", ["role"], "INSERT INTO organization_user (role) VALUES (value)\nINSERT INTO users (id) VALUES (1);"],
    ["unclosed list before a separate SELECT is not its source", "postgres", "INSERT INTO organization_user (|\nSELECT * FROM users", ["role"], "INSERT INTO organization_user (role) VALUES (value)\nSELECT * FROM users"],
  ])("%s", (_name, engine, marked, picks, expected) => {
    expect(acceptBatch(marked, engine, picks)).toBe(expected);
  });

  // The tail scan inspects at most 8 KB. Past that bound the suffix is kept untouched and no
  // `)` or VALUES clause is invented from text that was not inspected.
  describe("scan bound", () => {
    const PICKS = ["organization_id", "user_id"];
    const HEAD = "INSERT INTO organization_user (";
    const PICKED = "organization_id, user_id";
    const gap = (length: number, filler = " ") => filler.repeat(length);

    it.each<[string, string, string]>([
      ["whitespace gap before a closing parenthesis, source beyond the bound", `${HEAD}|)${gap(9000)}VALUES (1, 2)`, `${HEAD}${PICKED})${gap(9000)}VALUES (1, 2)`],
      ["whitespace gap in an unclosed list, VALUES beyond the bound", `${HEAD}|${gap(9000)}VALUES (1, 2)`, `${HEAD}${PICKED}${gap(9000)}VALUES (1, 2)`],
      ["line comment longer than the bound after the list", `${HEAD}|) -- ${gap(9000, "c")}\nVALUES (1, 2)`, `${HEAD}${PICKED}) -- ${gap(9000, "c")}\nVALUES (1, 2)`],
      ["block comment longer than the bound in an unclosed list", `${HEAD}|/* ${gap(9000, "c")} */ role) VALUES (1, 2, 'x')`, `${HEAD}${PICKED}/* ${gap(9000, "c")} */ role) VALUES (1, 2, 'x')`],
      ["block comment longer than the bound after the closed list", `${HEAD}|) /* ${gap(9000, "c")} */ VALUES (1, 2)`, `${HEAD}${PICKED}) /* ${gap(9000, "c")} */ VALUES (1, 2)`],
      ["unterminated block comment", `${HEAD}|) /* ${gap(9000, "c")}`, `${HEAD}${PICKED}) /* ${gap(9000, "c")}`],
      ["quoted text longer than the bound", `${HEAD}|"${gap(9000, "q")}", role) VALUES (1, 2, 3)`, `${HEAD}${PICKED}, "${gap(9000, "q")}", role) VALUES (1, 2, 3)`],
      ["existing word longer than the bound", `${HEAD}| ${gap(20000, "a")}) VALUES (1, 2)`, `${HEAD}${PICKED},  ${gap(20000, "a")}) VALUES (1, 2)`],
    ])("%s", (_name, marked, expected) => {
      expect(acceptBatch(marked, "postgres", PICKS)).toBe(expected);
    });

    it("still classifies a tail that fits inside the bound", () => {
      expect(acceptBatch(`${HEAD}|${gap(2000)}VALUES (1, 2)`, "postgres", PICKS)).toBe(`${HEAD}${PICKED})${gap(2000)}VALUES (1, 2)`);
    });
  });
});

describe("insertColumnIdentifierEnd scan bound", () => {
  const end = (marked: string) => {
    const to = marked.indexOf("|");
    const text = marked.slice(0, to) + marked.slice(to + 1);
    return { text, to, end: insertColumnIdentifierEnd(text, marked.startsWith("(|") ? to : 1, to) };
  };

  it("does not half-delete an overlong incomplete quoted identifier", () => {
    const { to, end: result } = end(`("Us|${"x".repeat(1000)}", qty) VALUES (1)`);
    expect(result).toBe(to);
  });

  it("does not half-delete an overlong unquoted identifier", () => {
    const { to, end: result } = end(`(organiz|${"a".repeat(1000)}, qty)`);
    expect(result).toBe(to);
  });

  it("reaches a closing quote within the small current-line bound", () => {
    const { end: result } = end(`("Us|${"x".repeat(50)}", qty)`);
    expect(result).toBe(`("Us${"x".repeat(50)}"`.length);
  });
});

describe("isBatchColumnSelectionCompletionActive", () => {
  it("only accepts a currently active completion popup", () => {
    expect(isBatchColumnSelectionCompletionActive("active")).toBe(true);
    expect(isBatchColumnSelectionCompletionActive("pending")).toBe(false);
    expect(isBatchColumnSelectionCompletionActive(null)).toBe(false);
  });
});

describe("shouldResolveSqlColumnCompletion", () => {
  it("loads fields after SELECT space when a FROM table is already known", () => {
    expect(shouldResolveSqlColumnCompletion({ suggestColumns: true, hasReferencedTables: true, prefix: "", typedActivation: false, selectListColumnContext: true })).toBe(true);
  });

  it("keeps empty non-SELECT column contexts from fetching metadata", () => {
    expect(shouldResolveSqlColumnCompletion({ suggestColumns: true, hasReferencedTables: true, prefix: "", typedActivation: false, selectListColumnContext: false })).toBe(false);
  });
});
